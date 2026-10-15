import { describe, expect, it } from "vitest";

import { fromBrtInput, smsExtra, toBrtInput } from "./journey-editor-config";

describe("journey editor config helpers", () => {
  it("keeps the SMS config keys the editor does not manage", () => {
    expect(
      smsExtra({
        content: "a",
        template_id: "t",
        template_snapshot: { id: "t" },
        track_links: true,
        variants: ["a", "b"],
      }),
    ).toEqual({ track_links: true, variants: ["a", "b"] });
  });

  it("round-trips the end date in Brasília time", () => {
    expect(toBrtInput("2026-10-20T02:30:00.000Z")).toBe("2026-10-19T23:30");
    expect(fromBrtInput("2026-10-19T23:30")).toBe("2026-10-20T02:30:00.000Z");
    expect(fromBrtInput(toBrtInput("2026-12-31T23:59:00.000Z"))).toBe("2026-12-31T23:59:00.000Z");
  });

  it("treats an empty or invalid date as no end date", () => {
    expect(toBrtInput(null)).toBe("");
    expect(toBrtInput("not a date")).toBe("");
    expect(fromBrtInput("")).toBeNull();
  });
});
