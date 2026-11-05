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
