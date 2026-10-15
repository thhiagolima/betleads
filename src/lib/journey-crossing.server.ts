// Threshold-crossing entry for time-based journey triggers (ENV-09 part 2).
//
// Time-based triggers (inactivity, sem_login_*, vip_esfriando, ...) become true
// with no event: the clock crosses `activity_at + hours`. Instead of walking
// every player (the full scanner, now a safety net), this job asks the database
// only for players whose crossing time fell inside the window since the last
// run, then enrolls them through the exact same routine as the scanner and the
// webhook path (enrollPlayersInJourney: matcher, audience, start_after,
// cooldown, entry_key upsert).
//
// Watermark semantics (journey_crossing_states, one row per journey):
//   watermark_at        every crossing with crossing_at <= watermark_at is done.
//   pending_until       upper bound of a window that is being paged through.
//   cursor_*            keyset (crossing_at, player_id) inside that window.
//   initialized_at      when this job started covering the journey.
// A run at T processes crossing_at in (watermark_at, pending_until ?? T], in
// (crossing_at, player_id) order, page by page. A short page closes the window
// (watermark_at := upper bound); a full page keeps pending_until + cursor so the
// next page or run resumes exactly there (ties on the same timestamp included).
// First sight of a journey sets watermark_at = T (no backfill: players that
// already crossed are the full scanner's job), or trigger_config.start_after
// when it is in the past (crossings since start_after are caught up, paged).
// A journey version change keeps the watermark and restarts the open window.

import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startJobRun, type JobRunHandle } from "./observability/job-monitor.server";
import { captureServerException } from "./observability/sentry.server";
import { resolveJourneyWorkerScope } from "./journey-worker-scope";
import {
  CROSSING_TRIGGERS,
  JOURNEY_SELECT_COLUMNS,
  PLAYER_MATCH_COLUMNS,
  crossingEnabled,
  crossingSpecFor,
  crossingTimeFor,
  enrollPlayersInJourney,
  journeyInWorkerScope,
  type CrossingSpec,
  type Journey,
  type Player,
} from "./journey-scanner.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

export const CROSSING_STATE_COLUMNS =
  "journey_id,tenant_id,journey_version,watermark_at,pending_until,cursor_crossing_at," +
  "cursor_player_id,initialized_at,revision,lease_owner,lease_expires_at";

export type CrossingState = {
  journey_id: string;
  tenant_id: string;
  journey_version: number;
  watermark_at: string;
  pending_until: string | null;
  cursor_crossing_at: string | null;
  cursor_player_id: string | null;
  initialized_at: string;
  revision: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
};

export type CrossingWindow = {
  from: string;
  to: string;
  afterCrossingAt: string | null;
  afterPlayerId: string | null;
};

type CandidateRow = { player_id: string; crossing_at: string };

/** Crossings this recent are left for the next run (clock skew, in-flight writes). */
export const CROSSING_LAG_MS = 5_000;
const LEASE_SECONDS = 120;
const PLAYER_FETCH_CHUNK = 100;

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

const iso = (ms: number) => new Date(ms).toISOString();

/** First watermark of a journey: now, or a past start_after (explicit catch-up). */
export function initialWatermark(journey: Pick<Journey, "trigger_config">, now: number) {
  const startAfter = Date.parse(String(journey.trigger_config?.start_after ?? ""));
  return iso(Number.isFinite(startAfter) && startAfter < now ? startAfter : now);
}

/** Window to process on this run, or null when there is nothing new. */
export function crossingWindow(state: CrossingState, now: number): CrossingWindow | null {
  const from = Date.parse(state.watermark_at);
  const to = state.pending_until ? Date.parse(state.pending_until) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const resume = Boolean(state.pending_until && state.cursor_crossing_at && state.cursor_player_id);
  return {
    from: iso(from),
    to: iso(to),
    afterCrossingAt: resume ? state.cursor_crossing_at : null,
    afterPlayerId: resume ? state.cursor_player_id : null,
  };
}

/** State patch after one page of the window. */
export function advanceCrossingState(
  window: CrossingWindow,
  page: CandidateRow[],
  pageSize: number,
): {
  done: boolean;
  patch: Partial<
    Pick<CrossingState, "watermark_at" | "pending_until" | "cursor_crossing_at" | "cursor_player_id">
  >;
} {
  if (page.length < pageSize) {
    return {
      done: true,
      patch: {
        watermark_at: window.to,
        pending_until: null,
        cursor_crossing_at: null,
        cursor_player_id: null,
      },
    };
  }
  const last = page[page.length - 1];
  return {
    done: false,
    patch: {
      pending_until: window.to,
      cursor_crossing_at: last.crossing_at,
      cursor_player_id: last.player_id,
    },
  };
}

export type CrossingRunResult = {
  disabled: boolean;
  reason?: string;
  journeys: number;
  selected: number;
  eligible: number;
  enrolled: number;
  skipped: number;
  failed: number;
  budgetExhausted?: boolean;
};

const emptyResult = (reason?: string): CrossingRunResult => ({
  disabled: true,
  ...(reason ? { reason } : {}),
  journeys: 0,
  selected: 0,
  eligible: 0,
  enrolled: 0,
  skipped: 0,
  failed: 0,
});

export async function runJourneyCrossing(
  options: { now?: number; batchSize?: number; timeBudgetMs?: number } = {},
): Promise<CrossingRunResult> {
  if (!crossingEnabled()) return emptyResult();
  const scope = resolveJourneyWorkerScope();
  if (!scope.allowed) return emptyResult("canary_scope_required");
  const run = await startJobRun("journey_crossing", { channel: "journey_crossing", kind: "tick" });
  try {
    return await runMonitored(options, scope, run);
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

async function runMonitored(
  options: { now?: number; batchSize?: number; timeBudgetMs?: number },
  scope: ReturnType<typeof resolveJourneyWorkerScope>,
  run: JobRunHandle,
): Promise<CrossingRunResult> {
  const startedAt = Date.now();
  const now = (options.now ?? startedAt) - CROSSING_LAG_MS;
  const batchSize =
    options.batchSize ?? envNumber("JOURNEYS_CROSSING_BATCH_SIZE", 500, 50, 2000);
  const budgetMs =
    options.timeBudgetMs ?? envNumber("JOURNEYS_CROSSING_TIME_BUDGET_MS", 40_000, 5_000, 50_000);
  const workerId = `journey-crossing-${randomUUID()}`;
  const totals: CrossingRunResult = {
    disabled: false,
    journeys: 0,
    selected: 0,
    eligible: 0,
    enrolled: 0,
    skipped: 0,
    failed: 0,
  };

  const { data: journeyRows, error: journeysError } = await db
    .from("journeys")
    .select(JOURNEY_SELECT_COLUMNS)
    .eq("status", "active")
    .in("trigger_type", [...CROSSING_TRIGGERS]);
  if (journeysError) throw new Error(journeysError.message);
  const journeys = ((journeyRows ?? []) as Journey[]).filter(
    (journey) => journeyInWorkerScope(journey, scope) && crossingSpecFor(journey) != null,
  );
  if (!journeys.length) {
    await run.finish({ stop_reason: "no_time_based_journeys" });
    return totals;
  }

  const { data: stateRows, error: statesError } = await db
    .from("journey_crossing_states")
    .select(CROSSING_STATE_COLUMNS)
    .in(
      "journey_id",
      journeys.map((journey) => journey.id),
    );
  if (statesError) throw new Error(statesError.message);
  const states = new Map(
    ((stateRows ?? []) as CrossingState[]).map((state) => [state.journey_id, state]),
  );

  for (const journey of journeys) {
    if (Date.now() - startedAt > budgetMs) {
      totals.budgetExhausted = true;
      break;
    }
    totals.journeys++;
    try {
      const outcome = await processJourney(journey, states.get(journey.id) ?? null, {
        now,
        batchSize,
        workerId,
        deadline: startedAt + budgetMs,
      });
      if (outcome.skipped) totals.skipped++;
      totals.selected += outcome.selected;
      totals.eligible += outcome.eligible;
      totals.enrolled += outcome.enrolled;
      if (outcome.budgetExhausted) totals.budgetExhausted = true;
    } catch (error) {
      totals.failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[journey crossing] journey failed", { journeyId: journey.id, error: message });
      captureServerException(error, {
        job: "journey_crossing",
        tenantId: journey.tenant_id,
        tags: { journey_id: journey.id },
      });
      await db
        .from("journey_crossing_states")
        .update({ last_error: message.slice(0, 1000), lease_owner: null, lease_expires_at: null })
        .eq("journey_id", journey.id)
        .eq("lease_owner", workerId);
    }
    run.progress({
      claimed: totals.journeys,
      sent: totals.enrolled,
      errors: totals.failed,
      actual_rate: totals.selected,
    });
  }

  await run.finish({
    claimed: totals.journeys,
    sent: totals.enrolled,
    errors: totals.failed,
    actual_rate: totals.selected,
    stop_reason: totals.budgetExhausted ? "time_budget" : null,
  });
  return totals;
}

type JourneyOutcome = {
  skipped: boolean;
  selected: number;
  eligible: number;
  enrolled: number;
  budgetExhausted: boolean;
};

async function processJourney(
  journey: Journey,
  existing: CrossingState | null,
  context: { now: number; batchSize: number; workerId: string; deadline: number },
): Promise<JourneyOutcome> {
  const outcome: JourneyOutcome = {
    skipped: false,
    selected: 0,
    eligible: 0,
    enrolled: 0,
    budgetExhausted: false,
  };
  const spec = crossingSpecFor(journey) as CrossingSpec;

  let state = existing;
  if (!state) {
    const { data, error } = await db
      .from("journey_crossing_states")
      .upsert(
        [
          {
            journey_id: journey.id,
            tenant_id: journey.tenant_id,
            journey_version: journey.version,
            watermark_at: initialWatermark(journey, context.now),
            initialized_at: iso(context.now),
          },
        ],
        { onConflict: "journey_id", ignoreDuplicates: true },
      )
      .select(CROSSING_STATE_COLUMNS);
    if (error) throw new Error(error.message);
    state = ((data ?? []) as CrossingState[])[0] ?? null;
    if (!state) return { ...outcome, skipped: true }; // another worker initialised it
  }

  if (state.lease_expires_at && Date.parse(state.lease_expires_at) > Date.now()) {
    return { ...outcome, skipped: true };
  }

  // Claim with compare-and-set on revision: a concurrent run loses the race.
  const versionChanged = state.journey_version !== journey.version;
  const { data: claimedRows, error: claimError } = await db
    .from("journey_crossing_states")
    .update({
      lease_owner: context.workerId,
      lease_expires_at: iso(Date.now() + LEASE_SECONDS * 1000),
      revision: state.revision + 1,
      journey_version: journey.version,
      ...(versionChanged
        ? { pending_until: null, cursor_crossing_at: null, cursor_player_id: null }
        : {}),
    })
    .eq("journey_id", journey.id)
    .eq("revision", state.revision)
    .select(CROSSING_STATE_COLUMNS);
  if (claimError) throw new Error(claimError.message);
  const claimed = ((claimedRows ?? []) as CrossingState[])[0];
  if (!claimed) return { ...outcome, skipped: true };
  state = claimed;

  for (;;) {
    const window = crossingWindow(state, context.now);
    if (!window) break;
    if (Date.now() > context.deadline) {
      outcome.budgetExhausted = true;
      break;
    }
    const { data: candidateRows, error: candidateError } = await db.rpc(
      "journey_crossing_candidates",
      {
        p_tenant_id: journey.tenant_id,
        p_fields: spec.fields,
        p_hours: spec.hours,
        p_from: window.from,
        p_to: window.to,
        p_after_crossing_at: window.afterCrossingAt,
        p_after_player_id: window.afterPlayerId,
        p_limit: context.batchSize,
      },
    );
    if (candidateError) throw new Error(candidateError.message);
    const page = (candidateRows ?? []) as CandidateRow[];
    outcome.selected += page.length;

    const players = await fetchPlayers(
      journey.tenant_id,
      page.map((row) => row.player_id),
    );
    const entry = await enrollPlayersInJourney(journey, players, {
      source: "crossing-v1",
      extraMetadata: (player) => {
        const crossedAt = crossingTimeFor(journey, player);
        return crossedAt == null ? null : { crossing_at: iso(crossedAt) };
      },
    });
    outcome.eligible += entry.eligible;
    outcome.enrolled += entry.enrolled;

    const { done, patch } = advanceCrossingState(window, page, context.batchSize);
    const { data: saved, error: saveError } = await db
      .from("journey_crossing_states")
      .update({
        ...patch,
        last_run_at: iso(Date.now()),
        last_error: null,
        last_selected: page.length,
        last_enrolled: entry.enrolled,
        ...(done ? { lease_owner: null, lease_expires_at: null } : {}),
      })
      .eq("journey_id", journey.id)
      .eq("lease_owner", context.workerId)
      .select(CROSSING_STATE_COLUMNS);
    if (saveError) throw new Error(saveError.message);
    const next = ((saved ?? []) as CrossingState[])[0];
    if (!next) throw new Error("Lease do cruzamento expirou antes de gravar a marca d'agua");
    state = next;
    if (done) return outcome;
  }

  // Nothing to do (empty window) or out of time with the window still open.
  await db
    .from("journey_crossing_states")
    .update({ lease_owner: null, lease_expires_at: null, last_run_at: iso(Date.now()) })
    .eq("journey_id", journey.id)
    .eq("lease_owner", context.workerId);
  return outcome;
}

async function fetchPlayers(tenantId: string, playerIds: string[]): Promise<Player[]> {
  const players: Player[] = [];
  for (let offset = 0; offset < playerIds.length; offset += PLAYER_FETCH_CHUNK) {
    const { data, error } = await db
      .from("players")
      .select(PLAYER_MATCH_COLUMNS)
      .eq("tenant_id", tenantId)
      .in("id", playerIds.slice(offset, offset + PLAYER_FETCH_CHUNK));
    if (error) throw new Error(error.message);
    players.push(...((data ?? []) as Player[]));
  }
  return players;
}
