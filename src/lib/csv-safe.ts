/**
 * Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR at the
 * start) gets a leading apostrophe. Names and other free text come from the
 * houses' webhooks, so they are untrusted. Numbers are left alone so negative
 * values stay numeric.
 */
export function neutralizeCsvFormula(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return String(value);
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
