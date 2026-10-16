import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startJobRun, type JobRunHandle } from "./observability/job-monitor.server";
import { captureServerException } from "./observability/sentry.server";
import {
  audienceMatches,
  inactivityBandConfig,
  journeyEntryKey,
  pixExpiryHours,
  qualifiesForInactivity,
  triggerOccurrence,
} from "./journey-policy";
import { resolveJourneyWorkerScope } from "./journey-worker-scope";
import { detectTriggersForPlayer } from "./triggers.server";

// The migration is deployed together with this worker, before generated types refresh.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

type ScanJob = {
  id: string;
  tenant_id: string;
  journey_id: string;
  journey_version: number;
  cursor_player_id: string | null;
  lease_owner: string;
};

export type Journey = {
  id: string;
  tenant_id: string;
  version: number;
  status: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  entry_rules: Record<string, unknown>;
  exit_rules?: Record<string, unknown> | null;
  cooldown_hours: number;
};

export type Player = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  status: string | null;
  vip: boolean | null;
  ftd_em: string | null;
  created_at: string;
  total_depositado: number | null;
};

type ScanBatchResult = {
  scanned: number;
  eligible: number;
  enrolled: number;
  duplicates: number;
  lateEntries: number;
  complete: boolean;
};

export const JOURNEY_SELECT_COLUMNS =
  "id,tenant_id,version,status,trigger_type,trigger_config,entry_rules,exit_rules,cooldown_hours";

/**
 * Every player column read by the matchers (audience, detectTriggersForPlayer /
 * detectAlerts, qualifiesForInactivity, triggerOccurrence) and by the entry
 * metadata. The derived metrics some alerts read (dep_30d, qtd_logins_30d,
 * dias_seguidos_depositando, reativado_em, horario_pico) are not columns of
 * `players`, so `select *` never returned them either: matching is unchanged.
 */
export const PLAYER_MATCH_COLUMNS = [
  "id",
  "tenant_id",
  "status",
  "vip",
  "ftd_em",
  "created_at",
  "updated_at",
  "total_depositado",
  "total_sacado",
  "saldo_carteira",
  "ultimo_login",
  "ultimo_jogo",
  "ultimo_deposito",
  "last_cashback_paid_at",
].join(",");

function optionalStartAt(journey: Pick<Journey, "trigger_config">) {
  const value = String(journey.trigger_config?.start_after ?? "");
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const FINANCIAL_LOOKUP_CHUNK = 100;

async function financialOccurrences(journey: Journey, players: Player[]) {
  const occurrences = new Map<string, string>();
  if (!["pix_gerado_nao_pago", "saque_pago"].includes(journey.trigger_type)) return occurrences;
  const playerIds = players.map((player) => player.id);
  if (!playerIds.length) return occurrences;
  const table = journey.trigger_type === "saque_pago" ? "withdrawals" : "deposits";
  const startAt = optionalStartAt(journey);
  // A 500-id `in` filter travels in the GET URL and broke every pix/saque scan
  // with "fetch failed"; keep each request small.
  for (let offset = 0; offset < playerIds.length; offset += FINANCIAL_LOOKUP_CHUNK) {
    let query = db
      .from(table)
      .select("id,player_id,created_at")
      .eq("tenant_id", journey.tenant_id)
      .in("player_id", playerIds.slice(offset, offset + FINANCIAL_LOOKUP_CHUNK))
      .order("created_at", { ascending: false });
    query =
      journey.trigger_type === "saque_pago"
        ? query.eq("status", "aprovado")
        : query.eq("status", "pendente").ilike("metodo", "%pix%");
    if (startAt != null) query = query.gte("created_at", new Date(startAt).toISOString());
    // D-6: a pending PIX older than the expiry no longer drives the journey.
    const expiryHours =
      journey.trigger_type === "pix_gerado_nao_pago"
        ? pixExpiryHours(journey.trigger_config)
        : null;
    if (expiryHours != null)
      query = query.gte("created_at", new Date(Date.now() - expiryHours * 3600_000).toISOString());
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (!occurrences.has(row.player_id)) occurrences.set(row.player_id, String(row.id));
    }
  }
  return occurrences;
}

export function matchJourneyScanPlayer(
  journey: Journey,
  player: Player,
  occurrences: Map<string, string>,
) {
  if (!audienceMatches(journey, player)) return { matches: false, occurrence: "" };
  const startAt = optionalStartAt(journey);
  if (journey.trigger_type === "cadastrados_sem_deposito") {
    const occurredAt = Date.parse(player.created_at);
    return {
      matches: !player.ftd_em && (startAt == null || occurredAt >= startAt),
      occurrence: player.created_at,
    };
  }
  if (journey.trigger_type === "primeiro_deposito") {
    const occurredAt = Date.parse(String(player.ftd_em ?? ""));
    return {
      matches:
        Number.isFinite(occurredAt) &&
        player.ftd_em != null &&
        (startAt == null || occurredAt >= startAt),
      occurrence: String(player.ftd_em ?? "missing_first_deposit"),
    };
  }
  if (journey.trigger_type === "pix_gerado_nao_pago" || journey.trigger_type === "saque_pago") {
    const occurrence = occurrences.get(player.id);
    return { matches: Boolean(occurrence), occurrence: occurrence ?? "none" };
  }
  if (journey.trigger_type === "inactivity") {
    return {
      matches: qualifiesForInactivity(
        player,
        inactivityBandConfig(journey.trigger_config, journey.exit_rules),
      ),
      occurrence: triggerOccurrence(journey.trigger_type, player, journey.trigger_config ?? {}),
    };
  }
  return {
    matches: detectTriggersForPlayer(player as never).includes(journey.trigger_type as never),
    occurrence: triggerOccurrence(journey.trigger_type, player, journey.trigger_config ?? {}),
  };
}

async function recentCooldownPlayers(journey: Journey, playerIds: string[]) {
  const blocked = new Set<string>();
  if (journey.entry_rules?.reentry !== "after_cooldown" || !playerIds.length) return blocked;
  const hours = Math.max(
    1,
    Number(journey.entry_rules.reentry_cooldown_hours ?? journey.cooldown_hours ?? 24),
  );
  const { data, error } = await db
    .from("journey_enrollments")
    .select("player_id")
    .eq("journey_id", journey.id)
    .in("player_id", playerIds)
    .gte("created_at", new Date(Date.now() - hours * 3600_000).toISOString());
  if (error) throw new Error(error.message);
  for (const row of data ?? []) if (row.player_id) blocked.add(String(row.player_id));
  return blocked;
}

// ------------------------------------------------------------------
// Shared enrollment (scanner, webhook events, threshold crossing)
// ------------------------------------------------------------------

export type EnrollmentSource = "async-v1" | "event-v1" | "crossing-v1";

export type EnrollPlayersResult = {
  eligible: number;
  enrolled: number;
  duplicates: number;
  /** Player ids whose enrollment row was inserted by this call. */
  enrolledPlayerIds: string[];
};

/**
 * Single enrollment routine shared by the full scanner, the webhook event path
 * and the threshold-crossing job: same matcher, start_after, audience, cooldown
 * and entry_key. The three paths are idempotent against each other through the
 * (journey_id, player_id, entry_key) unique key.
 */
export async function enrollPlayersInJourney(
  journey: Journey,
  players: Player[],
  options: {
    source: EnrollmentSource;
    extraMetadata?: (player: Player, occurrence: string) => Record<string, unknown> | null;
  },
): Promise<EnrollPlayersResult> {
  const empty: EnrollPlayersResult = {
    eligible: 0,
    enrolled: 0,
    duplicates: 0,
    enrolledPlayerIds: [],
  };
  if (!players.length) return empty;
  const occurrences = await financialOccurrences(journey, players);
  const matched = players
    .map((player) => ({ player, match: matchJourneyScanPlayer(journey, player, occurrences) }))
    .filter(({ match }) => match.matches);
  if (!matched.length) return empty;
  const cooldownBlocked = await recentCooldownPlayers(
    journey,
    matched.map(({ player }) => player.id),
  );
  const eligible = matched.filter(({ player }) => !cooldownBlocked.has(player.id));
  if (!eligible.length) return empty;
  const rows = eligible.map(({ player, match }) => ({
    tenant_id: journey.tenant_id,
    journey_id: journey.id,
    journey_version: journey.version,
    player_id: player.id,
    entry_key: journeyEntryKey(journey.trigger_type, journey.entry_rules ?? {}, match.occurrence),
    metadata: {
      trigger: journey.trigger_type,
      trigger_occurrence: match.occurrence,
      deposited_before_entry: Number(player.total_depositado ?? 0),
      scanner: options.source,
      ...(options.extraMetadata?.(player, match.occurrence) ?? {}),
    },
  }));
  const { data, error } = await db
    .from("journey_enrollments")
    .upsert(rows, { onConflict: "journey_id,player_id,entry_key", ignoreDuplicates: true })
    .select("id,player_id");
  if (error) throw new Error(error.message);
  const inserted = (data ?? []) as Array<{ id: string; player_id: string | null }>;
  return {
    eligible: eligible.length,
    enrolled: inserted.length,
    duplicates: Math.max(0, eligible.length - inserted.length),
    enrolledPlayerIds: inserted.map((row) => String(row.player_id ?? "")).filter(Boolean),
  };
}

// ------------------------------------------------------------------
// Threshold-crossing specs (time-based triggers, ENV-09 part 2)
// ------------------------------------------------------------------

export const ACTIVITY_FIELDS = ["ultimo_login", "ultimo_jogo", "ultimo_deposito"] as const;
export type ActivityField = (typeof ACTIVITY_FIELDS)[number];

export type CrossingSpec = {
  /** The trigger becomes true `hours` after greatest(fields). */
  fields: ActivityField[];
  hours: number;
};

const DAY = 24;
const ALL_ACTIVITY: ActivityField[] = [...ACTIVITY_FIELDS];

/**
 * Time-based triggers: no event happens when they become true. The primary
 * time field opens the candidate window; the full matcher still decides.
 */
const SEGMENT_CROSSING_SPECS: Record<string, CrossingSpec> = {
  // inInactivityWindow: ftd_em and days since greatest(login, jogo, deposito) >= min.
  sem_login_7_14: { fields: ALL_ACTIVITY, hours: 7 * DAY },
  sem_login_15_24: { fields: ALL_ACTIVITY, hours: 15 * DAY },
  sem_login_25_34: { fields: ALL_ACTIVITY, hours: 25 * DAY },
  sem_login_35_44: { fields: ALL_ACTIVITY, hours: 35 * DAY },
  sem_login_45_59: { fields: ALL_ACTIVITY, hours: 45 * DAY },
  sem_login_60_mais: { fields: ALL_ACTIVITY, hours: 60 * DAY },
  // abandono_vip: VIP and last activity > 7 days.
  recuperacao_vip: { fields: ALL_ACTIVITY, hours: 7 * DAY },
  // vip_sem_atividade: VIP, last activity <= 7 days and ultimo_jogo >= 2 days.
  vip_esfriando: { fields: ["ultimo_jogo"], hours: 2 * DAY },
  // saldo_parado: saldo >= 50 and ultimo_jogo > 2 days.
  dinheiro_parado: { fields: ["ultimo_jogo"], hours: 2 * DAY },
  // lead_quente_esfriando: last activity 3..7 days (also needs a derived metric).
  lead_quente_esfriando: { fields: ALL_ACTIVITY, hours: 3 * DAY },
  // login_sem_deposito: ultimo_deposito > 14 days (also needs a derived metric).
  engajado_sem_converter: { fields: ["ultimo_deposito"], hours: 14 * DAY },
};

export const CROSSING_TRIGGERS: readonly string[] = [
  "inactivity",
  ...Object.keys(SEGMENT_CROSSING_SPECS),
];

export function crossingSpecFor(
  journey: Pick<Journey, "trigger_type" | "trigger_config">,
): CrossingSpec | null {
  if (journey.trigger_type === "inactivity") {
    // Same defaults and validation as qualifiesForInactivity.
    const config = journey.trigger_config ?? {};
    const field = String(config.field ?? "ultimo_login");
    const hours = Number(config.hours ?? 0);
    if (!(ACTIVITY_FIELDS as readonly string[]).includes(field)) return null;
    if (!Number.isFinite(hours) || hours < 1) return null;
    return { fields: [field as ActivityField], hours };
  }
  return SEGMENT_CROSSING_SPECS[journey.trigger_type] ?? null;
}

/** Epoch ms at which the player crossed (or will cross) the journey threshold. */
export function crossingTimeFor(
  journey: Pick<Journey, "trigger_type" | "trigger_config">,
  player: Record<string, unknown>,
): number | null {
  const spec = crossingSpecFor(journey);
  if (!spec) return null;
  let latest = 0;
  for (const field of spec.fields) {
    const value = player[field];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest > 0 ? latest + spec.hours * 3600_000 : null;
}

// ------------------------------------------------------------------
// Event-driven entry (ENV-09)
// ------------------------------------------------------------------
// The periodic scan needs hours per cycle on large tenants, so a lead could
// qualify long before it entered a journey. Webhooks now enroll the player the
// moment the qualifying event is recorded, using exactly the scanner's rules
// (matcher, start_after, audience, cooldown, entry_key). The scan keeps running
// as a safety net; the shared entry_key makes both paths idempotent.

/** Journey triggers that can become true at the moment of each webhook event. */
const EVENT_ENTRY_TRIGGERS: Record<string, readonly string[]> = {
  cadastro: ["cadastrados_sem_deposito"],
  "deposito-pendente": ["pix_gerado_nao_pago"],
  "deposito-aprovado": ["primeiro_deposito", "quase_vip", "reativacao_em_curso", "alto_potencial"],
  "saque-aprovado": ["saque_pago"],
  "saque-concluido": ["saque_pago"],
  // last_cashback_paid_at is written before entry runs; the trigger means "paid today".
  "cashback-pago": ["cashback_pago"],
};

const EVENT_COVERED_TRIGGERS = new Set(Object.values(EVENT_ENTRY_TRIGGERS).flat());

/** Trigger whose entry moment is a webhook event (entered by enrollPlayerOnEvent). */
export function isEventTrigger(triggerType: string) {
  return EVENT_COVERED_TRIGGERS.has(triggerType);
}

export function eventEntryTriggers(evento: string): readonly string[] {
  return EVENT_ENTRY_TRIGGERS[evento] ?? [];
}

export function eventEntryEnabled(env: NodeJS.ProcessEnv = process.env) {
  // Same kill switch as the scanner, plus a dedicated off switch.
  return env.JOURNEYS_SCANNER_ENABLED === "true" && env.JOURNEYS_EVENT_ENTRY_ENABLED !== "false";
}

export function crossingEnabled(env: NodeJS.ProcessEnv = process.env) {
  // On by default whenever the scanner is on, plus a dedicated off switch.
  return env.JOURNEYS_SCANNER_ENABLED === "true" && env.JOURNEYS_CROSSING_ENABLED !== "false";
}

const DEFAULT_RESCAN_SECONDS = 300;

/** Full-scan rescan interval (safety net). Clamped like complete_journey_scan_job_batch. */
export function scannerRescanSeconds(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.JOURNEYS_SCANNER_RESCAN_SECONDS;
  const value = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_RESCAN_SECONDS;
  return Math.max(60, Math.min(Math.floor(value), 86400));
}

export function journeyInWorkerScope(
  journey: Pick<Journey, "id" | "tenant_id">,
  scope: ReturnType<typeof resolveJourneyWorkerScope>,
) {
  if (!scope.allowed) return false;
  if (scope.tenantIds.length && !scope.tenantIds.includes(journey.tenant_id)) return false;
  if (scope.journeyIds.length && !scope.journeyIds.includes(journey.id)) return false;
  return true;
}

// ------------------------------------------------------------------
// Late entries (safety-net accounting)
// ------------------------------------------------------------------
// With event entry and threshold crossing live, the full scanner should only
// find duplicates. A row it inserts for a trigger covered by a real-time path
// is a "late entry": an event or crossing entry that was missed. They are
// flagged in metadata (late_entry / late_entry_path) and counted per run.

/** A real-time path gets this long before a scanner insert counts as late. */
const LATE_ENTRY_GRACE_MS = 5 * 60_000;
/** Older event occurrences are history (backfill), not a missed real-time entry. */
const LATE_ENTRY_EVENT_LOOKBACK_MS = 24 * 3600_000;

export type LateEntryContext = {
  eventEntry: boolean;
  crossing: boolean;
  /** When the crossing job started covering this journey (state initialized_at). */
  crossingSince: number | null;
  now: number;
};

export function lateEntryPath(
  journey: Pick<Journey, "trigger_type" | "trigger_config">,
  player: Record<string, unknown>,
  occurrence: string,
  context: LateEntryContext,
): "event" | "crossing" | null {
  const cutoff = context.now - LATE_ENTRY_GRACE_MS;
  if (isEventTrigger(journey.trigger_type)) {
    if (!context.eventEntry) return null;
    const occurredAt = Date.parse(occurrence);
    // pix/saque occurrences are row ids; those journeys are bounded by start_after.
    if (!Number.isFinite(occurredAt)) return "event";
    return occurredAt <= cutoff && occurredAt >= context.now - LATE_ENTRY_EVENT_LOOKBACK_MS
      ? "event"
      : null;
  }
  if (!context.crossing || context.crossingSince == null) return null;
  const crossedAt = crossingTimeFor(journey, player);
  if (crossedAt == null) return null;
  return crossedAt > context.crossingSince && crossedAt <= cutoff ? "crossing" : null;
}

async function crossingCoverageSince(journeyId: string): Promise<number | null> {
  // Best effort: before the crossing migration is applied the table is missing.
  try {
    const { data, error } = await db
      .from("journey_crossing_states")
      .select("initialized_at")
      .eq("journey_id", journeyId)
      .maybeSingle();
    if (error || !data?.initialized_at) return null;
    const parsed = Date.parse(String(data.initialized_at));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Full scanner (safety net)
// ------------------------------------------------------------------

async function scanJob(job: ScanJob, batchSize: number): Promise<ScanBatchResult> {
  const { data: journeyRaw, error: journeyError } = await db
    .from("journeys")
    .select(JOURNEY_SELECT_COLUMNS)
    .eq("id", job.journey_id)
    .eq("tenant_id", job.tenant_id)
    .maybeSingle();
  if (journeyError) throw new Error(journeyError.message);
  const journey = journeyRaw as Journey | null;
  if (!journey || journey.status !== "active" || journey.version !== job.journey_version) {
    throw new Error("Jornada alterada ou inativa durante a varredura");
  }

  if (
    !job.cursor_player_id &&
    isEventTrigger(journey.trigger_type) &&
    optionalStartAt(journey) == null
  ) {
    // No behavior change: event journeys without start_after enroll the whole
    // history. Logged once per cycle so it is never a silent backfill.
    console.warn("[journey scanner] event-trigger journey without start_after (full backfill)", {
      journeyId: journey.id,
      tenantId: journey.tenant_id,
      trigger: journey.trigger_type,
    });
  }

  let playersQuery = db
    .from("players")
    .select(PLAYER_MATCH_COLUMNS)
    .eq("tenant_id", job.tenant_id)
    .order("id", { ascending: true })
    .limit(batchSize);
  if (job.cursor_player_id) playersQuery = playersQuery.gt("id", job.cursor_player_id);
  const { data: playerRows, error: playersError } = await playersQuery;
  if (playersError) throw new Error(playersError.message);
  const players = (playerRows ?? []) as Player[];

  const lateContext: LateEntryContext = {
    eventEntry: eventEntryEnabled(),
    crossing: crossingEnabled(),
    crossingSince: crossingSpecFor(journey) ? await crossingCoverageSince(journey.id) : null,
    now: Date.now(),
  };
  const latePlayers = new Set<string>();
  const { eligible, enrolled, duplicates, enrolledPlayerIds } = await enrollPlayersInJourney(
    journey,
    players,
    {
      source: "async-v1",
      extraMetadata: (player, occurrence) => {
        const path = lateEntryPath(journey, player, occurrence, lateContext);
        if (!path) return null;
        latePlayers.add(player.id);
        return { late_entry: true, late_entry_path: path };
      },
    },
  );
  const lateEntries = enrolledPlayerIds.filter((id) => latePlayers.has(id)).length;
  if (lateEntries > 0) {
    console.warn("[journey scanner] late entries: a real-time path missed these enrollments", {
      journeyId: journey.id,
      tenantId: journey.tenant_id,
      trigger: journey.trigger_type,
      lateEntries,
    });
  }

  const complete = players.length < batchSize;
  const cursor = players.at(-1)?.id ?? job.cursor_player_id;
  const { data: completed, error: completeError } = await db.rpc(
    "complete_journey_scan_job_batch",
    {
      p_job_id: job.id,
      p_worker_id: job.lease_owner,
      p_cursor_player_id: cursor,
      p_cycle_complete: complete,
      p_scanned: players.length,
      p_eligible: eligible,
      p_enrolled: enrolled,
      p_duplicates: duplicates,
      p_rescan_seconds: scannerRescanSeconds(),
    },
  );
  if (completeError) throw new Error(completeError.message);
  if (!completed) throw new Error("Lease da varredura expirou antes da confirmacao do cursor");
  return {
    scanned: players.length,
    eligible,
    enrolled,
    duplicates,
    lateEntries,
    complete,
  };
}

export type EventEntryResult = {
  skipped?: string;
  evaluated: number;
  enrolled: number;
  journeyIds: string[];
};

/**
 * Enrolls one player into every active journey whose trigger the event can
 * satisfy. Never throws: entry must not affect webhook processing.
 */
export async function enrollPlayerOnEvent(
  tenantId: string,
  playerId: string,
  evento: string,
): Promise<EventEntryResult> {
  const result: EventEntryResult = { evaluated: 0, enrolled: 0, journeyIds: [] };
  try {
    const triggers = eventEntryTriggers(evento);
    if (!triggers.length) return { ...result, skipped: "no_event_trigger" };
    if (!eventEntryEnabled()) return { ...result, skipped: "disabled" };
    const scope = resolveJourneyWorkerScope();
    if (!scope.allowed) return { ...result, skipped: "canary_scope_required" };

    const { data: journeyRows, error: journeysError } = await db
      .from("journeys")
      .select(JOURNEY_SELECT_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .in("trigger_type", [...triggers]);
    if (journeysError) throw new Error(journeysError.message);
    const journeys = ((journeyRows ?? []) as Journey[]).filter((journey) =>
      journeyInWorkerScope(journey, scope),
    );
    if (!journeys.length) return { ...result, skipped: "no_active_journey" };

    const { data: playerRow, error: playerError } = await db
      .from("players")
      .select(PLAYER_MATCH_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("id", playerId)
      .maybeSingle();
    if (playerError) throw new Error(playerError.message);
    if (!playerRow) return { ...result, skipped: "player_not_found" };
    const player = playerRow as Player;

    for (const journey of journeys) {
      result.evaluated++;
      const entry = await enrollPlayersInJourney(journey, [player], {
        source: "event-v1",
        extraMetadata: () => ({ source_event: evento }),
      });
      if (entry.enrolled) {
        result.enrolled += entry.enrolled;
        result.journeyIds.push(journey.id);
      }
    }
    return result;
  } catch (error) {
    console.error("[journey event entry] failed", {
      tenantId,
      evento,
      error: error instanceof Error ? error.message : String(error),
    });
    captureServerException(error, { job: "journey_event_entry", tenantId, tags: { evento } });
    return { ...result, skipped: "error" };
  }
}

export async function runJourneyScanner(options: { jobs?: number; batchSize?: number } = {}) {
  if (process.env.JOURNEYS_SCANNER_ENABLED !== "true") {
    return { disabled: true, jobs: 0, scanned: 0, eligible: 0, enrolled: 0, failed: 0 };
  }
  const scope = resolveJourneyWorkerScope();
  if (!scope.allowed) {
    return {
      disabled: true,
      reason: "canary_scope_required",
      jobs: 0,
      scanned: 0,
      eligible: 0,
      enrolled: 0,
      failed: 0,
    };
  }
  const run = await startJobRun("journey_scan", { channel: "journey_scan", kind: "tick" });
  try {
    return await runJourneyScannerMonitored(options, scope, run);
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

async function runJourneyScannerMonitored(
  options: { jobs?: number; batchSize?: number },
  scope: ReturnType<typeof resolveJourneyWorkerScope>,
  run: JobRunHandle,
) {
  const workerId = `journey-scanner-${randomUUID()}`;
  const configuredJobs = Number(process.env.JOURNEYS_SCANNER_JOB_LIMIT ?? 3);
  const configuredBatch = Number(process.env.JOURNEYS_SCANNER_BATCH_SIZE ?? 500);
  const jobLimit = Math.max(
    1,
    Math.min(options.jobs ?? (Number.isFinite(configuredJobs) ? configuredJobs : 3), 10),
  );
  const batchSize = Math.max(
    50,
    Math.min(options.batchSize ?? (Number.isFinite(configuredBatch) ? configuredBatch : 500), 2000),
  );
  const { data: claimed, error: claimError } = await db.rpc("claim_journey_scan_jobs", {
    p_limit: jobLimit,
    p_worker_id: workerId,
    p_lease_seconds: 120,
    p_tenant_ids: scope.tenantIds,
    p_journey_ids: scope.journeyIds,
  });
  if (claimError) throw new Error(claimError.message);

  const totals = { jobs: 0, scanned: 0, eligible: 0, enrolled: 0, lateEntries: 0, failed: 0 };
  await Promise.all(
    ((claimed ?? []) as ScanJob[]).map(async (job) => {
      totals.jobs++;
      try {
        const result = await scanJob(job, batchSize);
        totals.scanned += result.scanned;
        totals.eligible += result.eligible;
        totals.enrolled += result.enrolled;
        totals.lateEntries += result.lateEntries;
        run.progress({
          claimed: totals.jobs,
          sent: totals.enrolled,
          errors: totals.failed,
          actual_rate: totals.scanned,
        });
      } catch (error) {
        totals.failed++;
        const message = error instanceof Error ? error.message : String(error);
        await db.rpc("fail_journey_scan_job", {
          p_job_id: job.id,
          p_worker_id: job.lease_owner,
          p_error: message,
        });
        console.error("[journey scanner] job failed", { jobId: job.id, error: message });
      }
    }),
  );
  await run.finish({
    claimed: totals.jobs,
    sent: totals.enrolled,
    errors: totals.failed,
    actual_rate: totals.scanned,
    // dispatcher_runs has no dedicated column: late entries surface here and in
    // the route result, so a non-zero value is visible in the job monitor.
    stop_reason:
      totals.lateEntries > 0
        ? `late_entries:${totals.lateEntries}`
        : totals.jobs === 0
          ? "queue_empty"
          : null,
  });
  return { disabled: false, ...totals };
}
