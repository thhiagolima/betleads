import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordRun } from "./dispatch-rate.server";
import { journeyEntryKey, qualifiesForInactivity, triggerOccurrence } from "./journey-policy";
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

type Journey = {
  id: string;
  tenant_id: string;
  version: number;
  status: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  entry_rules: Record<string, unknown>;
  cooldown_hours: number;
};

type Player = Record<string, unknown> & {
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
  complete: boolean;
};

function audienceMatches(journey: Journey, player: Player) {
  const audience = String(journey.entry_rules?.audience ?? "all_active");
  if (audience === "manual") return false;
  if (audience === "all_active" && player.status !== "ativo") return false;
  if (audience === "vip" && player.vip !== true) return false;
  return true;
}

function optionalStartAt(journey: Journey) {
  const value = String(journey.trigger_config?.start_after ?? "");
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function financialOccurrences(journey: Journey, players: Player[]) {
  const occurrences = new Map<string, string>();
  if (!["pix_gerado_nao_pago", "saque_pago"].includes(journey.trigger_type)) return occurrences;
  const playerIds = players.map((player) => player.id);
  if (!playerIds.length) return occurrences;
  const table = journey.trigger_type === "saque_pago" ? "withdrawals" : "deposits";
  let query = db
    .from(table)
    .select("id,player_id,created_at")
    .eq("tenant_id", journey.tenant_id)
    .in("player_id", playerIds)
    .order("created_at", { ascending: false });
  query =
    journey.trigger_type === "saque_pago"
      ? query.eq("status", "aprovado")
      : query.eq("status", "pendente").ilike("metodo", "%pix%");
  const startAt = optionalStartAt(journey);
  if (startAt != null) query = query.gte("created_at", new Date(startAt).toISOString());
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (!occurrences.has(row.player_id)) occurrences.set(row.player_id, String(row.id));
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
      matches: qualifiesForInactivity(player, journey.trigger_config ?? {}),
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

async function scanJob(job: ScanJob, batchSize: number): Promise<ScanBatchResult> {
  const { data: journeyRaw, error: journeyError } = await db
    .from("journeys")
    .select("id,tenant_id,version,status,trigger_type,trigger_config,entry_rules,cooldown_hours")
    .eq("id", job.journey_id)
    .eq("tenant_id", job.tenant_id)
    .maybeSingle();
  if (journeyError) throw new Error(journeyError.message);
  const journey = journeyRaw as Journey | null;
  if (!journey || journey.status !== "active" || journey.version !== job.journey_version) {
    throw new Error("Jornada alterada ou inativa durante a varredura");
  }

  let playersQuery = db
    .from("players")
    .select("*")
    .eq("tenant_id", job.tenant_id)
    .order("id", { ascending: true })
    .limit(batchSize);
  if (job.cursor_player_id) playersQuery = playersQuery.gt("id", job.cursor_player_id);
  const { data: playerRows, error: playersError } = await playersQuery;
  if (playersError) throw new Error(playersError.message);
  const players = (playerRows ?? []) as Player[];
  const occurrences = await financialOccurrences(journey, players);
  const cooldownBlocked = await recentCooldownPlayers(
    journey,
    players.map((player) => player.id),
  );

  const eligible = players
    .map((player) => ({
      player,
      match: matchJourneyScanPlayer(journey, player, occurrences),
    }))
    .filter(({ player, match }) => match.matches && !cooldownBlocked.has(player.id));
  const enrollmentRows = eligible.map(({ player, match }) => ({
    tenant_id: journey.tenant_id,
    journey_id: journey.id,
    journey_version: journey.version,
    player_id: player.id,
    entry_key: journeyEntryKey(journey.trigger_type, journey.entry_rules ?? {}, match.occurrence),
    metadata: {
      trigger: journey.trigger_type,
      trigger_occurrence: match.occurrence,
      deposited_before_entry: Number(player.total_depositado ?? 0),
      scanner: "async-v1",
    },
  }));

  let enrolled = 0;
  if (enrollmentRows.length) {
    const { data, error } = await db
      .from("journey_enrollments")
      .upsert(enrollmentRows, {
        onConflict: "journey_id,player_id,entry_key",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw new Error(error.message);
    enrolled = data?.length ?? 0;
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
      p_eligible: eligible.length,
      p_enrolled: enrolled,
      p_duplicates: Math.max(0, eligible.length - enrolled),
      p_rescan_seconds: 300,
    },
  );
  if (completeError) throw new Error(completeError.message);
  if (!completed) throw new Error("Lease da varredura expirou antes da confirmacao do cursor");
  return {
    scanned: players.length,
    eligible: eligible.length,
    enrolled,
    duplicates: Math.max(0, eligible.length - enrolled),
    complete,
  };
}

export async function runJourneyScanner(options: { jobs?: number; batchSize?: number } = {}) {
  if (process.env.JOURNEYS_SCANNER_ENABLED !== "true") {
    return { disabled: true, jobs: 0, scanned: 0, eligible: 0, enrolled: 0, failed: 0 };
  }
  const startedAt = Date.now();
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
  });
  if (claimError) throw new Error(claimError.message);

  const totals = { jobs: 0, scanned: 0, eligible: 0, enrolled: 0, failed: 0 };
  await Promise.all(
    ((claimed ?? []) as ScanJob[]).map(async (job) => {
      totals.jobs++;
      try {
        const result = await scanJob(job, batchSize);
        totals.scanned += result.scanned;
        totals.eligible += result.eligible;
        totals.enrolled += result.enrolled;
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
  await recordRun(startedAt, {
    channel: "journey_scan",
    claimed: totals.jobs,
    sent: totals.enrolled,
    errors: totals.failed,
    actual_rate: totals.scanned,
    stop_reason: totals.jobs === 0 ? "queue_empty" : null,
  });
  return { disabled: false, ...totals };
}
