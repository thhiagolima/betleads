// link-domain.server (pagination fix): unit tests for the pure-ish paging
// helper `fetchAllRows`, exercised with a fake `queryPage` so no Supabase
// client/network is involved. The rest of link-domain.server.ts is DB I/O,
// covered by manual/integration verification like loadLinkDomainSources'
// callers, not here.
import { describe, expect, it } from "vitest";
import { fetchAllRows } from "./link-domain.server";

function page(rows: number[]): { data: number[]; error: null } {
  return { data: rows, error: null };
}

describe("fetchAllRows", () => {
  it("concatenates every page until a short page comes back (1000 then 3 -> 1003)", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => i);
    const secondPage = [1000, 1001, 1002];
    const calls: { from: number; to: number }[] = [];

    const rows = await fetchAllRows<number>((from, to) => {
      calls.push({ from, to });
      return Promise.resolve(calls.length === 1 ? page(firstPage) : page(secondPage));
    });

    expect(rows).toHaveLength(1003);
    expect(rows[0]).toBe(0);
    expect(rows[1002]).toBe(1002);
    expect(calls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
  });

  it("stops after a single page when it's already short (no extra round-trip)", async () => {
    let calls = 0;
    const rows = await fetchAllRows<number>((from, to) => {
      calls += 1;
      return Promise.resolve(page([1, 2, 3]));
    });
    expect(rows).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });

  it("returns an empty array when the first page is empty", async () => {
    const rows = await fetchAllRows<number>(() => Promise.resolve(page([])));
    expect(rows).toEqual([]);
  });

  it("throws the Supabase error message instead of swallowing it", async () => {
    await expect(
      fetchAllRows<number>(() => Promise.resolve({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
  });

  it("an exact-page-size batch (1000) triggers one more round-trip that comes back empty", async () => {
    const onlyPage = Array.from({ length: 1000 }, (_, i) => i);
    const calls: { from: number; to: number }[] = [];
    const rows = await fetchAllRows<number>((from, to) => {
      calls.push({ from, to });
      return Promise.resolve(calls.length === 1 ? page(onlyPage) : page([]));
    });
    expect(rows).toHaveLength(1000);
    expect(calls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
  });
});
