// LGPD: masks a Brazilian payer document (CPF/CNPJ) for storage/display.
// The full document is never kept around; this is the only representation
// that reaches `payment_charges.payer_document_masked` or any payload that
// gets logged/stored (see `recordChargeSnapshot` in payment-charges.server.ts).

/**
 * Masks a CPF/CNPJ, keeping only a handful of middle digits visible:
 * - 11 digits (CPF): "***.456.789-**" (digits 4-9 visible).
 * - 14 digits (CNPJ): "**.345.678/****-**" (digits 3-8 visible).
 * - Any other digit count: fully masked as "***".
 * - null in, null out.
 */
export function maskPayerDocument(doc: string | null): string | null {
  if (doc === null) return null;

  const digits = doc.replace(/\D/g, "");

  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }

  if (digits.length === 14) {
    return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**`;
  }

  return "***";
}

/**
 * LGPD: returns a deep copy of `value` where every object key named
 * `document` (any case, at any depth, inside objects or arrays) has its value
 * replaced by `maskPayerDocument(value)` — or null when that value is not a
 * string. Used on everything stored from Upper (`last_provider_payload`,
 * `payment_webhook_events.raw_body`), so a payer document never lands in the
 * database in full, wherever Upper happens to nest it. `masked` counts the
 * keys replaced (0 means the copy is identical to the input).
 */
export function maskDocumentsDeep(value: unknown): { value: unknown; masked: number } {
  let masked = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key.toLowerCase() === "document") {
          masked += 1;
          out[key] = typeof child === "string" ? maskPayerDocument(child) : null;
        } else {
          out[key] = walk(child);
        }
      }
      return out;
    }
    return node;
  };
  const result = walk(value);
  return { value: result, masked };
}
