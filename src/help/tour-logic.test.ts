// Pure tour-engine logic (brief, Task 3). No DOM: that part lives in
// tour-runner.ts and isn't unit-tested here (no jsdom in this repo).
import { describe, expect, it } from "vitest";
import {
  filterAvailableSteps,
  pickVisible,
  shouldAutoStart,
  tourResultFromReason,
} from "./tour-logic";

describe("shouldAutoStart", () => {
  const base = {
    key: "tour:/campanhas",
    progress: {},
    dialogOpen: false,
    overlayActive: false,
    hasSteps: true,
  };

  it("starts on a first visit with nothing in the way", () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  it("does not start when progress couldn't be read", () => {
    expect(shouldAutoStart({ ...base, progress: null })).toBe(false);
  });

  it("does not start when this tour was already skipped", () => {
    expect(shouldAutoStart({ ...base, progress: { "tour:/campanhas": "skipped" } })).toBe(false);
  });

  it("does not start when this tour was already done", () => {
    expect(shouldAutoStart({ ...base, progress: { "tour:/campanhas": "done" } })).toBe(false);
  });

  it("does not start when auto-tours are turned off", () => {
    expect(shouldAutoStart({ ...base, progress: { "prefs:auto-tours": "off" } })).toBe(false);
  });

  it("does not start while a dialog is open", () => {
    expect(shouldAutoStart({ ...base, dialogOpen: true })).toBe(false);
  });

  it("does not start while an overlay is active", () => {
    expect(shouldAutoStart({ ...base, overlayActive: true })).toBe(false);
  });

  it("does not start when the screen has no tour steps", () => {
    expect(shouldAutoStart({ ...base, hasSteps: false })).toBe(false);
  });
});

describe("pickVisible", () => {
  it("returns the first candidate that passes the visibility test", () => {
    expect(pickVisible(["hidden", "shown"], (c) => c === "shown")).toBe("shown");
  });

  it("returns null when nothing is visible", () => {
    expect(pickVisible(["hidden"], () => false)).toBeNull();
  });
});

describe("filterAvailableSteps", () => {
  it("keeps only steps whose anchor resolves to a visible element", () => {
    const steps = [
      { anchor: "a", title: "", body: "x" },
      { anchor: "b", title: "", body: "y" },
    ];
    const result = filterAvailableSteps(steps, (anchor) => (anchor === "b" ? {} : null));
    expect(result.map((s) => s.anchor)).toEqual(["b"]);
  });
});

describe("tourResultFromReason", () => {
  it('is "done" only for driver.js\'s "done" reason', () => {
    expect(tourResultFromReason("done")).toBe("done");
  });

  it.each(["close", "escape", "overlay", "replaced", "api", undefined])(
    '"%s" is "skipped"',
    (reason) => {
      expect(tourResultFromReason(reason)).toBe("skipped");
    },
  );
});
