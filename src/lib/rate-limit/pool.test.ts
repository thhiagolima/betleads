import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClaimingSource,
  createTimeBudget,
  runBoundedPool,
  sleep,
  startLeaseKeeper,
} from "./pool";
import { resolveDispatchWorkerConfig } from "./worker-config";

afterEach(() => {
  vi.useRealTimers();
});

describe("runBoundedPool", () => {
  it("never exceeds the concurrency and starts the next item as soon as a slot frees", async () => {
    const items = [300, 20, 20, 20, 20, 20];
    let index = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const startedAt: number[] = [];
    const t0 = Date.now();
    await runBoundedPool({
      concurrency: 2,
      next: async () => (index < items.length ? items[index++] : null),
      handle: async (ms) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        startedAt.push(Date.now() - t0);
        await sleep(ms);
        inFlight--;
      },
    });
    expect(maxInFlight).toBe(2);
    // With waves of 2 the last item would start only after the 300 ms item.
    // A continuous pool runs the five short items alongside the slow one.
    expect(Math.max(...startedAt)).toBeLessThan(200);
  });

  it("keeps going when an item throws and reports it", async () => {
    let index = 0;
    const handled: number[] = [];
    const onError = vi.fn();
    const result = await runBoundedPool({
      concurrency: 3,
      next: async () => (index < 5 ? index++ : null),
      handle: async (n) => {
        if (n === 2) throw new Error("boom");
        handled.push(n);
      },
      onError,
    });
    expect(result.started).toBe(5);
    expect(handled.sort()).toEqual([0, 1, 3, 4]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 2);
  });

  it("stops pulling when the source fails, lets in-flight items finish, then rethrows", async () => {
    let calls = 0;
    const finished: number[] = [];
    await expect(
      runBoundedPool({
        concurrency: 2,
        next: async () => {
          calls++;
          if (calls === 3) throw new Error("claim failed");
          if (calls > 3) return null;
          return calls;
        },
        handle: async (n) => {
          await sleep(20);
          finished.push(n);
        },
      }),
    ).rejects.toThrow("claim failed");
    expect(finished.sort()).toEqual([1, 2]);
  });
});

describe("createTimeBudget", () => {
  it("stops claiming at the claim deadline and keeps the hard deadline later", () => {
    let now = 1_000;
    const budget = createTimeBudget({ claimMs: 45_000, hardMs: 240_000, now: () => now });
    expect(budget.canClaim()).toBe(true);
    now += 44_999;
    expect(budget.canClaim()).toBe(true);
    now += 1;
    expect(budget.canClaim()).toBe(false);
    expect(budget.claimRemainingMs()).toBe(0);
    expect(budget.hardRemainingMs()).toBe(195_000);
  });

  it("never puts the hard deadline before the claim deadline", () => {
    const budget = createTimeBudget({ claimMs: 50, hardMs: 10, now: () => 0 });
    expect(budget.hardDeadline).toBe(50);
  });
});

describe("createClaimingSource", () => {
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `id-${from + i}`);

  it("claims in chunks, up to maxItems, and reports queue_empty", async () => {
    const claim = vi.fn(async (n: number) => (claim.mock.calls.length === 1 ? ids(0, n) : []));
    const source = createClaimingSource({ claim, chunkSize: 3, maxItems: 10, canClaim: () => true });
    const seen: string[] = [];
    for (let item = await source.next(); item; item = await source.next()) seen.push(item);
    expect(seen).toEqual(ids(0, 3));
    expect(claim).toHaveBeenNthCalledWith(1, 3);
    expect(source.stopReason).toBe("queue_empty");
  });

  it("respects maxItems", async () => {
    let next = 0;
    const claim = vi.fn(async (n: number) => {
      const rows = ids(next, n);
      next += n;
      return rows;
    });
    const source = createClaimingSource({ claim, chunkSize: 4, maxItems: 6, canClaim: () => true });
    const seen: string[] = [];
    for (let item = await source.next(); item; item = await source.next()) seen.push(item);
    expect(seen).toHaveLength(6);
    expect(claim.mock.calls.map((c) => c[0])).toEqual([4, 2]);
    expect(source.stopReason).toBe("max_items");
  });

  it("items given back (budget-deferred) do not count toward maxItems, bounded at maxItems", async () => {
    let next = 0;
    const claim = vi.fn(async (n: number) => {
      const rows = ids(next, n);
      next += n;
      return rows;
    });
    const source = createClaimingSource({ claim, chunkSize: 4, maxItems: 4, canClaim: () => true });
    const seen: string[] = [];
    for (let item = await source.next(); item; item = await source.next()) {
      seen.push(item);
      source.giveBack(); // every item deferred by the budget
    }
    // 4 counted + at most 4 given back => at most 2 x maxItems claimed.
    expect(seen).toHaveLength(8);
    expect(source.claimed).toBe(8);
    expect(source.stopReason).toBe("max_items");
  });

  it("serializes claims across concurrent callers (one RPC in flight)", async () => {
    let active = 0;
    let maxActive = 0;
    let total = 0;
    const source = createClaimingSource({
      chunkSize: 2,
      maxItems: 8,
      canClaim: () => true,
      claim: async (n) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active--;
        const rows = ids(total, n);
        total += n;
        return rows;
      },
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => source.next()));
    expect(maxActive).toBe(1);
    expect(new Set(results).size).toBe(8);
  });

  it("time budget: stops handing out buffered items and returns them for release", async () => {
    let open = true;
    const source = createClaimingSource({
      claim: async (n) => ids(0, n),
      chunkSize: 5,
      maxItems: 100,
      canClaim: () => open,
    });
    expect(await source.next()).toBe("id-0");
    expect(await source.next()).toBe("id-1");
    open = false; // budget over: 3 claimed items were never started
    expect(await source.next()).toBeNull();
    expect(source.stopReason).toBe("time_budget");
    expect(source.drainUnstarted()).toEqual(["id-2", "id-3", "id-4"]);
    expect(source.drainUnstarted()).toEqual([]);
  });

  it("time budget end-to-end: in-flight items finish, unstarted ones are handed back", async () => {
    let now = 0;
    const budget = createTimeBudget({ claimMs: 100, hardMs: 1_000, now: () => now });
    const source = createClaimingSource({
      claim: async (n) => ids(0, n),
      chunkSize: 6,
      maxItems: 100,
      canClaim: budget.canClaim,
    });
    const finished: string[] = [];
    await runBoundedPool({
      concurrency: 2,
      next: () => source.next(),
      handle: async (id) => {
        await sleep(5);
        now += 100; // each item consumes the whole 100 ms claim budget
        finished.push(id);
      },
    });
    expect(finished.sort()).toEqual(["id-0", "id-1"]);
    expect(source.drainUnstarted()).toEqual(["id-2", "id-3", "id-4", "id-5"]);
  });
});

describe("startLeaseKeeper", () => {
  it("renews periodically without overlap and stops cleanly", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const keeper = startLeaseKeeper({
      intervalMs: 1_000,
      renew: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2_500)); // slower than the interval
        active--;
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxActive).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    const stopping = keeper.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;
    const after = calls;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(after);
  });

  it("reports renewal errors and keeps renewing", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let calls = 0;
    const keeper = startLeaseKeeper({
      intervalMs: 100,
      renew: async () => {
        calls++;
        throw new Error("db down");
      },
      onError,
    });
    await vi.advanceTimersByTimeAsync(350);
    await keeper.stop();
    expect(calls).toBe(3);
    expect(onError).toHaveBeenCalledTimes(3);
  });
});

describe("resolveDispatchWorkerConfig", () => {
  it("uses safe defaults", () => {
    expect(resolveDispatchWorkerConfig("JOURNEYS_DISPATCH", {})).toEqual({
      concurrency: 12,
      batchSize: 250,
      claimChunk: 24,
      timeBudgetMs: 45_000,
      hardDeadlineMs: 240_000,
      leaseSeconds: 120,
      renewIntervalMs: 30_000,
      maxWorkers: 1,
    });
  });

  it("honours configured values and clamps unsafe ones", () => {
    const config = resolveDispatchWorkerConfig("JOURNEYS_DISPATCH", {
      JOURNEYS_DISPATCH_CONCURRENCY: "40",
      JOURNEYS_DISPATCH_BATCH_SIZE: "5000",
      JOURNEYS_DISPATCH_TIME_BUDGET_SECONDS: "300",
      JOURNEYS_DISPATCH_HARD_DEADLINE_SECONDS: "1",
      JOURNEYS_DISPATCH_LEASE_SECONDS: "10",
      JOURNEYS_DISPATCH_MAX_WORKERS: "99",
    });
    expect(config).toMatchObject({
      concurrency: 40,
      batchSize: 1000,
      timeBudgetMs: 50_000,
      hardDeadlineMs: 50_000,
      leaseSeconds: 30,
      maxWorkers: 8,
    });
    expect(resolveDispatchWorkerConfig("X", { X_CONCURRENCY: "500" }).concurrency).toBe(40);
    expect(resolveDispatchWorkerConfig("X", { X_CONCURRENCY: "abc" }).concurrency).toBe(12);
    expect(resolveDispatchWorkerConfig("X", { X_CONCURRENCY: "0" }).concurrency).toBe(1);
  });
});
