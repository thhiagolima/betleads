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
