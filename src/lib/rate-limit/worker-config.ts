// Environment-driven sizing for leased queue workers. One prefix per worker
// (journeys: JOURNEYS_DISPATCH). Every value is clamped to a safe range so a
// typo cannot exhaust the PostgREST pool or outlive the cron cadence.
//
//   <PREFIX>_CONCURRENCY          items in flight per run           default 12, 1..40
//   <PREFIX>_BATCH_SIZE           max items claimed per run         default 250, 1..1000
//   <PREFIX>_TIME_BUDGET_SECONDS  claim/start new items only until  default 45, 5..50
//   <PREFIX>_HARD_DEADLINE_SECONDS  stop waiting for in-flight items default 240, budget..600
//   <PREFIX>_LEASE_SECONDS        item/slot lease, renewed at 1/4   default 120, 30..900
//   <PREFIX>_MAX_WORKERS          concurrent runs allowed           default 1, 1..8
//
// The time budget stays below the 55 s pg_net timeout and the 60 s cron
// cadence, so the next tick normally finds the slot free.

export type DispatchWorkerConfig = {
  concurrency: number;
  batchSize: number;
  /** Items claimed per claim RPC (keeps buffered, not-yet-started items few). */
  claimChunk: number;
  timeBudgetMs: number;
  hardDeadlineMs: number;
  leaseSeconds: number;
  renewIntervalMs: number;
  maxWorkers: number;
};

export const WORKER_CONFIG_LIMITS = {
  concurrency: { default: 12, min: 1, max: 40 },
  batchSize: { default: 250, min: 1, max: 1000 },
  timeBudgetSeconds: { default: 45, min: 5, max: 50 },
  hardDeadlineSeconds: { default: 240, max: 600 },
  leaseSeconds: { default: 120, min: 30, max: 900 },
  maxWorkers: { default: 1, min: 1, max: 8 },
} as const;

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value == null || value.trim() === "" ? NaN : Number(value);
  const base = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, base));
}

export function resolveDispatchWorkerConfig(
  prefix: string,
  env: Record<string, string | undefined> = process.env,
): DispatchWorkerConfig {
  const L = WORKER_CONFIG_LIMITS;
  const concurrency = intFrom(
    env[`${prefix}_CONCURRENCY`],
    L.concurrency.default,
    L.concurrency.min,
    L.concurrency.max,
  );
  const batchSize = intFrom(
    env[`${prefix}_BATCH_SIZE`],
    L.batchSize.default,
    L.batchSize.min,
    L.batchSize.max,
  );
  const timeBudgetSeconds = intFrom(
    env[`${prefix}_TIME_BUDGET_SECONDS`],
    L.timeBudgetSeconds.default,
    L.timeBudgetSeconds.min,
    L.timeBudgetSeconds.max,
  );
  const hardDeadlineSeconds = intFrom(
    env[`${prefix}_HARD_DEADLINE_SECONDS`],
    L.hardDeadlineSeconds.default,
    timeBudgetSeconds,
    L.hardDeadlineSeconds.max,
  );
  const leaseSeconds = intFrom(
    env[`${prefix}_LEASE_SECONDS`],
    L.leaseSeconds.default,
    L.leaseSeconds.min,
    L.leaseSeconds.max,
  );
  const maxWorkers = intFrom(
    env[`${prefix}_MAX_WORKERS`],
    L.maxWorkers.default,
    L.maxWorkers.min,
    L.maxWorkers.max,
  );
  return {
    concurrency,
    batchSize,
    claimChunk: Math.min(batchSize, concurrency * 2),
    timeBudgetMs: timeBudgetSeconds * 1000,
    hardDeadlineMs: hardDeadlineSeconds * 1000,
    leaseSeconds,
    renewIntervalMs: Math.floor((leaseSeconds * 1000) / 4),
    maxWorkers,
  };
}
