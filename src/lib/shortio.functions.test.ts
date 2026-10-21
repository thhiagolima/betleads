import { describe, expect, it } from "vitest";

import { overviewFromRows } from "./shortio.functions";

describe("overviewFromRows", () => {
  it("turns the RPC bigints into numbers and sums the totals", () => {
    const out = overviewFromRows([
      { channel: "sms", source_type: "campaign", sent: "90958", links: "90958", clicks: "2836" },
      { channel: "sms", source_type: "journey", sent: "67493", links: "67493", clicks: "1429" },
    ]);
    expect(out.sent).toBe(158451);
    expect(out.clicks).toBe(4265);
    expect(out.rows[0]).toMatchObject({ sourceType: "campaign", sent: 90958, links: 90958 });
    expect(out.rows[0].ctr).toBeCloseTo(2836 / 90958);
  });

  it("handles no dispatches", () => {
    expect(overviewFromRows([])).toEqual({ rows: [], sent: 0, clicks: 0 });
  });
});
