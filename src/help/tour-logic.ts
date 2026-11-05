// Pure tour-engine logic (brief, Task 3). No DOM here: the driver.js wrapper
// and anything that touches `document` lives in tour-runner.ts, which is
// only ever loaded via `import()` from a HelpProvider (Task 4).
import { AUTO_TOURS_OFF_KEY, tourKey, type HelpProgressMap } from "@/lib/help-progress";
import type { HelpScreen, TourStep } from "./types";

/** Which tour of `screen` applies to `tab`: the tab's own, else "default".
 * Pure so both the provider (`startTour`/auto-start) and the panel (ruling
 * R11: whether "Fazer o tour desta tela" shows for the *current* tab) agree
 * on the exact same resolution — a tab with no tour of its own, and no
 * "default", has no tour, even when another tab of the same screen does. */
export function tourFor(
  screen: HelpScreen,
  tab: string | null,
): { tourTab: string | null; steps: TourStep[] } {
  if (tab && screen.tours[tab]) return { tourTab: tab, steps: screen.tours[tab] };
  return { tourTab: null, steps: screen.tours.default ?? [] };
}

/** The `help_progress` key of `screen`'s tour for `tourTab` (from
 * `tourFor`): `tourKey(route, tab)`, using `screen.tourRoute` when the
 * article shares another route's progress. Every other screen keeps exactly
 * the key it always had (`tourKey(screen.route, tab)`). */
export function screenTourKey(screen: HelpScreen, tourTab: string | null): string {
  return tourKey(screen.tourRoute ?? screen.route, tourTab);
}

export type ShouldAutoStartInput = {
  /** `tourKey(route, tab)` for the screen/tab in question. */
  key: string;
  /** `null` when `help_progress` couldn't be read — auto-start stays off
   * (constraints.md "Início automático"). */
  progress: HelpProgressMap | null;
  /** A dialog is currently open: never auto-start on top of it. */
  dialogOpen: boolean;
  /** Some other overlay (drawer, modal, blocking state) is active. */
  overlayActive: boolean;
  /** Whether this screen/tab has any tour steps at all. */
  hasSteps: boolean;
};

export type AutoStartDecision = "start" | "never" | "wait";

/** The auto-start verdict for one tour key on this visit:
 * - "never": a permanent reason — the tour was already done/skipped, the
 *   user turned auto-tours off, or there are no steps. The caller marks the
 *   key checked for the visit.
 * - "wait": a transient reason — progress not loaded yet, a dialog open, an
 *   overlay (e.g. the onboarding status still loading) or the help panel
 *   covering the screen. The caller must NOT mark the key checked, so it
 *   retries once the condition clears.
 * - "start": first visit, nothing in the way.
 * Unknown progress is checked first (nothing permanent can be known
 * without it); permanent reasons win over transient ones. */
export function autoStartDecision(input: ShouldAutoStartInput): AutoStartDecision {
  if (input.progress === null) return "wait";
  if (!input.hasSteps) return "never";
  if (input.progress[AUTO_TOURS_OFF_KEY] === "off") return "never";
  if (input.progress[input.key] !== undefined) return "never";
  if (input.dialogOpen || input.overlayActive) return "wait";
  return "start";
}

/** Whether a tour should start on its own, on first visit — see
 * constraints.md "Início automático". Same as `autoStartDecision(...) ===
 * "start"`. */
export function shouldAutoStart(input: ShouldAutoStartInput): boolean {
  return autoStartDecision(input) === "start";
}

/**
 * What `overlayActive` to feed `shouldAutoStart` for the screen currently
 * showing. `setOverlayActive(true)` (onboarding-gate.tsx) is meant to stop
 * the *screen underneath* from auto-starting its tour while the overlay
 * covers it — but when the screen currently resolved is the override target
 * itself (the overlay's own content, via `setScreenOverride`), that overlay
 * flag must not block ITS tour too, or the wizard's own per-step tour could
 * never auto-start. The help panel being open still blocks either way.
 */
export function effectiveOverlayForAutoStart(input: {
  overlayActive: boolean;
  panelOpen: boolean;
  isOverrideScreen: boolean;
}): boolean {
  if (input.panelOpen) return true;
  if (input.isOverrideScreen) return false;
  return input.overlayActive;
}

/** Returns the first candidate that passes `isVisible`, or `null` if none
 * does. */
export function pickVisible<T>(candidates: T[], isVisible: (candidate: T) => boolean): T | null {
  for (const candidate of candidates) {
    if (isVisible(candidate)) return candidate;
  }
  return null;
}

/** Keeps only the steps whose anchor currently resolves to a visible
 * element — a step with a missing or hidden target is skipped in silence
 * (constraints.md "Tour"). */
export function filterAvailableSteps(
  steps: TourStep[],
  findVisible: (anchor: string) => unknown | null,
): TourStep[] {
  return steps.filter((step) => findVisible(step.anchor) !== null);
}

/** How long (since auto-start first got a "start" decision on this visit)
 * it waits for the tour's FIRST anchor to render. */
export const TOUR_READY_DEADLINE_MS = 15_000;
/** Once the first anchor is visible, how much longer it waits for
 * min(3, total) steps before starting with what is visible (a near-empty
 * tab may never render its other anchors). */
export const TOUR_READY_GRACE_MS = 2_500;

/** Whether a first-visit tour can start now, given how many of its steps
 * currently have a visible anchor. Screens render their anchors as their
 * data arrives, so a tour checked too early would show nothing (runTour
 * drops steps without a visible target):
 * - first step's anchor visible and at least min(3, total) steps available
 *   → "start";
 * - first step's anchor visible but fewer steps → "wait" up to
 *   `TOUR_READY_GRACE_MS` since it became visible (`firstVisibleMs`), then
 *   "start" with what is visible;
 * - first step's anchor not visible → "wait" until `TOUR_READY_DEADLINE_MS`
 *   (`elapsedMs`), then "start" with whatever is visible (≥1), else
 *   "giveup" — without recording progress, so the next visit tries again. */
export function tourReadiness(input: {
  totalSteps: number;
  availableSteps: number;
  firstAvailable: boolean;
  elapsedMs: number;
  /** How long the first step's anchor has been visible (0 when it just
   * appeared or isn't visible). */
  firstVisibleMs: number;
}): "start" | "wait" | "giveup" {
  const { totalSteps, availableSteps, firstAvailable, elapsedMs, firstVisibleMs } = input;
  if (totalSteps === 0) return "giveup";
  if (firstAvailable) {
    if (availableSteps >= Math.min(3, totalSteps)) return "start";
    return firstVisibleMs < TOUR_READY_GRACE_MS ? "wait" : "start";
  }
  if (elapsedMs < TOUR_READY_DEADLINE_MS) return "wait";
  return availableSteps >= 1 ? "start" : "giveup";
}

/** When the first step's anchor became visible (the origin of
 * `firstVisibleMs`): kept while it stays visible, dropped when it isn't. */
export function nextFirstVisibleClock(
  since: number | null,
  firstAvailable: boolean,
  now: number,
): number | null {
  if (!firstAvailable) return null;
  return since ?? now;
}

/** Wraps a tour's `onFinish` so it runs at most once, whatever path ends
 * the tour (the user's "Pular tour"/×/Escape/overlay/"Concluir", or
 * "Saiba mais"). */
export function finishOnce<T>(onFinish: (result: T) => void): (result: T) => void {
  let finished = false;
  return (result) => {
    if (finished) return;
    finished = true;
    onFinish(result);
  };
}

/** Auto-starts already claimed on the current page visit, kept outside
 * React state so a remounted HelpProvider (e.g. the auth gate re-rendering
 * after login) can't auto-start the same tour a second time on the same
 * visit. A new pathname starts a new visit. */
export type AutoStartVisit = { pathname: string; keys: ReadonlySet<string> };

/** Claims `key` for an auto-start on `pathname`: `claimed` is false when it
 * was already claimed on this same visit. */
export function claimAutoStart(
  visit: AutoStartVisit | null,
  pathname: string,
  key: string,
): { visit: AutoStartVisit; claimed: boolean } {
  const keys = visit && visit.pathname === pathname ? visit.keys : new Set<string>();
  if (keys.has(key)) return { visit: { pathname, keys }, claimed: false };
  return { visit: { pathname, keys: new Set(keys).add(key) }, claimed: true };
}

/** The readiness clock (`tourReadiness`' `elapsedMs` origin) after one
 * auto-start check: it starts the first time the decision is "start" and
 * is dropped whenever the decision goes back to "wait" (wizard, dialog,
 * panel) or "never" — time spent blocked must not count against the
 * deadline, or a tour shown right after the onboarding wizard would give up
 * or start truncated. */
export function nextReadinessClock(
  startedAt: number | null,
  decision: AutoStartDecision,
  now: number,
): number | null {
  if (decision !== "start") return null;
  return startedAt ?? now;
}

/** Maps driver.js's own `DestroyReason` to the tour's result: "done" only
 * when the user clicked "Concluir" on the last step (driver.js's "done"
 * reason); anything else — closing early, Escape, clicking the overlay, the
 * "Pular tour" button, or no reason at all — is "skipped". */
export function tourResultFromReason(reason: string | undefined): "done" | "skipped" {
  return reason === "done" ? "done" : "skipped";
}

/** A help target: a registry route (or virtual screen id) plus the raw tab
 * (URL hash without "#", or null). Same shape `resolveHelpScreen` returns. */
export type HelpTarget = { route: string; tab: string | null };

export function sameHelpTarget(a: HelpTarget | null, b: HelpTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.route === b.route && (a.tab ?? null) === (b.tab ?? null);
}

/** Which screen the help refers to: the "Sobre o CRM" article while it is
 * open (ruling R4), else the onboarding wizard's override, else the URL.
 * Kept as two separate overrides so closing "Sobre o CRM" goes back to the
 * wizard's article instead of dropping it. */
export function pickHelpTarget(
  shellOverride: HelpTarget | null,
  override: HelpTarget | null,
  urlTarget: HelpTarget | null,
): HelpTarget | null {
  return shellOverride ?? override ?? urlTarget;
}

/** How long a highlight's destination stays suppressed while the
 * navigation to it hasn't landed yet. */
export const AUTO_START_SUPPRESS_PENDING_MS = 10_000;

/** "Mostrar na tela" / a guide's "Ir para esta etapa" highlight an element
 * on a destination screen; that screen's own first-visit tour must not
 * auto-start on top of it (driver.js would replace the highlight). The
 * suppression covers that one visit: it holds from the click until the user
 * leaves the destination after reaching it. */
export type AutoStartSuppression = HelpTarget & {
  /** The URL already got to the destination. */
  reached: boolean;
  /** Until when an unreached destination is still waited for. */
  pendingUntil: number;
};

export function startAutoStartSuppression(
  destination: HelpTarget,
  urlTarget: HelpTarget | null,
  now: number,
): AutoStartSuppression {
  return {
    route: destination.route,
    tab: destination.tab ?? null,
    reached: sameHelpTarget(destination, urlTarget),
    pendingUntil: now + AUTO_START_SUPPRESS_PENDING_MS,
  };
}

/** The suppression after the URL target changed to `urlTarget`: marked
 * reached on arrival, dropped once the user leaves a reached destination,
 * and dropped when the destination was never reached in time (a failed or
 * abandoned navigation must not silence a later, unrelated visit). While
 * navigating, intermediate targets (path updated, hash not yet) keep it. */
export function nextAutoStartSuppression(
  suppression: AutoStartSuppression | null,
  urlTarget: HelpTarget | null,
  now: number,
): AutoStartSuppression | null {
  if (!suppression) return null;
  const here = sameHelpTarget(suppression, urlTarget);
  if (here) return suppression.reached ? suppression : { ...suppression, reached: true };
  if (suppression.reached) return null;
  return now > suppression.pendingUntil ? null : suppression;
}

/** Whether the auto-start check for `urlTarget` must be skipped. */
export function isAutoStartSuppressed(
  suppression: AutoStartSuppression | null,
  urlTarget: HelpTarget | null,
): boolean {
  return !!suppression && sameHelpTarget(suppression, urlTarget);
}
