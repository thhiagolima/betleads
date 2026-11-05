// Web push (OneSignal) — Task 8 fix round 1: bounded in-memory per-IP rate
// limiter for the public subscribe endpoint. A fixed-window counter per IP.
//
// Bounding: once the map holds `maxTracked` entries, admitting a brand-new
// IP first sweeps buckets whose window has already lapsed — but that sweep
// runs at most once per `windowMs`, never on every single insert, so a
// sustained flood sitting right at capacity can't turn each admission into
// an O(n) scan. If the map is still at/over capacity after the sweep (a
// flood of genuinely distinct IPs arriving within one window), the oldest
// entries (Map preserves insertion order) are evicted until there's room —
// so `size` can never exceed `maxTracked`, regardless of how many distinct
// IPs show up.
export type IpRateLimiterOptions = {
  /** Max hits per IP within `windowMs` before `hit()` returns true. */
  limit: number;
  windowMs: number;
  /** Hard cap on the number of IPs tracked at once. */
  maxTracked: number;
};

type Bucket = { count: number; windowStart: number };

export class IpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt = 0;

  constructor(private readonly opts: IpRateLimiterOptions) {}

  get size(): number {
    return this.buckets.size;
  }

  /** Returns true once `ip` has exceeded the budget for its current window. */
  hit(ip: string, now: number): boolean {
    const existing = this.buckets.get(ip);
    if (existing && now - existing.windowStart < this.opts.windowMs) {
      existing.count += 1;
      return existing.count > this.opts.limit;
    }

    if (!this.buckets.has(ip) && this.buckets.size >= this.opts.maxTracked) {
      this.makeRoom(now);
    }
    this.buckets.set(ip, { count: 1, windowStart: now });
    return false;
  }

  private makeRoom(now: number): void {
    if (now - this.lastSweepAt >= this.opts.windowMs) {
      this.lastSweepAt = now;
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.windowStart >= this.opts.windowMs) this.buckets.delete(key);
      }
    }

    while (this.buckets.size >= this.opts.maxTracked) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}
