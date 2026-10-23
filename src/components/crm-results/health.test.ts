import { describe, expect, it } from "vitest";

import { agoLabel } from "./health";

describe("agoLabel", () => {
  it("uses minutes, hours and days", () => {
    expect(agoLabel(12)).toBe("12 min");
    expect(agoLabel(180)).toBe("3 h");
    expect(agoLabel(6000)).toBe("4 dias");
  });
});
