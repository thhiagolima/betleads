// syncShortioMetrics global run: every non-demo house with links in the
// statistics window is visited (the houses come from `tenants`, not from a
// sample of tracked_links rows), the tick budget is split between them, links
// older than the window are skipped, and one concurrency gate caps in-flight
// Short.io calls across all houses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let write: "update" | "insert" | null = null;
    let limit = Infinity;
    const run = () =>
      (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
    const result = () => {
      if (write === "insert") return { data: { id: `${table}-new` }, error: null };
      if (write) return { data: null, error: null };
      return { data: run(), error: null };
    };
    const builder: any = {
      select: () => builder,
      update: () => ((write = write ?? "update"), builder),
      insert: () => ((write = "insert"), builder),
      upsert: () => Promise.resolve({ error: null }),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "") >= v), builder),
      lt: () => builder,
      not: () => builder,
      like: () => builder,
      order: () => builder,
      limit: (n: number) => ((limit = n), builder),
      maybeSingle: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from, rpc: async () => ({ data: [], error: null }) } };
});

import { syncShortioMetrics } from "./shortio.server";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";

const DEMO = "00000000-0000-4000-8000-00000000d0d0";
const BIG = "00000000-0000-4000-8000-0000000000b1";
const SMALL = "00000000-0000-4000-8000-0000000000b2";
const NEW = "00000000-0000-4000-8000-0000000000b3";
const IDLE = "00000000-0000-4000-8000-0000000000b4";

const now = new Date().toISOString();
const old = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();

function links(tenantId: string, count: number, createdAt = now): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tenantId}-l${i}`,
    tenant_id: tenantId,
    shortio_link_id: `sh_${tenantId}_${i}`,
    status: "active",
    created_at: createdAt,
    last_synced_at: null,
  }));
}

let inFlight = 0;
let maxInFlight = 0;
let fetched: string[] = [];

beforeEach(() => {
  __resetDemoTenantCacheForTests();
  process.env.SHORTIO_API_KEY = "test-key";
  process.env.SHORTIO_SYNC_CONCURRENCY = "4";
  inFlight = 0;
  maxInFlight = 0;
  fetched = [];
  state.tables = {
    tenants: [
      { id: DEMO, status: "active", is_demo: true },
      { id: BIG, status: "active", is_demo: false },
      { id: SMALL, status: "active", is_demo: false },
      { id: NEW, status: "active", is_demo: false },
      { id: IDLE, status: "active", is_demo: false },
    ],
    // The largest house first: a sample of the first rows never reached the
    // other houses.
    tracked_links: [
      ...links(BIG, 200),
      ...links(SMALL, 3),
      ...links(NEW, 2),
      ...links(IDLE, 5, old),
      ...links(DEMO, 2),
    ],
    link_tracking_sync_runs: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return new Response(JSON.stringify({ clicksStatistics: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SHORTIO_API_KEY;
  delete process.env.SHORTIO_SYNC_CONCURRENCY;
});

const fetchedFor = (tenantId: string) => fetched.filter((u) => u.includes(`sh_${tenantId}_`));

describe("syncShortioMetrics global run", () => {
  it("visits every house with links in the window, not only the largest", async () => {
    const result = await syncShortioMetrics(90);
    expect(result.tenants).toBe(3);
    expect(fetchedFor(SMALL)).toHaveLength(3);
    expect(fetchedFor(NEW)).toHaveLength(2);
    expect(fetchedFor(DEMO)).toHaveLength(0);
  });

  it("skips links older than the 30-day statistics window", async () => {
    await syncShortioMetrics(90);
    expect(fetchedFor(IDLE)).toHaveLength(0);
  });

  it("splits the tick budget between the houses", async () => {
    await syncShortioMetrics(90);
    // 90 links / 3 houses = 30 each; the large house cannot take the tick.
    expect(fetchedFor(BIG)).toHaveLength(30);
  });

  it("gives each house a minimum share when the budget is small", async () => {
    await syncShortioMetrics(10);
    expect(fetchedFor(BIG)).toHaveLength(25);
  });

  it("caps in-flight Short.io calls across all houses with one gate", async () => {
    await syncShortioMetrics(300);
    expect(fetched.length).toBeGreaterThan(4);
    expect(maxInFlight).toBe(4);
  });
});
