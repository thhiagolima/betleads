import { describe, expect, it } from "vitest";

import { depositCountFor } from "./player-deposit-count";

describe("depositCountFor", () => {
  it("uses the larger of approved rows and the imported count", () => {
    expect(
      depositCountFor({ approvedCount: 2, importedRawPayload: { normalized: { depositos: 5 } } }),
    ).toBe(5);
    expect(
      depositCountFor({ approvedCount: 7, importedRawPayload: { normalized: { depositos: 5 } } }),
    ).toBe(7);
  });

  it("falls back to raw.depositos when normalized has none", () => {
    expect(
      depositCountFor({ approvedCount: 0, importedRawPayload: { raw: { depositos: "4" } } }),
    ).toBe(4);
    expect(
      depositCountFor({
        approvedCount: 0,
        importedRawPayload: { normalized: {}, raw: { depositos: 3 } },
      }),
    ).toBe(3);
  });

  it("ignores missing or non-numeric imported values", () => {
    expect(depositCountFor({ approvedCount: 1, importedRawPayload: null })).toBe(1);
    expect(depositCountFor({ approvedCount: 1, importedRawPayload: "x" })).toBe(1);
    expect(
      depositCountFor({
        approvedCount: 1,
        importedRawPayload: { normalized: { depositos: "abc" } },
      }),
    ).toBe(1);
  });
});
