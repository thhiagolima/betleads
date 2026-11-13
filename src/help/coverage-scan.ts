// Pure text-scanning helpers for -coverage.test.ts. Kept separate from the
// test file (which does the `fs` walking) so the regexes themselves are
// unit-testable without touching the filesystem.

const TOUR_ANCHOR_CALL_RE = /tourAnchor\("([^"]+)"\)/g;
const RAW_DATA_TOUR_RE = /data-tour\s*=/g;
const TERM_ID_RE = /<Term\s+id="([^"]+)"/g;

function matchAll(source: string, re: RegExp): string[] {
  const regex = new RegExp(re.source, re.flags);
  const out: string[] = [];
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(source))) out.push(match[1]);
  return out;
}

/** Every id passed to the `tourAnchor` helper call in a source file. */
export function extractTourAnchorCalls(source: string): string[] {
  return matchAll(source, TOUR_ANCHOR_CALL_RE);
}

/** How many times the raw tour-anchor HTML attribute appears written by
 * hand (should be 0 outside src/help/anchor.ts — spec §6 rule 2,
 * constraints.md "Âncoras"). */
export function countRawDataTourUsages(source: string): number {
  return (source.match(RAW_DATA_TOUR_RE) ?? []).length;
}

/** Every id passed to a `Term` component's `id` prop in a source file. */
export function extractTermIds(source: string): string[] {
  return matchAll(source, TERM_ID_RE);
}

/** `*.test.*` files are left out of the coverage scan (brief, Task 2). */
export function isTestFile(filename: string): boolean {
  return filename.includes(".test.");
}

const CHIP_TAG_RE = /<([A-Z][A-Za-z0-9]*Chip)\b/g;

/** Reads a `{…}` expression starting at `source[open] === "{"`; returns the
 * index just past its matching `}` (or the source length if unbalanced). */
function skipBraces(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Names of `*Chip` components (RuleChip, FilterChip, …) whose `label={…}`
 * prop contains a `<Term`. Those chips render their label inside a
 * `<button>`, and `<Term>` renders its own `<button>` — a button inside a
 * button is invalid HTML and tapping the "i" toggles the chip. Put the Term
 * next to the chip (or in the group's title/help) instead.
 */
export function findTermInsideChipLabel(source: string): string[] {
  const out: string[] = [];
  const tagRe = new RegExp(CHIP_TAG_RE.source, CHIP_TAG_RE.flags);
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = tagRe.exec(source))) {
    // Walk the opening tag up to its closing ">" outside any `{…}`.
    let i = match.index + match[0].length;
    while (i < source.length && source[i] !== ">") {
      if (source[i] === "{") {
        const end = skipBraces(source, i);
        if (/\blabel\s*=\s*$/.test(source.slice(match.index, i)) && source.slice(i, end).includes("<Term")) {
          out.push(match[1]);
        }
        i = end;
      } else {
        i++;
      }
    }
  }
  return out;
}

const WRAPPED_PERIOD_PICKER_RE = /<div\s+\{\.\.\.tourAnchor\("([^"]+)"\)\}\s*>\s*<CentralPeriodPicker\b/g;

/** Anchors put on a plain `<div>` wrapping a `CentralPeriodPicker`. As a
 * flex item (a PageHeader's actions) that wrapper keeps the picker's
 * min-content width, so on a phone the picker overflows instead of
 * scrolling inside itself: pass the anchor to the picker (its `data-tour`
 * passthrough) instead. */
export function findAnchorWrappedPeriodPicker(source: string): string[] {
  return matchAll(source, WRAPPED_PERIOD_PICKER_RE);
}

const LABEL_TAG_RE = /<(label|Label)(?=[\s>])/g;

/**
 * `<label>`/`<Label>` elements without `htmlFor` that contain a `<Term`
 * between their opening and closing tag (same source chunk). Without
 * `htmlFor`, a label labels its first labelable descendant — and `<Term>`
 * renders a `<button>`, so the Term steals the label from the field (the
 * input loses its accessible name, and clicking the text focuses the "i").
 * Give the field an `id` and the label `htmlFor`, or take the Term out.
 * Returns one "<tag>@<line>" per offender.
 */
export function findTermInsideLabelWithoutFor(source: string): string[] {
  const out: string[] = [];
  const tagRe = new RegExp(LABEL_TAG_RE.source, LABEL_TAG_RE.flags);
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = tagRe.exec(source))) {
    const tag = match[1];
    // Walk the opening tag up to its closing ">" outside any `{…}`.
    let i = match.index + match[0].length;
    while (i < source.length && source[i] !== ">") {
      i = source[i] === "{" ? skipBraces(source, i) : i + 1;
    }
    const openTag = source.slice(match.index, i);
    if (openTag.endsWith("/")) continue; // self-closing: no children
    if (/\bhtmlFor\s*=/.test(openTag)) continue;
    const close = source.indexOf(`</${tag}>`, i);
    if (close === -1) continue;
    if (source.slice(i, close).includes("<Term")) {
      const line = source.slice(0, match.index).split("\n").length;
      out.push(`${tag}@${line}`);
    }
  }
  return out;
}

const TERM_NEXT_TO_INFOTIP_RE = /<\/Term>\s*<InfoTip\b|<InfoTip\b[^>]*\/>\s*<Term\b/g;

/** How many `<Term>`s sit right next to an `<InfoTip>` (the "i" tooltip
 * that already explains the label): two "i" side by side. A label that
 * already has an explanation tooltip doesn't get a `<Term>` — keep the
 * term id in the article's `terms` instead (ruling R17, generalized). */
export function countTermNextToInfoTip(source: string): number {
  return (source.match(TERM_NEXT_TO_INFOTIP_RE) ?? []).length;
}
