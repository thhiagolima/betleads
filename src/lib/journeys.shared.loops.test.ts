import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LOOPS,
  MAX_LOOPS_LIMIT,
  endStepMaxLoops,
  journeyStepInputSchema,
} from "./journeys.shared";

describe("endStepMaxLoops", () => {
  it("defaults to DEFAULT_MAX_LOOPS when unset or invalid", () => {
    expect(DEFAULT_MAX_LOOPS).toBe(2);
    for (const config of [
      undefined,
      null,
      {},
      { max_loops: -1 },
      { max_loops: 1.5 },
      { max_loops: "x" },
      { max_loops: MAX_LOOPS_LIMIT + 1 },
    ]) {
      expect(endStepMaxLoops(config as Record<string, unknown> | null | undefined)).toBe(2);
    }
  });

  it("uses a valid configured value, including 0", () => {
    expect(endStepMaxLoops({ max_loops: 0 })).toBe(0);
    expect(endStepMaxLoops({ max_loops: 7 })).toBe(7);
    expect(endStepMaxLoops({ max_loops: MAX_LOOPS_LIMIT })).toBe(MAX_LOOPS_LIMIT);
  });

  it("the step schema rejects a max_loops above the limit", () => {
    const end = (max_loops: number) =>
      journeyStepInputSchema.safeParse({
        step_type: "end",
        config: { loop_to_position: 0, max_loops },
      }).success;
    expect(end(3)).toBe(true);
    expect(end(MAX_LOOPS_LIMIT + 1)).toBe(false);
  });
});
