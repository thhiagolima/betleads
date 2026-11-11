// F0-03 / DEV-62 — an e-mail campaign audience only ever resolves players of
// the campaign's own tenant, for both the segment and the hand-picked leads.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ players: [] as Row[], inSizes: [] as number[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => (table === "players" ? state.players : []);
    let order: string | null = null;
    let cap = Infinity;
    let head = false;
    const builder: any = {
      select: (_columns?: string, options?: { head?: boolean }) => {
        head = options?.head === true;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        state.inSizes.push(values.length);
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      // Keyset paging: `gt` on the order column, PostgREST-like `max_rows` of 1000.
      gt: (column: string, value: unknown) => {
        if (column === "id") filters.push((row) => String(row.id) > String(value));
        return builder;
      },
      order: (column: string) => {
        order = column;
        return builder;
      },
      limit: (n: number) => {
        cap = n;
        return builder;
      },
      // Activity and null filters are irrelevant to tenant scoping here.
      not: () => builder,
      is: () => builder,
      or: () => builder,
      lt: () => builder,
      gte: () => builder,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        let data = rows().filter((row) => filters.every((f) => f(row)));
        if (head) return Promise.resolve({ data: null, count: data.length, error: null }).then(resolve, reject);
        if (order) data = [...data].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
        return Promise.resolve({ data: data.slice(0, Math.min(cap, 1000)), error: null }).then(
          resolve,
          reject,
        );
      },
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});

import {
  countPlayersForSegment,
  loadPlayersByIds,
  loadPlayersForSegment,
} from "./email-segments.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

beforeEach(() => {
  state.inSizes = [];
  state.players = [
    { id: "a1", tenant_id: A, email: "a1@x.com", vip: true },
    { id: "a2", tenant_id: A, email: "a2@x.com", vip: false },
    { id: "b1", tenant_id: B, email: "b1@x.com", vip: true },
  ];
});

describe("email campaign audience is scoped to the campaign's tenant", () => {
  it("segment 'Todos' of tenant A only resolves players of A", async () => {
    const rows = await loadPlayersForSegment(A, "Todos");
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("segment 'VIP' of tenant B does not include A's VIPs", async () => {
    const rows = await loadPlayersForSegment(B, "VIP");
    expect(rows.map((r) => r.id)).toEqual(["b1"]);
  });

  it("segment count is per tenant", async () => {
    expect(await countPlayersForSegment(A, "Todos")).toBe(2);
    expect(await countPlayersForSegment(B, "Todos")).toBe(1);
  });

  it("hand-picked leads drop ids that belong to another tenant", async () => {
    const rows = await loadPlayersByIds(A, ["a1", "b1"]);
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });

  it("refuses to run without a tenant", async () => {
    await expect(loadPlayersForSegment("", "Todos")).rejects.toThrow(/tenant/i);
    await expect(loadPlayersByIds("", ["a1"])).rejects.toThrow(/tenant/i);
  });
});

describe("e-mail audiences have no size cap", () => {
  const many = (tenant: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${String(i).padStart(6, "0")}`,
      tenant_id: tenant,
      email: `p${i}@x.com`,
      vip: false,
    }));

  it("a segment pages past the 1000-row response cap", async () => {
    state.players = many(A, 7_250);
    const rows = await loadPlayersForSegment(A, "Todos");
    expect(rows).toHaveLength(7_250);
    expect(new Set(rows.map((r) => r.id)).size).toBe(7_250);
    expect(await countPlayersForSegment(A, "Todos")).toBe(7_250);
  });

  it("hand-picked leads are loaded in short chunks, all of them", async () => {
    state.players = many(A, 6_000);
    const rows = await loadPlayersByIds(
      A,
      state.players.map((p) => String(p.id)),
    );
    expect(rows).toHaveLength(6_000);
    expect(Math.max(...state.inSizes)).toBeLessThanOrEqual(300);
  });
});
