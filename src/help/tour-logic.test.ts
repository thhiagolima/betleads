// Pure tour-engine logic (brief, Task 3). No DOM: that part lives in
// tour-runner.ts and isn't unit-tested here (no jsdom in this repo).
import { describe, expect, it } from "vitest";
import type { HelpScreen } from "./types";
import {
  AUTO_START_SUPPRESS_PENDING_MS,
  effectiveOverlayForAutoStart,
  filterAvailableSteps,
  isAutoStartSuppressed,
  nextAutoStartSuppression,
  pickHelpTarget,
  pickVisible,
  sameHelpTarget,
  shouldAutoStart,
  startAutoStartSuppression,
  tourFor,
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

describe("effectiveOverlayForAutoStart", () => {
  const base = { overlayActive: false, panelOpen: false, isOverrideScreen: false };

  it("passes overlayActive through when this isn't the override screen", () => {
    expect(effectiveOverlayForAutoStart({ ...base, overlayActive: true })).toBe(true);
    expect(effectiveOverlayForAutoStart({ ...base, overlayActive: false })).toBe(false);
  });

  it("ignores overlayActive for the override screen itself (its own tour may auto-start)", () => {
    expect(
      effectiveOverlayForAutoStart({ ...base, overlayActive: true, isOverrideScreen: true }),
    ).toBe(false);
  });

  it("still blocks the override screen while the help panel is open", () => {
    expect(
      effectiveOverlayForAutoStart({ ...base, isOverrideScreen: true, panelOpen: true }),
    ).toBe(true);
  });

  it("blocks a non-override screen while the panel is open, even without an overlay", () => {
    expect(effectiveOverlayForAutoStart({ ...base, panelOpen: true })).toBe(true);
  });
});

describe("tourFor", () => {
  const step = (anchor: string) => ({ anchor, title: "t", body: "b" });
  const screen: HelpScreen = {
    id: "x",
    route: "/x",
    title: "X",
    purpose: "p",
    roles: ["admin"],
    sections: [],
    states: [],
    tours: { default: [step("x.a.b")], email: [step("x.email.c")] },
  };

  it("uses the tab's own tour when it has one", () => {
    expect(tourFor(screen, "email")).toEqual({ tourTab: "email", steps: [step("x.email.c")] });
  });

  it("falls back to the default tour for a tab with no tour of its own", () => {
    expect(tourFor(screen, "outra")).toEqual({ tourTab: null, steps: [step("x.a.b")] });
    expect(tourFor(screen, null)).toEqual({ tourTab: null, steps: [step("x.a.b")] });
  });

  // Ruling R11: a tab with no tour of its own, on a screen with no "default"
  // either (e.g. /webhooks#plataforma, with only the "links" tab tour from
  // Task 15), must resolve to no steps at all — the panel's "Fazer o tour
  // desta tela" relies on exactly this to stay hidden on that tab, even
  // though the screen as a whole does have a tour (on another tab).
  it("has no steps when neither the tab nor \"default\" has a tour", () => {
    const noDefault: HelpScreen = { ...screen, tours: { links: [step("x.links.a")] } };
    expect(tourFor(noDefault, "plataforma")).toEqual({ tourTab: null, steps: [] });
    expect(tourFor({ ...screen, tours: {} }, null)).toEqual({ tourTab: null, steps: [] });
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

describe("sameHelpTarget / pickHelpTarget", () => {
  const casa = { route: "/configuracoes/casa", tab: null };
  const onboarding = { route: "onboarding", tab: "email" };
  const shell = { route: "shell", tab: null };

  it("compares route and tab", () => {
    expect(sameHelpTarget(casa, { route: "/configuracoes/casa", tab: null })).toBe(true);
    expect(sameHelpTarget(casa, { route: "/configuracoes/casa", tab: "email" })).toBe(false);
    expect(sameHelpTarget(null, null)).toBe(true);
    expect(sameHelpTarget(casa, null)).toBe(false);
  });

  it('"Sobre o CRM" wins while open; closing it goes back to the onboarding override, not to the URL', () => {
    expect(pickHelpTarget(shell, onboarding, casa)).toBe(shell);
    expect(pickHelpTarget(null, onboarding, casa)).toBe(onboarding);
    expect(pickHelpTarget(null, null, casa)).toBe(casa);
  });
});

describe("auto-start suppression after a highlight", () => {
  const origin = { route: "/campanhas", tab: null };
  const dest = { route: "/configuracoes/casa", tab: "email" };
  const t0 = 1_000_000;

  it("suppresses the destination's auto-start once the guide navigation lands there", () => {
    let s = startAutoStartSuppression(dest, origin, t0);
    expect(s.reached).toBe(false);
    expect(isAutoStartSuppressed(s, origin)).toBe(false);
    // Intermediate render: path changed, hash not yet.
    s = nextAutoStartSuppression(s, { route: dest.route, tab: null }, t0 + 10)!;
    expect(s).not.toBeNull();
    s = nextAutoStartSuppression(s, dest, t0 + 20)!;
    expect(s.reached).toBe(true);
    expect(isAutoStartSuppressed(s, dest)).toBe(true);
  });

  it("is reached immediately for a highlight on the current screen (mostrar na tela)", () => {
    const s = startAutoStartSuppression(origin, origin, t0);
    expect(s.reached).toBe(true);
    expect(isAutoStartSuppressed(s, origin)).toBe(true);
  });

  it("covers only that visit: leaving the reached destination drops it", () => {
    const s = startAutoStartSuppression(origin, origin, t0);
    expect(nextAutoStartSuppression(s, dest, t0 + 5)).toBeNull();
  });

  it("drops an unreached destination after the pending window", () => {
    const s = startAutoStartSuppression(dest, origin, t0);
    expect(nextAutoStartSuppression(s, origin, t0 + AUTO_START_SUPPRESS_PENDING_MS + 1)).toBeNull();
    expect(nextAutoStartSuppression(null, dest, t0)).toBeNull();
    expect(isAutoStartSuppressed(null, dest)).toBe(false);
  });
});
