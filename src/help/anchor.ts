// The ONLY place that writes the `data-tour` attribute. Every tour/help
// anchor in the app goes through this helper instead of a hand-written
// `data-tour="..."`, so -coverage.test.ts can enforce it statically (spec
// §4.2, §6 rule 2/3) and so a stray typo doesn't silently create an anchor
// nothing points at, or vice-versa.
//
// Format: "<tela>.<secao>.<elemento>", lowercase, hyphen inside each part
// (e.g. "casa.email.dns-table"). On a control that repeats per row, apply
// this only to the first row's element.
export function tourAnchor(id: string): { "data-tour": string } {
  return { "data-tour": id };
}

// The HTML attribute name itself, exported so tour-runner.ts can build a
// `[data-tour="…"]` selector without the literal string "data-tour=" in its
// own source (-coverage.test.ts forbids that literal outside this file).
export const ANCHOR_ATTR = "data-tour";
