/**
 * Parses a monetary amount sent by a house webhook.
 *
 * Accepts finite numbers and strings such as "10.5", "10,50", "R$ 10,50",
 * "1.234,56", "1,234.56", "1 234,56", "ARS 1.500", "-25,00". Negative values become
 * absolute (deposit/withdraw kind comes from the event, not the sign).
 *
 * Returns `null` when the value cannot be read as an amount (NaN, objects,
 * "abc", "1,2,3", "1.234.56" ...). Blank strings also return `null`: callers
 * that need to tell "absent" from "invalid" should check `isBlankMoneyValue`.
 *
 * Separator rules:
 * - Both "." and "," present: the LAST one is the decimal separator, the
 *   other is the thousands separator (groups of 3 digits are required).
 * - One separator repeated ("1.234.567"): thousands, groups of 3 required.
 * - One separator, once:
 *   - exactly 3 digits after it AND an integer part of 1–3 digits that does
 *     not start with 0 ("1.234", "1,234", "12.500") → thousands (1234,
 *     12500). Houses send money with 2 decimals; a 3-digit tail is far more
 *     likely to be a formatted integer ("R$ 1.234") than R$ 1,234 in tenths
 *     of a centavo.
 *   - otherwise → decimal ("10.5", "10,50", "0.500", "1234.567").
 */
export function parseMoneyValue(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.abs(raw) : null;
  }
  if (typeof raw !== "string") return null;

  // Drop every kind of whitespace (incl. NBSP and narrow NBSP).
  const compact = raw.replace(/[\s\u00a0\u202f]/g, "");
  if (!compact) return null;

  // Optional sign, optional currency prefix ("R$", "$", "BRL", "ARS$"),
  // digits with separators, optional currency suffix ("BRL"). Letters are
  // only accepted around the number, never inside it ("1e5", "10abc5").
  const match = /^([-+]?)([A-Za-z]{0,4}[$€£]?)([-+]?)([\d.,]+)([A-Za-z]{0,4})$/.exec(compact);
  if (!match) return null;
  if (match[1] && match[3]) return null;
  const body = match[4];
  if (!/\d/.test(body)) return null;

  const normalized = normalizeSeparators(body);
  if (normalized === null) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

/** True for null/undefined and strings that hold only blanks. */
export function isBlankMoneyValue(raw: unknown): boolean {
  return raw == null || (typeof raw === "string" && raw.trim() === "");
}

/** Returns a dot-decimal string without thousands separators, or null. */
function normalizeSeparators(body: string): string | null {
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");

  if (lastDot === -1 && lastComma === -1) return body;

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    const decimalAt = body.lastIndexOf(decimalSep);
    const intPart = body.slice(0, decimalAt);
    const fracPart = body.slice(decimalAt + 1);
    // The decimal separator appears once, after every thousands separator.
    if (intPart.includes(decimalSep) || fracPart.includes(thousandsSep)) return null;
    if (!/^\d+$/.test(fracPart)) return null;
    const digits = joinThousands(intPart, thousandsSep);
    return digits === null ? null : `${digits}.${fracPart}`;
  }

  const sep = lastDot !== -1 ? "." : ",";
  const parts = body.split(sep);
  if (parts.length > 2) {
    return joinThousands(body, sep);
  }

  const [intPart, fracPart] = parts;
  if (!/^\d*$/.test(intPart) || !/^\d+$/.test(fracPart)) return null;
  if (fracPart.length === 3 && /^[1-9]\d{0,2}$/.test(intPart)) {
    return `${intPart}${fracPart}`;
  }
  return `${intPart || "0"}.${fracPart}`;
}

/** "1.234.567" → "1234567"; null if the groups are not 1–3 + 3,3,... digits. */
function joinThousands(value: string, sep: string): string | null {
  const groups = value.split(sep);
  if (!/^\d{1,3}$/.test(groups[0])) return null;
  for (const group of groups.slice(1)) {
    if (!/^\d{3}$/.test(group)) return null;
  }
  return groups.join("");
}
