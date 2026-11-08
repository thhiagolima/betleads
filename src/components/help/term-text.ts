// Pure helper for applying a <Term> to one part of a text that comes from
// elsewhere (e.g. a ROUTE_META title), without hard-coding the whole text
// at the call site.

/** Splits `text` around the first occurrence of `part` (case-sensitive), so
 * only that part gets wrapped in a `<Term>`. `null` when `text` doesn't
 * contain it — the caller then shows `text` as is, with no Term. */
export function splitTermText(
  text: string,
  part: string,
): { before: string; match: string; after: string } | null {
  if (!part) return null;
  const at = text.indexOf(part);
  if (at === -1) return null;
  return { before: text.slice(0, at), match: part, after: text.slice(at + part.length) };
}
