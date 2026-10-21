import { describe, expect, it, vi } from "vitest";

import { chunk, fetchAllPages } from "./shortio.functions";

describe("fetchAllPages", () => {
  it("keeps reading past the 1.000-row PostgREST page until a short page", async () => {
    const total = 2500;
    const calls: Array<[number, number]> = [];
    const rows = await fetchAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      const end = Math.min(to, total - 1);
      return {
        data: end >= from ? Array.from({ length: end - from + 1 }, (_, i) => from + i) : [],
        error: null,
      };
    });
    expect(rows).toHaveLength(2500);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops at the safety cap", async () => {
    const page = vi.fn(async (from: number, to: number) => ({
      data: Array.from({ length: to - from + 1 }, () => 1),
      error: null,
    }));
    const rows = await fetchAllPages<number>(page, 10, 30);
    expect(rows).toHaveLength(30);
    expect(page).toHaveBeenCalledTimes(3);
  });

  it("throws the query error", async () => {
    await expect(
      fetchAllPages(async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("boom");
  });
});

describe("chunk", () => {
  it("splits ids into bounded batches for .in()", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
