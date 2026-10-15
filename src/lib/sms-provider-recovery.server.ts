// Recovery after an SMS provider ACCOUNT outage (incident 15/10/2026: Short
// Brasil answered 101 "Erro de Autenticação" for a route without balance and
// every journey item burnt its attempts and ended `failed`).
//
// requeueProviderAccountFailures() puts those enrollments back on the SAME
// step (status waiting, next_run_at now, attempts 0) when it is still right to
// send: journey active, the failed step is an enabled SMS step that was never
// accepted, the lead did not deposit since entering (plus the journey's own
// exit rules), SMS consent not revoked, and no newer live enrollment of the
// same player in the same journey. Dry-run by default.
// SQL equivalent (for review): docs/RUNBOOK_OBSERVABILIDADE.md, "Provedor SMS sem saldo".

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeConsentSubject } from "./consent.server";

/** exit_reason texts written for account-level refusals (summarizeProviderError). */
export const PROVIDER_ACCOUNT_EXIT_REASONS = [
  "Short Brasil: erro de autenticacao",
  "Short Brasil: saldo insuficiente",
  "Provedor SMS recusou as credenciais",
] as const;

export function isProviderAccountExitReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return PROVIDER_ACCOUNT_EXIT_REASONS.some((prefix) => reason.startsWith(prefix));
}

export type RecoveryCandidate = {
  enrollment: {
    id: string;
    tenant_id: string;
    journey_id: string;
    player_id: string | null;
    status: string;
    current_position: number;
    loop_iteration: number;
    entered_at: string;
    exit_reason: string | null;
    updated_at: string;
  };
  journey: { status: string; exit_rules: Record<string, unknown> | null } | null;
  step: { step_type: string; is_enabled: boolean } | null;
  player: {
    telefone: string | null;
    ultimo_deposito: string | null;
    ftd_em: string | null;
    ultimo_login: string | null;
    ultimo_jogo: string | null;
  } | null;
  consentRevoked: boolean;
  hasLiveSibling: boolean;
  stepAlreadySent: boolean;
};

export type RecoverySkipReason =
  | "not_failed"
  | "not_provider_account"
  | "before_since"
  | "journey_inactive"
  | "step_not_sms"
  | "no_player"
  | "deposited"
  | "exit_rule"
  | "consent_revoked"
  | "reentered"
  | "already_sent";

/** Pure decision for one failed enrollment: null = requeue it. */
export function recoverySkipReason(
  c: RecoveryCandidate,
  sinceIso: string,
): RecoverySkipReason | null {
  const e = c.enrollment;
  if (e.status !== "failed") return "not_failed";
  if (!isProviderAccountExitReason(e.exit_reason)) return "not_provider_account";
  if (Date.parse(e.updated_at) < Date.parse(sinceIso)) return "before_since";
  if (!c.journey || c.journey.status !== "active") return "journey_inactive";
  if (!c.step || !c.step.is_enabled || c.step.step_type !== "sms") return "step_not_sms";
  if (!e.player_id || !c.player) return "no_player";
  const entered = Date.parse(e.entered_at);
  const after = (value: string | null) => Boolean(value) && Date.parse(String(value)) > entered;
  // Always: a lead that deposited since entering does not get the message.
  if (after(c.player.ultimo_deposito) || after(c.player.ftd_em)) return "deposited";
  const rules = (c.journey.exit_rules ?? {}) as Record<string, unknown>;
  if (rules.login === true && (after(c.player.ultimo_login) || after(c.player.ultimo_jogo)))
    return "exit_rule";
  if (rules.voltou_jogar === true && after(c.player.ultimo_jogo)) return "exit_rule";
  if (c.consentRevoked) return "consent_revoked";
  if (c.hasLiveSibling) return "reentered";
  if (c.stepAlreadySent) return "already_sent";
  return null;
}

export type RecoveryReport = {
  dryRun: boolean;
  since: string;
  candidates: number;
  requeued: number;
  skipped: Partial<Record<RecoverySkipReason, number>>;
  byJourney: Array<{ tenantId: string; journeyId: string; eligible: number }>;
};

// The generated client types do not know every column used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;
const CHUNK = 200;

async function inChunks<T>(ids: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await load(ids.slice(i, i + CHUNK))));
  return out;
}

function must<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

/**
 * Requeues journey enrollments that FAILED because the SMS provider refused
 * the account since `since`. `dryRun` (default) only reports.
 */
export async function requeueProviderAccountFailures(args: {
  since: string;
  tenantId?: string | null;
  dryRun?: boolean;
  limit?: number;
}): Promise<RecoveryReport> {
  const dryRun = args.dryRun !== false;
  const since = new Date(args.since).toISOString();
  const limit = Math.max(1, Math.min(args.limit ?? 5000, 20000));

  let query = db
    .from("journey_enrollments")
    .select(
      "id,tenant_id,journey_id,player_id,status,current_position,loop_iteration,entered_at,exit_reason,updated_at,metadata",
    )
    .eq("status", "failed")
    .gte("updated_at", since)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (args.tenantId) query = query.eq("tenant_id", args.tenantId);
  const failed = must<RecoveryCandidate["enrollment"] & { metadata: unknown }>(await query).filter(
    (row) => isProviderAccountExitReason(row.exit_reason),
  );

  const journeyIds = [...new Set(failed.map((e) => e.journey_id))];
  const playerIds = [...new Set(failed.map((e) => e.player_id).filter((v): v is string => !!v))];
  const enrollmentIds = failed.map((e) => e.id);

  const journeys = await inChunks(journeyIds, async (part) =>
    must<{ id: string; status: string; exit_rules: Record<string, unknown> | null }>(
      await db.from("journeys").select("id,status,exit_rules").in("id", part),
    ),
  );
  const steps = await inChunks(journeyIds, async (part) =>
    must<{ journey_id: string; position: number; step_type: string; is_enabled: boolean }>(
      await db.from("journey_steps").select("journey_id,position,step_type,is_enabled").in("journey_id", part),
    ),
  );
  const players = await inChunks(playerIds, async (part) =>
    must<{
      id: string;
      telefone: string | null;
      ultimo_deposito: string | null;
      ftd_em: string | null;
      ultimo_login: string | null;
      ultimo_jogo: string | null;
    }>(
      await db
        .from("players")
        .select("id,telefone,ultimo_deposito,ftd_em,ultimo_login,ultimo_jogo")
        .in("id", part),
    ),
  );
  const siblings = await inChunks(playerIds, async (part) =>
    must<{ id: string; journey_id: string; player_id: string }>(
      await db
        .from("journey_enrollments")
        .select("id,journey_id,player_id")
        .in("player_id", part)
        .in("status", ["active", "waiting", "paused", "paused_by_priority"]),
    ),
  );
  const sentExecutions = await inChunks(enrollmentIds, async (part) =>
    must<{ enrollment_id: string; step_position: number; loop_iteration: number }>(
      await db
        .from("journey_step_executions")
        .select("enrollment_id,step_position,loop_iteration")
        .in("enrollment_id", part)
        .in("status", ["sent", "delivered"]),
    ),
  );

  const journeyById = new Map(journeys.map((j) => [j.id, j]));
  const stepByKey = new Map(steps.map((s) => [`${s.journey_id}:${s.position}`, s]));
  const playerById = new Map(players.map((p) => [p.id, p]));
  const liveKeys = new Set(siblings.map((s) => `${s.journey_id}:${s.player_id}`));
  const sentKeys = new Set(
    sentExecutions.map((x) => `${x.enrollment_id}:${x.step_position}:${x.loop_iteration}`),
  );

  // Revoked SMS consent per tenant (subject = normalized phone).
  const revoked = new Set<string>();
  const subjectsByTenant = new Map<string, Set<string>>();
  for (const e of failed) {
    const phone = e.player_id ? playerById.get(e.player_id)?.telefone : null;
    if (!phone) continue;
    const subjects = subjectsByTenant.get(e.tenant_id) ?? new Set<string>();
    subjects.add(normalizeConsentSubject("sms", phone));
    subjectsByTenant.set(e.tenant_id, subjects);
  }
  for (const [tenantId, subjects] of subjectsByTenant) {
    const rows = await inChunks([...subjects], async (part) =>
      must<{ subject: string }>(
        await db
          .from("channel_consents")
          .select("subject")
          .eq("tenant_id", tenantId)
          .eq("channel", "sms")
          .eq("status", "revoked")
          .in("subject", part),
      ),
    );
    for (const row of rows) revoked.add(`${tenantId}:${row.subject}`);
  }

  const report: RecoveryReport = {
    dryRun,
    since,
    candidates: failed.length,
    requeued: 0,
    skipped: {},
    byJourney: [],
  };
  const perJourney = new Map<string, { tenantId: string; journeyId: string; eligible: number }>();
  const eligible: typeof failed = [];
  for (const e of failed) {
    const player = e.player_id ? (playerById.get(e.player_id) ?? null) : null;
    const reason = recoverySkipReason(
      {
        enrollment: e,
        journey: journeyById.get(e.journey_id) ?? null,
        step: stepByKey.get(`${e.journey_id}:${e.current_position}`) ?? null,
        player,
        consentRevoked: player?.telefone
          ? revoked.has(`${e.tenant_id}:${normalizeConsentSubject("sms", player.telefone)}`)
          : false,
        hasLiveSibling: e.player_id ? liveKeys.has(`${e.journey_id}:${e.player_id}`) : false,
        stepAlreadySent: sentKeys.has(`${e.id}:${e.current_position}:${e.loop_iteration ?? 0}`),
      },
      since,
    );
    if (reason) {
      report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
      continue;
    }
    eligible.push(e);
    const key = `${e.tenant_id}:${e.journey_id}`;
    const entry = perJourney.get(key) ?? { tenantId: e.tenant_id, journeyId: e.journey_id, eligible: 0 };
    entry.eligible++;
    perJourney.set(key, entry);
  }
  report.byJourney = [...perJourney.values()].sort((a, b) => b.eligible - a.eligible);
  if (dryRun) return report;

  const now = new Date().toISOString();
  for (const e of eligible) {
    const metadata = {
      ...((e.metadata ?? {}) as Record<string, unknown>),
      provider_outage_requeue: { at: now, previous_exit_reason: e.exit_reason, since },
    };
    // Fenced on status: an enrollment that changed meanwhile is left alone.
    const { data, error } = await db
      .from("journey_enrollments")
      .update({
        status: "waiting",
        next_run_at: now,
        attempts: 0,
        exit_reason: null,
        claimed_at: null,
        claimed_by: null,
        lease_expires_at: null,
        metadata,
      })
      .eq("id", e.id)
      .eq("status", "failed")
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) continue;
    report.requeued++;
    await db.from("journey_events").insert({
      tenant_id: e.tenant_id,
      journey_id: e.journey_id,
      enrollment_id: e.id,
      event_type: "provider_outage_requeued",
      detail: { reason: "provider_account_outage", previous_exit_reason: e.exit_reason, since },
    });
  }
  return report;
}
