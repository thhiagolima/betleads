import { describe, expect, it } from "vitest";

import { acceptTooltipOpen } from "./term-tooltip";

describe("acceptTooltipOpen", () => {
  it("always accepts closing", () => {
    expect(acceptTooltipOpen(false, { focused: true, focusVisible: false, hovered: false })).toBe(
      true,
    );
  });

  it("ignores an open from programmatic focus (dialog auto-focus, no keyboard)", () => {
    expect(acceptTooltipOpen(true, { focused: true, focusVisible: false, hovered: false })).toBe(
      false,
    );
  });

  it("opens on keyboard focus and on hover", () => {
    expect(acceptTooltipOpen(true, { focused: true, focusVisible: true, hovered: false })).toBe(
      true,
    );
    expect(acceptTooltipOpen(true, { focused: false, focusVisible: false, hovered: true })).toBe(
      true,
    );
    expect(acceptTooltipOpen(true, { focused: true, focusVisible: false, hovered: true })).toBe(
      true,
    );
  });
});
