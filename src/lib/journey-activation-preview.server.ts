/**
 * Activation preview (P1.2, docs/ESCOPO_AUDITORIA_JORNADAS_CUSTO_RECUPERACAO_2026-10-29.md):
 * how many players would enter if the house includes the current base, and
 * what the SMS steps cost per player.
 *
 * The count used to come from the SQL `journey_activation_estimate`, which
 * ignored the entry max age (P0.3) and the entry filters (P1.1), so the dialog
 * showed the whole sign-up base for "Cadastrou e não depositou". It now runs
 * the scanner's own matcher (`matchJourneyScanPlayer`): same audience, filters,
 * start_after and max age the real entry applies.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import {
  JOURNEY_SELECT_COLUMNS,
  PLAYER_MATCH_COLUMNS,
  matchJourneyScanPlayer,
  type Journey,
  type Player,
} from "./journey-scanner.server";
import {
  activationTriggerConfig,
  eventMaxAgeHours,
  pixExpiryHours,
  smsVariants,
} from "./journey-policy";
import { countSmsSegments } from "./sms-segments";

const db = supabaseAdmin as any;

const PAGE = 1000;
const ID_CHUNK = 100;
const OPEN_STATUSES = ["active", "waiting", "paused_by_priority"];

/** Triggers whose players only enter at the moment of the event: no base to include. */
const UNSUPPORTED = new Set(["nivel_alterado", "manual"]);

type StepRow = { step_type: string; config: Record<string, unknown> | null };

export type ActivationPreview = {
  supported: boolean;
  /** Players that would enter now with "Incluir a base atual". */
  eligible: number | null;
  /** SMS steps in one pass of the journey and their segments. */
  smsSteps: number;
  segmentsPerPass: number;
  firstSmsSegments: number;
};

/** Players that enter: match the journey, are not already in it, have a phone when needed. */
export function countEligible(args: {
  journey: Journey;
  players: Player[];
  occurrences: Map<string, string>;
  openPlayerIds: Set<string>;
  needsPhone: boolean;
}): number {
  let eligible = 0;
  for (const player of args.players) {
    if (args.openPlayerIds.has(player.id)) continue;
    if (args.needsPhone && !String(player.telefone ?? "").replace(/\D/g, "")) continue;
    if (matchJourneyScanPlayer(args.journey, player, args.occurrences).matches) eligible += 1;
  }
  return eligible;
}

/** SMS steps of one pass and their segments (longest variant of each step). */
export function smsPassSegments(steps: StepRow[]) {
  const perStep = steps
    .filter((step) => step.step_type === "sms")
    .map((step) =>
      Math.max(1, ...smsVariants(step.config ?? {}).map((text) => countSmsSegments(text).segments)),
    );
  return {
    smsSteps: perStep.length,
    segmentsPerPass: perStep.reduce((sum, segments) => sum + segments, 0),
    firstSmsSegments: perStep[0] ?? 0,
  };
}

async function openPlayerIds(journeyId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("journey_enrollments")
      .select("player_id")
      .eq("journey_id", journeyId)
      .in("status", OPEN_STATUSES)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) if (row.player_id) ids.add(String(row.player_id));
    if ((data ?? []).length < PAGE) return ids;
  }
}

/** PIX / saque: the recent events first (a small set), then only their players. */
async function financialCandidates(journey: Journey) {
  const pix = journey.trigger_type === "pix_gerado_nao_pago";
  const hours = pix
    ? pixExpiryHours(journey.trigger_config)
    : eventMaxAgeHours(journey.trigger_type, journey.trigger_config);
  const startAfter = Date.parse(String(journey.trigger_config.start_after ?? ""));
  const since = Math.max(
    Number.isFinite(startAfter) ? startAfter : 0,
    hours == null ? 0 : Date.now() - hours * 3600_000,
  );
  const occurrences = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    let query = db
      .from(pix ? "deposits" : "withdrawals")
      .select("id,player_id,created_at")
      .eq("tenant_id", journey.tenant_id)
      .gte("created_at", new Date(since).toISOString())
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    query = pix
      ? query.eq("status", "pendente").ilike("metodo", "%pix%")
      : query.eq("status", "aprovado");
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (row.player_id && !occurrences.has(row.player_id))
        occurrences.set(String(row.player_id), String(row.id));
    }
    if ((data ?? []).length < PAGE) break;
  }
  const players: Player[] = [];
  const ids = [...occurrences.keys()];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const { data, error } = await db
      .from("players")
      .select(`${PLAYER_MATCH_COLUMNS},telefone`)
      .eq("tenant_id", journey.tenant_id)
      .in("id", ids.slice(offset, offset + ID_CHUNK));
    if (error) throw new Error(error.message);
    players.push(...((data ?? []) as Player[]));
  }
  return { players, occurrences };
}

async function tenantPlayers(tenantId: string): Promise<Player[]> {
  const players: Player[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("players")
      .select(`${PLAYER_MATCH_COLUMNS},telefone`)
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    players.push(...((data ?? []) as Player[]));
    if ((data ?? []).length < PAGE) return players;
  }
}

export async function previewJourneyActivation(
  journeyId: string,
  tenantId: string,
): Promise<ActivationPreview | null> {
  const { data: row, error } = await db
    .from("journeys")
    .select(JOURNEY_SELECT_COLUMNS)
    .eq("id", journeyId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const { data: steps, error: stepsError } = await db
    .from("journey_steps")
    .select("step_type,config")
    .eq("journey_id", journeyId)
    .eq("is_enabled", true)
    .order("position");
  if (stepsError) throw new Error(stepsError.message);
  const stepRows = (steps ?? []) as StepRow[];
  const pass = smsPassSegments(stepRows);

  const stored = row as Journey;
  if (UNSUPPORTED.has(stored.trigger_type)) return { supported: false, eligible: null, ...pass };
  // What "Incluir a base atual" would publish (start_after, filters, max age).
  const journey: Journey = {
    ...stored,
    trigger_config: activationTriggerConfig(
      stored.trigger_type,
      stored.trigger_config,
      "include_base",
    ),
    entry_rules: stored.entry_rules ?? {},
  };
  const financial = ["pix_gerado_nao_pago", "saque_pago"].includes(journey.trigger_type);
  const { players, occurrences } = financial
    ? await financialCandidates(journey)
    : { players: await tenantPlayers(tenantId), occurrences: new Map<string, string>() };
  const eligible = countEligible({
    journey,
    players,
    occurrences,
    openPlayerIds: await openPlayerIds(journeyId),
    needsPhone: stepRows.some((step) => step.step_type === "sms" || step.step_type === "voice"),
  });
  return { supported: true, eligible, ...pass };
}
