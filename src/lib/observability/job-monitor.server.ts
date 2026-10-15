// Job monitor: start/progress/finish tracking for background jobs (OBS-04/OBS-05).
//
// Every critical worker opens a `dispatcher_runs` row with status='running' when
// it starts, refreshes `heartbeat_at` while it works and closes the row when it
// ends. A worker that hangs or is killed leaves a 'running' row whose heartbeat
// stops moving, which `observability_job_health()` reports as stale.
//
// On completion the monitor also pings a Better Stack heartbeat URL read from
// the environment, so the absence of a ping raises an alert outside the app.
//
//   job                     env var
//   ----------------------  ----------------------------------------------
//   journey_dispatch        BETTERSTACK_HEARTBEAT_JOURNEY_DISPATCH
//   journey_scan            BETTERSTACK_HEARTBEAT_JOURNEY_SCAN
//   sms_campaign_dispatch   BETTERSTACK_HEARTBEAT_SMS_CAMPAIGN_DISPATCH
//   sms_tick                BETTERSTACK_HEARTBEAT_SMS_TICK (SMS flows, legacy recordRun)
//   email_tick              BETTERSTACK_HEARTBEAT_EMAIL_TICK (e-mail flows, legacy recordRun)
//   email_campaign          BETTERSTACK_HEARTBEAT_EMAIL_CAMPAIGN (legacy recordRun)
//   webhook_replay          BETTERSTACK_HEARTBEAT_WEBHOOK_REPLAY
//   shortio_sync            BETTERSTACK_HEARTBEAT_SHORTIO_SYNC
//   recovery                BETTERSTACK_HEARTBEAT_RECOVERY
//   (any other job name)    BETTERSTACK_HEARTBEAT_<JOB in upper snake case>
//
// Success (status succeeded/partial) pings `<url>`; failure pings `<url>/fail`.
// Missing env var = no-op. Nothing in this module ever throws into the job.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureServerException } from "@/lib/observability/sentry.server";

export type JobStatus = "running" | "succeeded" | "failed" | "partial";

export type JobCounters = {
  queue_before: number;
  claimed: number;
  sent: number;
  errors: number;
  rescheduled: number;
  rate_limited: number;
  lock_recovered: number;
  target_rate: number | null;
  actual_rate: number | null;
};

export type JobMeta = {
  channel?: string;
  tenantId?: string | null;
  kind?: string;
  provider?: string | null;
};

export type JobFinish = Partial<JobCounters> & {
  status?: Exclude<JobStatus, "running">;
  stop_reason?: string | null;
  provider?: string | null;
  last_provider_error?: string | null;
};

export type JobRunHandle = {
  readonly job: string;
  /** dispatcher_runs.id, or null if the start row could not be written. */
  readonly id: number | null;
  /** Merge counters and refresh heartbeat_at (at most one write per 10 s). Never throws. */
  progress(partial: Partial<JobCounters>): void;
  /** Close the run. Default status: 'partial' when errors > 0, else 'succeeded'. */
  finish(result?: JobFinish): Promise<void>;
  /** Close the run as failed, report to Sentry and ping the failure heartbeat. */
  fail(error: unknown, result?: Omit<JobFinish, "status">): Promise<void>;
};

export const PROGRESS_THROTTLE_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 3_000;
/** Better Stack's minimum heartbeat period is 30 s; avoid spamming it from 5 s ticks. */
export const HEARTBEAT_MIN_INTERVAL_MS = 30_000;
/**
 * While a run is open, a timer refreshes heartbeat_at on this period even when
 * the job is stuck in a long phase without calling progress(). Only a dead or
 * blocked process stops heartbeating. Must stay well below the 2 min "stale"
 * threshold of observability_job_health().
 */
export const HEARTBEAT_TIMER_MS = 30_000;
/** A 'running' row without heartbeat for this long is closed as abandoned. */
export const ABANDONED_AFTER_MS = 15 * 60_000;
/** After falling back to the legacy schema, retry the new columns after this long. */
export const LEGACY_SCHEMA_RETRY_MS = 10 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = any;

function db(): LooseDb {
  // The new columns are not in the generated types yet.
  return supabaseAdmin as LooseDb;
}

// If the observability migration is not applied yet, the extra columns do not
// exist. Fall back to the legacy column set so run logging keeps working.
// The fallback expires so a migration applied after boot (or a transient
// PostgREST schema-cache miss) does not pin the process to legacy mode.
let legacySchemaSince: number | null = null;

function isLegacySchema(): boolean {
  if (legacySchemaSince === null) return false;
  if (Date.now() - legacySchemaSince >= LEGACY_SCHEMA_RETRY_MS) {
    legacySchemaSince = null;
    return false;
  }
  return true;
}

function markLegacySchema() {
  legacySchemaSince = Date.now();
}

/** Test hook: reset module state between tests. */
export function __resetJobMonitorStateForTests() {
  legacySchemaSince = null;
  lastHeartbeatAt.clear();
}

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  if (e.code === "42703" || e.code === "PGRST204") return true;
  return /column .* (does not exist|could not find)|could not find the '.*' column/i.test(
    e.message ?? "",
  );
}

const NEW_COLUMNS = ["status", "heartbeat_at", "job", "tenant_id"] as const;

function stripNewColumns(row: Record<string, unknown>) {
  const copy = { ...row };
  for (const column of NEW_COLUMNS) delete copy[column];
  return copy;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ------------------------------------------------------------------
// Better Stack heartbeats
// ------------------------------------------------------------------

/** `journey_dispatch` -> `BETTERSTACK_HEARTBEAT_JOURNEY_DISPATCH`. */
export function heartbeatEnvName(job: string): string {
  const normalized = job
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `BETTERSTACK_HEARTBEAT_${normalized}`;
}

/** Returns the URL to ping, or null when not configured / invalid. */
export function heartbeatUrl(job: string, ok: boolean, env = process.env): string | null {
  const raw = env[heartbeatEnvName(job)]?.trim();
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (ok) return base.toString();
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/fail`;
  return base.toString();
}

const lastHeartbeatAt = new Map<string, number>();

/**
 * Fire-and-forget heartbeat ping. Never throws, never blocks for more than
 * HEARTBEAT_TIMEOUT_MS (the returned promise resolves even on timeout/error).
 * Pings are throttled per job/outcome to one per HEARTBEAT_MIN_INTERVAL_MS.
 */
export function pingHeartbeat(job: string, ok: boolean): Promise<void> {
  try {
    const url = heartbeatUrl(job, ok);
    if (!url) return Promise.resolve();
    const key = `${job}:${ok ? "ok" : "fail"}`;
    const now = Date.now();
    const last = lastHeartbeatAt.get(key);
    if (last !== undefined && now - last < HEARTBEAT_MIN_INTERVAL_MS) return Promise.resolve();
    lastHeartbeatAt.set(key, now);
    return fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    }).then(
      () => undefined,
      (error) => {
        console.error("[job-monitor] heartbeat ping failed", { job, error: errorMessage(error) });
      },
    );
  } catch (error) {
    console.error("[job-monitor] heartbeat ping failed", { job, error: errorMessage(error) });
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------
// dispatcher_runs writes (best effort)
// ------------------------------------------------------------------

async function insertRun(row: Record<string, unknown>): Promise<number | null> {
  try {
    const attempt = async (payload: Record<string, unknown>) =>
      db().from("dispatcher_runs").insert(payload).select("id").maybeSingle();
    const legacy = isLegacySchema();
    let { data, error } = await attempt(legacy ? stripNewColumns(row) : row);
    if (error && !legacy && isMissingColumnError(error)) {
      markLegacySchema();
      ({ data, error } = await attempt(stripNewColumns(row)));
    }
    if (error) {
      console.error("[job-monitor] dispatcher_runs insert failed", errorMessage(error));
      return null;
    }
    const id = (data as { id?: number | string } | null)?.id;
    return id == null ? null : Number(id);
  } catch (error) {
    console.error("[job-monitor] dispatcher_runs insert failed", errorMessage(error));
    return null;
  }
}

async function updateRun(
  id: number,
  patch: Record<string, unknown>,
  onlyWhileRunning: boolean,
): Promise<void> {
  try {
    const attempt = async (payload: Record<string, unknown>, guard: boolean) => {
      let query = db().from("dispatcher_runs").update(payload).eq("id", id);
      if (guard) query = query.eq("status", "running");
      return query;
    };
    const legacy = isLegacySchema();
    let { error } = await attempt(
      legacy ? stripNewColumns(patch) : patch,
      onlyWhileRunning && !legacy,
    );
    if (error && !legacy && isMissingColumnError(error)) {
      markLegacySchema();
      ({ error } = await attempt(stripNewColumns(patch), false));
    }
    if (error) console.error("[job-monitor] dispatcher_runs update failed", errorMessage(error));
  } catch (error) {
    console.error("[job-monitor] dispatcher_runs update failed", errorMessage(error));
  }
}

/**
 * Closes 'running' rows of the same job whose worker stopped heartbeating long
 * ago (process killed / container restarted). Best effort, never throws.
 */
async function reapAbandonedRuns(job: string, currentId: number | null): Promise<void> {
  if (isLegacySchema()) return;
  try {
    const nowIso = new Date().toISOString();
    let query = db()
      .from("dispatcher_runs")
      .update({ status: "failed", finished_at: nowIso, stop_reason: "abandoned" })
      .eq("job", job)
      .eq("status", "running")
      .lt("heartbeat_at", new Date(Date.now() - ABANDONED_AFTER_MS).toISOString());
    if (currentId != null) query = query.neq("id", currentId);
    const { error } = await query;
    if (error) console.error("[job-monitor] reap abandoned runs failed", errorMessage(error));
  } catch (error) {
    console.error("[job-monitor] reap abandoned runs failed", errorMessage(error));
  }
}

function counterColumns(counters: Partial<JobCounters>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(counters)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

const DEFAULT_COUNTERS: JobCounters = {
  queue_before: 0,
  claimed: 0,
  sent: 0,
  errors: 0,
  rescheduled: 0,
  rate_limited: 0,
  lock_recovered: 0,
  target_rate: null,
  actual_rate: null,
};

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Opens a run. Always resolves with a usable handle, even when the database
 * is unavailable (the handle then writes a complete row at finish time).
 */
export async function startJobRun(job: string, meta: JobMeta = {}): Promise<JobRunHandle> {
  const startedAt = Date.now();
  const channel = meta.channel ?? job;
  const kind = meta.kind ?? "tick";
  const tenantId = meta.tenantId ?? null;
  const counters: JobCounters = { ...DEFAULT_COUNTERS };
  let provider = meta.provider ?? null;
  let lastProgressWrite = startedAt;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const startIso = new Date(startedAt).toISOString();
  const id = await insertRun({
    channel,
    kind,
    job,
    tenant_id: tenantId,
    status: "running",
    started_at: startIso,
    heartbeat_at: startIso,
    finished_at: null,
    provider,
  });
  // Not awaited: housekeeping must not delay the job.
  void reapAbandonedRuns(job, id);

  // Liveness heartbeat independent of progress() calls (see HEARTBEAT_TIMER_MS).
  const writeHeartbeat = (runId: number, now: number) => {
    lastProgressWrite = now;
    inFlight = updateRun(
      runId,
      { ...counters, heartbeat_at: new Date(now).toISOString() },
      true,
    ).finally(() => {
      inFlight = null;
    });
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (id != null) {
    heartbeatTimer = setInterval(() => {
      try {
        if (closed || inFlight) return;
        const now = Date.now();
        if (now - lastProgressWrite < HEARTBEAT_TIMER_MS) return;
        writeHeartbeat(id, now);
      } catch (error) {
        console.error("[job-monitor] heartbeat timer failed", { job, error: errorMessage(error) });
      }
    }, HEARTBEAT_TIMER_MS);
    // Never keep the process alive just for the heartbeat.
    (heartbeatTimer as { unref?: () => void }).unref?.();
  }

  const close = async (
    status: Exclude<JobStatus, "running">,
    result: JobFinish,
  ): Promise<void> => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      Object.assign(counters, counterColumns(result));
      if (result.provider !== undefined) provider = result.provider;
      if (inFlight) await inFlight.catch(() => undefined);
      const finished = Date.now();
      const finishedIso = new Date(finished).toISOString();
      const row: Record<string, unknown> = {
        ...counters,
        actual_rate: counters.actual_rate ?? counters.sent,
        status,
        heartbeat_at: finishedIso,
        finished_at: finishedIso,
        duration_ms: finished - startedAt,
        stop_reason: result.stop_reason ?? null,
        provider,
        last_provider_error: result.last_provider_error?.slice(0, 800) ?? null,
      };
      if (id != null) {
        await updateRun(id, row, false);
      } else {
        // The start row was lost (DB hiccup). Still leave a complete record.
        await insertRun({
          ...row,
          channel,
          kind,
          job,
          tenant_id: tenantId,
          started_at: startIso,
        });
      }
    } catch (error) {
      console.error("[job-monitor] finish failed", { job, error: errorMessage(error) });
    }
    void pingHeartbeat(job, status !== "failed");
  };

  return {
    job,
    id,
    progress(partial) {
      try {
        if (closed) return;
        Object.assign(counters, counterColumns(partial));
        if (id == null || inFlight) return;
        const now = Date.now();
        if (now - lastProgressWrite < PROGRESS_THROTTLE_MS) return;
        writeHeartbeat(id, now);
      } catch (error) {
        console.error("[job-monitor] progress failed", { job, error: errorMessage(error) });
      }
    },
    finish(result = {}) {
      const errors = result.errors ?? counters.errors;
      const status = result.status ?? (errors > 0 ? "partial" : "succeeded");
      return close(status, result);
    },
    async fail(error, result = {}) {
      if (closed) return;
      try {
        captureServerException(error, { job, tenantId });
      } catch (captureError) {
        console.error("[job-monitor] captureServerException failed", errorMessage(captureError));
      }
      await close("failed", {
        ...result,
        stop_reason: result.stop_reason ?? `error: ${errorMessage(error).slice(0, 200)}`,
        last_provider_error: result.last_provider_error ?? errorMessage(error).slice(0, 800),
      });
    },
  };
}

/** Runs `fn` inside a monitored run; failures are recorded and re-thrown. */
export async function withJobRun<T>(
  job: string,
  meta: JobMeta,
  fn: (run: JobRunHandle) => Promise<T>,
): Promise<T> {
  const run = await startJobRun(job, meta);
  try {
    const value = await fn(run);
    await run.finish();
    return value;
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

/**
 * Legacy callers do not pass a status. A run that could not even claim work
 * ("claim_error: ...") or stopped with "error" failed regardless of the error
 * counter, so the failure heartbeat fires and failed_last_hour counts it.
 */
export function deriveLegacyStatus(
  errors: number,
  stopReason: string | null | undefined,
): Exclude<JobStatus, "running"> {
  if (stopReason && /^(claim_error|error)\b/.test(stopReason)) return "failed";
  return errors > 0 ? "partial" : "succeeded";
}

/**
 * Inserts an already-finished run in one write (legacy `recordRun` path).
 * Pings the job heartbeat unless `heartbeat` is false.
 */
export async function recordCompletedRun(
  job: string,
  startedAt: number,
  meta: JobMeta,
  result: JobFinish,
  options: { heartbeat?: boolean } = {},
): Promise<void> {
  const finished = Date.now();
  const finishedIso = new Date(finished).toISOString();
  const errors = result.errors ?? 0;
  const status = result.status ?? deriveLegacyStatus(errors, result.stop_reason);
  await insertRun({
    channel: meta.channel ?? job,
    kind: meta.kind ?? "tick",
    job,
    tenant_id: meta.tenantId ?? null,
    status,
    started_at: new Date(startedAt).toISOString(),
    heartbeat_at: finishedIso,
    finished_at: finishedIso,
    duration_ms: finished - startedAt,
    queue_before: result.queue_before ?? 0,
    claimed: result.claimed ?? 0,
    sent: result.sent ?? 0,
    errors,
    rescheduled: result.rescheduled ?? 0,
    rate_limited: result.rate_limited ?? 0,
    lock_recovered: result.lock_recovered ?? 0,
    target_rate: result.target_rate ?? null,
    actual_rate: result.actual_rate ?? result.sent ?? 0,
    stop_reason: result.stop_reason ?? null,
    provider: result.provider ?? meta.provider ?? null,
    last_provider_error: result.last_provider_error?.slice(0, 800) ?? null,
  });
  if (options.heartbeat !== false) void pingHeartbeat(job, status !== "failed");
}
