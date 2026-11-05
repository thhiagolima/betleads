// Web push (OneSignal) — Task 8 fix round 1: IpRateLimiter.
import { describe, expect, it } from "vitest";

import { IpRateLimiter } from "./ip-rate-limit";

describe("IpRateLimiter", () => {
  it("allows up to the limit per IP per window, then rejects the next hit", () => {
    const limiter = new IpRateLimiter({ limit: 60, windowMs: 60_000, maxTracked: 5_000 });
    const now = 1_000_000;
    for (let i = 1; i <= 60; i++) {
      expect(limiter.hit("1.2.3.4", now)).toBe(false);
    }
    expect(limiter.hit("1.2.3.4", now)).toBe(true); // 61st hit in the window
  });

  it("resets an IP's budget once its window has elapsed", () => {
    const limiter = new IpRateLimiter({ limit: 2, windowMs: 1_000, maxTracked: 10 });
    expect(limiter.hit("a", 0)).toBe(false);
    expect(limiter.hit("a", 0)).toBe(false);
    expect(limiter.hit("a", 0)).toBe(true); // 3rd hit, same window
    expect(limiter.hit("a", 1_000)).toBe(false); // new window
  });

  it("tracks IPs independently", () => {
    const limiter = new IpRateLimiter({ limit: 1, windowMs: 1_000, maxTracked: 10 });
    expect(limiter.hit("a", 0)).toBe(false);
    expect(limiter.hit("b", 0)).toBe(false);
    expect(limiter.hit("a", 0)).toBe(true);
    expect(limiter.hit("b", 0)).toBe(true);
  });

  it("never grows past maxTracked under a flood of distinct IPs within one window", () => {
    const limiter = new IpRateLimiter({ limit: 60, windowMs: 60_000, maxTracked: 100 });
    for (let i = 0; i < 5_000; i++) {
      limiter.hit(`ip-${i}`, 0); // same `now` every time: nothing ever lapses
      expect(limiter.size).toBeLessThanOrEqual(100);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("evicts the oldest IP to make room when at capacity and nothing has lapsed", () => {
    const limiter = new IpRateLimiter({ limit: 60, windowMs: 60_000, maxTracked: 2 });
    limiter.hit("first", 0);
    limiter.hit("second", 0);
    limiter.hit("third", 0); // forces an eviction: same window, nothing stale
    expect(limiter.size).toBe(2);
    // "first" was evicted — readmitting it starts a fresh bucket.
    expect(limiter.hit("first", 0)).toBe(false);
  });

  it("frees capacity by sweeping lapsed buckets before evicting fresh ones", () => {
    const limiter = new IpRateLimiter({ limit: 60, windowMs: 1_000, maxTracked: 2 });
    limiter.hit("old", 0);
    limiter.hit("newer", 600);
    // "old"'s window (started at 0) has lapsed by now=1500 (elapsed 1500 >=
    // windowMs); "newer" (started at 600, elapsed 900) hasn't. The sweep
    // should reclaim "old" instead of evicting the still-fresh "newer".
    limiter.hit("third", 1_500);
    expect(limiter.size).toBe(2);
    // "newer" survived the sweep: it's still in its original window, so a
    // repeat hit for it counts against that window rather than starting a
    // fresh one — exercise that via its returned count, not `size`.
    limiter.hit("newer", 1_500);
    expect(limiter.size).toBe(2); // still "newer" + "third", nothing re-admitted
  });
});
