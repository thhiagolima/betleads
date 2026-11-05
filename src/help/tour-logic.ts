// Pure tour-engine logic (brief, Task 3). No DOM here: the driver.js wrapper
// and anything that touches `document` lives in tour-runner.ts, which is
// only ever loaded via `import()` from a HelpProvider (Task 4).
import { AUTO_TOURS_OFF_KEY, type HelpProgressMap } from "@/lib/help-progress";
import type { TourStep } from "./types";

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

/** Whether a tour should start on its own, on first visit — see
 * constraints.md "Início automático". */
export function shouldAutoStart(input: ShouldAutoStartInput): boolean {
  if (input.progress === null) return false;
  if (input.dialogOpen) return false;
  if (input.overlayActive) return false;
  if (!input.hasSteps) return false;
  if (input.progress[AUTO_TOURS_OFF_KEY] === "off") return false;
  if (input.progress[input.key] !== undefined) return false;
  return true;
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

/** Maps driver.js's own `DestroyReason` to the tour's result: "done" only
 * when the user clicked "Concluir" on the last step (driver.js's "done"
 * reason); anything else — closing early, Escape, clicking the overlay, the
 * "Pular tour" button, or no reason at all — is "skipped". */
export function tourResultFromReason(reason: string | undefined): "done" | "skipped" {
  return reason === "done" ? "done" : "skipped";
}
