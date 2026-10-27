import { describe, expect, it } from "vitest";

import { goalInputToValue, goalValueToInput, isPercentGoal } from "./goal-units";

describe("goal units", () => {
  it("ROI is typed in % and stored as a fraction", () => {
    expect(isPercentGoal("roi")).toBe(true);
    expect(goalInputToValue("roi", "30")).toBe(0.3);
    expect(goalInputToValue("roi", "12.5")).toBe(0.125);
    expect(goalValueToInput("roi", 0.3)).toBe("30");
    expect(goalValueToInput("roi", 0.125)).toBe("12.5");
  });

  it("other metrics keep their own unit", () => {
    expect(isPercentGoal("ftds")).toBe(false);
    expect(goalInputToValue("ftds", "30")).toBe(30);
    expect(goalValueToInput("cost_per_ftd", 90.5)).toBe("90.5");
  });

  it("empty input removes the goal and a missing goal is empty", () => {
    expect(goalInputToValue("roi", " ")).toBeNull();
    expect(goalValueToInput("roi", null)).toBe("");
  });
});
