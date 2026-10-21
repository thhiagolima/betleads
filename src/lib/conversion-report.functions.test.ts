// PG1 Task 7, fix round 1 — covers the two findings on the campaign SMS
// cost: averageBilledSegments's math, and selectAllPages actually paging
// past PostgREST's 1000-row cap (the bug that silently undercounted cost
// for campaigns with over 1000 accepted SMS).
import { describe, expect, it } from "vitest";
import { averageBilledSegments, selectAllPages } from "./conversion-report.functions";

describe("averageBilledSegments", () => {
  it("counts a null billed_units as 1 segment", () => {
    expect(averageBilledSegments([{ billed_units: null }])).toBe(1);
  });

  it("returns 1 when there are no rows at all (never 0, never NaN)", () => {
    expect(averageBilledSegments([])).toBe(1);
  });

  it("averages mixed billed_units, null defaulting to 1", () => {
    expect(
      averageBilledSegments([{ billed_units: 2 }, { billed_units: 1 }, { billed_units: 3 }]),
    ).toBe(2);
    expect(
      averageBilledSegments([{ billed_units: 2 }, { billed_units: null }, { billed_units: 2 }]),
    ).toBeCloseTo(5 / 3, 10);
  });
});

/** Fake PostgREST-ish query builder: `.gt(id)` + `.order` + `.limit(n)`, each
 * page returning at most `n` rows from an in-memory array, exactly like the
 * real `.range`/`.limit` cap selectAllPages works around. */
function fakePagedQuery(allRows: Array<{ id: string; billed_units: number | null }>) {
  let afterId: string | null = null;
  const builder = {
    gt(_column: string, value: string) {
      afterId = value;
      return builder;
    },
    order(_column: string, _opts: unknown) {
      return builder;
    },
    limit(size: number) {
      const startIndex = afterId ? allRows.findIndex((row) => row.id === afterId) + 1 : 0;
      const page = allRows.slice(startIndex, startIndex + size);
      return Promise.resolve({ data: page, error: null });
    },
  };
  return builder;
}

describe("selectAllPages", () => {
  it("returns every row of a 1200-row set, past PostgREST's 1000-row cap", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      id: String(index + 1).padStart(6, "0"),
      billed_units: 2,
    }));

    const result = await selectAllPages<{ id: string; billed_units: number | null }>(
      "test:campaign_billed_units",
      () => fakePagedQuery(rows),
    );

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1200);
    expect(result.truncated).toBe(false);
    // The bug this covers: cost silently undercounted because only the
    // first 1000 rows were ever fetched.
    expect(averageBilledSegments(result.data)).toBe(2);
  });

  it("stops at a single page when there are fewer rows than the page size", async () => {
    const rows = [{ id: "a", billed_units: 3 }];

    const result = await selectAllPages<{ id: string; billed_units: number | null }>(
      "test:small",
      () => fakePagedQuery(rows),
    );

    expect(result.data).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
