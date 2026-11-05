// Pure tour-engine logic (brief, Task 3). No DOM: that part lives in
// tour-runner.ts and isn't unit-tested here (no jsdom in this repo).
import { describe, expect, it } from "vitest";
import type { HelpScreen } from "./types";
import { AUTO_TOURS_OFF_KEY, tourKey } from "@/lib/help-progress";
import { HELP_SCREEN_LOADERS } from "./registry";
import { effectiveTab } from "./resolve";
import {
  AUTO_START_SUPPRESS_PENDING_MS,
  autoStartDecision,
  effectiveOverlayForAutoStart,
  filterAvailableSteps,
  isAutoStartSuppressed,
  nextAutoStartSuppression,
  nextReadinessClock,
  pickHelpTarget,
  pickVisible,
  sameHelpTarget,
  screenTourKey,
  shouldAutoStart,
  startAutoStartSuppression,
  TOUR_READY_DEADLINE_MS,
  tourFor,
  tourReadiness,
  tourResultFromReason,
} from "./tour-logic";

describe("autoStartDecision", () => {
  const base = {
    key: "tour:/campanhas",
    progress: {} as Record<string, string>,
    dialogOpen: false,
    overlayActive: false,
    hasSteps: true,
  };
  type In = Parameters<typeof autoStartDecision>[0];
  const decide = (over: Partial<In>) => autoStartDecision({ ...base, ...over } as In);

  it('"start" on a first visit with nothing in the way', () => {
    expect(decide({})).toBe("start");
  });

  it('"never" for permanent reasons: done, skipped, auto-tours off, no steps', () => {
    expect(decide({ progress: { "tour:/campanhas": "done" } })).toBe("never");
    expect(decide({ progress: { "tour:/campanhas": "skipped" } })).toBe("never");
    expect(decide({ progress: { [AUTO_TOURS_OFF_KEY]: "off" } })).toBe("never");
    expect(decide({ hasSteps: false })).toBe("never");
  });

  it('"wait" for transient reasons: progress not loaded, dialog open, overlay/panel active', () => {
    expect(decide({ progress: null })).toBe("wait");
    expect(decide({ dialogOpen: true })).toBe("wait");
    expect(decide({ overlayActive: true })).toBe("wait");
  });

  it("a permanent reason wins over a transient one", () => {
    expect(decide({ dialogOpen: true, progress: { "tour:/campanhas": "done" } })).toBe("never");
    expect(decide({ overlayActive: true, hasSteps: false })).toBe("never");
  });

  it("shouldAutoStart is exactly autoStartDecision === \"start\"", () => {
    const cases: Partial<In>[] = [
      {},
      { progress: null },
      { dialogOpen: true },
      { overlayActive: true },
      { hasSteps: false },
      { progress: { "tour:/campanhas": "done" } },
    ];
    for (const c of cases) expect(shouldAutoStart({ ...base, ...c } as In)).toBe(decide(c) === "start");
  });
});

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

describe("screenTourKey", () => {
  it("both journey editor routes resolve to the same tour progress key", async () => {
    const nova = (await HELP_SCREEN_LOADERS["/jornadas/nova"]()).default;
    const edit = (await HELP_SCREEN_LOADERS["/jornadas/$journeyId"]()).default;
    expect(edit.route).toBe("/jornadas/$journeyId");
    const novaKey = screenTourKey(nova, tourFor(nova, null).tourTab);
    expect(novaKey).toBe("tour:/jornadas/nova");
    expect(screenTourKey(edit, tourFor(edit, null).tourTab)).toBe(novaKey);
  });

  it("keeps every other screen's key byte-identical to tourKey(route, tab)", async () => {
    const casa = (await HELP_SCREEN_LOADERS["/configuracoes/casa"]()).default;
    expect(screenTourKey(casa, "email")).toBe("tour:/configuracoes/casa#email");
    expect(screenTourKey(casa, tourFor(casa, effectiveTab(casa, null)).tourTab)).toBe(
      "tour:/configuracoes/casa#casa",
    );
    for (const [key, load] of Object.entries(HELP_SCREEN_LOADERS)) {
      if (key === "/jornadas/$journeyId") continue;
      const screen = (await load()).default;
      for (const tab of Object.keys(screen.tours)) {
        const tourTab = tab === "default" ? null : tab;
        expect(screenTourKey(screen, tourTab)).toBe(tourKey(screen.route, tourTab));
      }
    }
  });
});

describe("tourReadiness", () => {
  const at = (over: Partial<Parameters<typeof tourReadiness>[0]>) =>
    tourReadiness({ totalSteps: 6, availableSteps: 6, firstAvailable: true, elapsedMs: 1000, ...over });

  it('"start" once the first anchor is visible and at least min(3, total) steps are available', () => {
    expect(at({})).toBe("start");
    expect(at({ availableSteps: 3 })).toBe("start");
    expect(at({ totalSteps: 2, availableSteps: 2 })).toBe("start");
    expect(at({ totalSteps: 1, availableSteps: 1 })).toBe("start");
  });

  it('"wait" while the screen is still rendering its anchors, before the deadline', () => {
    expect(at({ availableSteps: 0, firstAvailable: false })).toBe("wait");
    expect(at({ availableSteps: 2 })).toBe("wait");
    expect(at({ availableSteps: 5, firstAvailable: false })).toBe("wait");
    expect(at({ availableSteps: 2, elapsedMs: TOUR_READY_DEADLINE_MS - 1 })).toBe("wait");
  });

  it("after the deadline, starts with whatever is visible, or gives up when nothing is", () => {
    expect(at({ availableSteps: 1, firstAvailable: false, elapsedMs: TOUR_READY_DEADLINE_MS })).toBe(
      "start",
    );
    expect(at({ availableSteps: 0, firstAvailable: false, elapsedMs: TOUR_READY_DEADLINE_MS })).toBe(
      "giveup",
    );
  });

  it('a tour with no steps is "giveup"', () => {
    expect(at({ totalSteps: 0, availableSteps: 0, firstAvailable: false })).toBe("giveup");
  });
});

describe("nextReadinessClock", () => {
  it('starts on the first "start" and keeps that origin while it stays "start"', () => {
    expect(nextReadinessClock(null, "start", 5000)).toBe(5000);
    expect(nextReadinessClock(5000, "start", 9000)).toBe(5000);
  });

  it('is dropped on "wait" and "never", so blocked time never counts against the deadline', () => {
    expect(nextReadinessClock(5000, "wait", 9000)).toBeNull();
    expect(nextReadinessClock(null, "wait", 9000)).toBeNull();
    expect(nextReadinessClock(5000, "never", 9000)).toBeNull();
  });

  it("a long onboarding wait followed by start gets the full readiness window", () => {
    let clock: number | null = null;
    clock = nextReadinessClock(clock, "wait", 0); // wizard showing
    clock = nextReadinessClock(clock, "wait", 60_000);
    clock = nextReadinessClock(clock, "start", 61_000); // wizard closed
    expect(clock).toBe(61_000);
    expect(
      tourReadiness({ totalSteps: 6, availableSteps: 1, firstAvailable: false, elapsedMs: 62_000 - clock! }),
    ).toBe("wait");
  });
});
