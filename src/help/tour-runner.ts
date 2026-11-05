// DOM + driver.js wrapper around tour-logic.ts (brief, Task 3). This module
// touches `document` and pulls in driver.js's CSS/JS, so it must only ever
// be reached through `import()` (Task 4's HelpProvider) — never imported at
// the top level, or driver.js would end up in the initial bundle
// (constraints.md "Carregamento").
import "driver.js/dist/driver.css";
import { driver, type Driver, type DriveStep } from "driver.js";
import { ANCHOR_ATTR } from "./anchor";
import { filterAvailableSteps, finishOnce, pickVisible, tourResultFromReason } from "./tour-logic";
import type { TourStep } from "./types";
import "./tour.css";

function anchorSelector(anchor: string): string {
  return `[${ANCHOR_ATTR}="${CSS.escape(anchor)}"]`;
}

/** `pickVisible` over every element matching the anchor, using
 * `getClientRects().length > 0` as the visibility test (brief). */
export function findVisibleAnchor(anchor: string): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(anchorSelector(anchor)));
  return pickVisible(candidates, (el) => el.getClientRects().length > 0);
}

// Only one driver.js instance at a time: a new highlight or tour first
// destroys the previous one, so rapid calls never stack overlays.
// A tour's result is recorded only from the user's own end of the tour
// (see runTour); an app teardown (route change, a new tour) just destroys
// it, which records nothing. `skip` records "skipped" for that tour.
let active: { instance: Driver; skip: () => void } | null = null;

/** Destroys the running tour/highlight, if any. With `record: true` a
 * running tour records "skipped" first ("Saiba mais"); by default nothing
 * is recorded. */
export function stopActiveTour(opts: { record?: boolean } = {}): void {
  const current = active;
  if (!current) return;
  active = null;
  if (opts.record) current.skip();
  current.instance.destroy();
}

/** Highlights a single element by its tour anchor (used by the help panel's
 * "Nesta tela" links). Returns `false` without doing anything if the anchor
 * isn't currently visible. */
export function highlightAnchor(anchor: string): boolean {
  const el = findVisibleAnchor(anchor);
  if (!el) return false;
  stopActiveTour();
  const instance = driver({
    onDestroyed: () => {
      if (active?.instance === instance) active = null;
    },
  });
  active = { instance, skip: () => {} };
  instance.highlight({ element: el });
  return true;
}

export type RunTourOptions = {
  onFinish: (result: "done" | "skipped") => void;
  onLearnMore: (step: TourStep) => void;
};

const LEARN_MORE_CLASS = "tour-learn-more-btn";
const SKIP_TOUR_CLASS = "tour-skip-btn";

/** Runs a guided tour over `steps`, skipping any step whose anchor isn't
 * currently visible (constraints.md "Tour"). Does nothing if that leaves no
 * steps at all — and then `onFinish` is never called, so no "done"/
 * "skipped" is recorded for a tour that never showed. Returns whether the
 * tour actually started. */
export function runTour(steps: TourStep[], opts: RunTourOptions): boolean {
  const available = filterAvailableSteps(steps, findVisibleAnchor);
  if (available.length === 0) return false;
  stopActiveTour();
  // Recorded once, from the user's own end of the tour: driver.js calls
  // `onDestroyStarted` (with the reason) for "Concluir", ×, Escape and an
  // overlay click — and never for an app-side `destroy()`. Not relying on
  // `onDestroyed`, which driver.js skips unless the first step's highlight
  // transition had fully completed.
  const finish = finishOnce(opts.onFinish);
  // A user-ended tour drops the `active` reference itself: driver.js's
  // `onDestroyed` (which also clears it) isn't guaranteed to run.
  const endByUser = () => {
    if (active?.instance === instance) active = null;
    instance.destroy();
  };

  const driveSteps: DriveStep[] = available.map((step) => ({
    element: anchorSelector(step.anchor),
    popover: {
      title: step.title,
      description: step.body,
    },
  }));

  // `closeBtnLabel` only sets the × icon's aria-label (driver.js has no
  // visible text there) — it does not make "Pular tour" visible to sighted
  // users, so a real footer button is added below via `onPopoverRender`,
  // alongside "Saiba mais". The × keeps its aria-label for screen readers.
  const instance = driver({
    steps: driveSteps,
    showProgress: true,
    progressText: "{{current}} de {{total}}",
    nextBtnText: "Próximo",
    prevBtnText: "Voltar",
    doneBtnText: "Concluir",
    closeBtnLabel: "Pular tour",
    smoothScroll: true,
    onPopoverRender: (popover, hookOpts) => {
      const activeIndex = hookOpts.state.activeIndex ?? 0;
      const activeStep = available[activeIndex];

      popover.footerButtons.querySelector(`.${LEARN_MORE_CLASS}`)?.remove();
      popover.footerButtons.querySelector(`.${SKIP_TOUR_CLASS}`)?.remove();

      const skipBtn = document.createElement("button");
      skipBtn.type = "button";
      skipBtn.className = `driver-popover-footer-btn ${SKIP_TOUR_CLASS}`;
      skipBtn.textContent = "Pular tour";
      skipBtn.addEventListener("click", () => {
        finish("skipped");
        endByUser();
      });
      popover.footerButtons.insertBefore(skipBtn, popover.footerButtons.firstChild);

      if (!activeStep) return;
      const learnMoreBtn = document.createElement("button");
      learnMoreBtn.type = "button";
      learnMoreBtn.className = `driver-popover-footer-btn ${LEARN_MORE_CLASS}`;
      learnMoreBtn.textContent = "Saiba mais";
      learnMoreBtn.addEventListener("click", () => opts.onLearnMore(activeStep));
      popover.footerButtons.insertBefore(learnMoreBtn, popover.footerButtons.firstChild);
    },
    onDestroyStarted: (_element, _step, hookOpts) => {
      finish(tourResultFromReason(hookOpts.reason));
      endByUser();
    },
    onDestroyed: () => {
      if (active?.instance === instance) active = null;
    },
  });

  active = { instance, skip: () => finish("skipped") };
  instance.drive();
  return true;
}
