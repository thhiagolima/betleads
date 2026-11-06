// Pure open/close decision for <Term>'s popover (fix round 1). Kept separate
// from term.tsx so the mouse-vs-touch logic is unit-testable without
// rendering anything: on desktop, hover opens and a click should never
// re-close what hover just opened (a click right after hover was closing the
// popover the user had just opened); on touch there's no hover, so a tap
// has to both open and close it.
export type TermOpenEvent =
  | { type: "hover-enter" }
  | { type: "hover-leave" }
  | { type: "pointerdown"; pointerType: "mouse" | "touch" | "pen" };

/** Whether a click on the trigger should be left to Radix's own toggle.
 * A keyboard activation (Enter/Space) fires a click with `detail === 0`
 * and no pointerdown: Radix toggles it. A pointer click (`detail >= 1`) was
 * already decided by the pointerdown via `nextTermOpen`, so Radix's toggle
 * is blocked. Decided per event — no flag that a pointerdown without a
 * click (drag off, pointercancel, touch scroll) could leave stuck. */
export function clickLetsRadixToggle(detail: number): boolean {
  return detail === 0;
}

export function nextTermOpen(open: boolean, event: TermOpenEvent): boolean {
  switch (event.type) {
    case "hover-enter":
      return true;
    case "hover-leave":
      return false;
    case "pointerdown":
      // Mouse: a click only ever opens (or keeps open) — never closes what
      // hover opened. Touch/pen have no hover, so a tap toggles.
      return event.pointerType === "mouse" ? true : !open;
  }
}
