// Worker primitives shared by queue dispatchers (journeys today, campaigns next).
//
// - createTimeBudget: a run claims new work only until `claimMs`; in-flight items
//   may finish until `hardMs` (after that the run returns and stops renewing).
// - createClaimingSource: pulls leased items from the database in small chunks,
//   only while the budget allows; leftovers are handed back via `drainUnstarted`.
// - runBoundedPool: continuous pool of `concurrency` workers (a free slot starts
//   the next item immediately; no waves waiting for the slowest item).
// - startLeaseKeeper: periodic, non-overlapping lease renewal.
//
// Everything here is pure (no I/O of its own) and covered by pool.test.ts.

export type Clock = () => number;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export type TimeBudget = {
  readonly startedAt: number;
  /** Absolute time after which no new item may be claimed or started. */
  readonly claimDeadline: number;
  /** Absolute time after which the run stops waiting for in-flight items. */
  readonly hardDeadline: number;
  canClaim(): boolean;
  /** Milliseconds left before the claim deadline (never negative). */
  claimRemainingMs(): number;
  /** Milliseconds left before the hard deadline (never negative). */
  hardRemainingMs(): number;
};

export function createTimeBudget(options: {
  claimMs: number;
  hardMs: number;
  now?: Clock;
}): TimeBudget {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const claimDeadline = startedAt + Math.max(0, options.claimMs);
  const hardDeadline = Math.max(claimDeadline, startedAt + Math.max(0, options.hardMs));
  return {
    startedAt,
    claimDeadline,
    hardDeadline,
    canClaim: () => now() < claimDeadline,
    claimRemainingMs: () => Math.max(0, claimDeadline - now()),
    hardRemainingMs: () => Math.max(0, hardDeadline - now()),
  };
}

export type ClaimingSource<T> = {
  /** Next item to start, or null when the budget is over or the queue is drained. */
  next(): Promise<T | null>;
  /** Claimed items not handed out yet (e.g. budget ended); clears the buffer. */
  drainUnstarted(): T[];
  /**
   * The item was handed back unprocessed (e.g. its tenant's channel budget is
   * exhausted): it stops counting toward `maxItems`. At most `maxItems` give
   * backs per run, so a run claims at most 2 x maxItems rows.
   */
  giveBack(): void;
  /** Total items claimed so far. */
  readonly claimed: number;
  /** Why the source stopped handing out items (null while still active). */
  readonly stopReason: "time_budget" | "queue_empty" | "max_items" | null;
};

/**
 * Claims items in chunks of `chunkSize` (at most `maxItems` per run) only while
 * `canClaim()` holds. Calls to `next()` are serialized, so one claim RPC is in
 * flight at a time. Before handing out a buffered item it re-checks
 * `canStart()`; once false, the remaining buffer stays for `drainUnstarted()`.
 */
export function createClaimingSource<T>(options: {
  claim: (count: number) => Promise<T[]>;
  chunkSize: number;
  maxItems: number;
  canClaim: () => boolean;
  canStart?: () => boolean;
}): ClaimingSource<T> {
  const buffer: T[] = [];
  let claimed = 0;
  let givenBack = 0;
  let exhausted = false;
  let stopReason: ClaimingSource<T>["stopReason"] = null;
  let chain: Promise<unknown> = Promise.resolve();
  const canStart = options.canStart ?? options.canClaim;

  const take = async (): Promise<T | null> => {
    if (!canStart()) {
      stopReason ??= "time_budget";
      return null;
    }
    if (buffer.length === 0 && !exhausted) {
      const remaining = options.maxItems - (claimed - givenBack);
      if (remaining <= 0) {
        // Not final: a later giveBack() frees room for more claims.
        stopReason ??= "max_items";
      } else if (!options.canClaim()) {
        stopReason ??= "time_budget";
        return null;
      } else {
        const rows = await options.claim(Math.min(options.chunkSize, remaining));
        claimed += rows.length;
        buffer.push(...rows);
        if (rows.length === 0) {
          exhausted = true;
          stopReason ??= "queue_empty";
        }
      }
    }
    if (buffer.length === 0) return null;
    // The claim RPC may have taken a while: re-check before starting.
    if (!canStart()) {
      stopReason ??= "time_budget";
      return null;
    }
    return buffer.shift() ?? null;
  };

  return {
    next() {
      const result = chain.then(take, take);
      chain = result.catch(() => undefined);
      return result;
    },
    drainUnstarted() {
      return buffer.splice(0, buffer.length);
    },
    giveBack() {
      if (givenBack < options.maxItems) givenBack++;
    },
    get claimed() {
      return claimed;
    },
    get stopReason() {
      return stopReason;
    },
  };
}

/**
 * Runs `handle` over items pulled from `next` with at most `concurrency` items
 * in flight. Resolves when `next` returns null and every started item settled.
 * `handle` errors are reported to `onError` and never stop the pool; a `next`
 * error stops pulling new items (in-flight items still finish) and is rethrown.
 */
export async function runBoundedPool<T>(options: {
  concurrency: number;
  next: () => Promise<T | null>;
  handle: (item: T) => Promise<void>;
  onError?: (error: unknown, item: T) => void;
}): Promise<{ started: number }> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  let started = 0;
  let stopped = false;
  let sourceError: unknown = null;

  const worker = async () => {
    while (!stopped) {
      let item: T | null;
      try {
        item = await options.next();
      } catch (error) {
        sourceError ??= error;
        stopped = true;
        return;
      }
      if (item === null) {
        stopped = true;
        return;
      }
      started++;
      try {
        await options.handle(item);
      } catch (error) {
        options.onError?.(error, item);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (sourceError) throw sourceError;
  return { started };
}

export type LeaseKeeper = { stop(): Promise<void> };

/**
 * Calls `renew` every `intervalMs` (never overlapping; a slow renewal delays
 * the next one). Errors go to `onError`. `stop()` waits for a running renewal.
 */
export function startLeaseKeeper(options: {
  intervalMs: number;
  renew: () => Promise<void>;
  onError?: (error: unknown) => void;
}): LeaseKeeper {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, Math.max(10, options.intervalMs));
    (timer as { unref?: () => void }).unref?.();
  };
  const tick = () => {
    running = options
      .renew()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = null;
        schedule();
      });
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
