// Pix credit top-up packages and amount/description rules (PG2, Task 4).
// Pure helpers only — no I/O, no Supabase, no Upper client — so they stay
// trivially unit-testable from `topup.functions.ts`.

export const TOPUP_PACKAGES = [
  { code: "p500", amountCents: 50000 },
  { code: "p1000", amountCents: 100000 },
  { code: "p2500", amountCents: 250000 },
  { code: "p5000", amountCents: 500000 },
] as const;

// Minimum is the Upper Pix charge floor (R$ 100,00); maximum is the
// product decision (D9) for a single free-amount top-up (R$ 50.000,00).
export const MIN_TOPUP_CENTS = 10000;
export const MAX_TOPUP_CENTS = 5000000;

export type ResolveTopupAmountInput = {
  packageCode?: string | null;
  amountCents?: number | null;
};

const PACKAGES_BY_CODE = new Map<string, number>(
  TOPUP_PACKAGES.map((pkg) => [pkg.code, pkg.amountCents]),
);

/**
 * Resolves the server-trusted `amountCents` for a top-up purchase from
 * either a package code or a free amount. A package code, when present,
 * always wins — the client only ever sends one of the two, but if both
 * arrived we prefer the fixed, pre-validated package amount over a
 * caller-supplied number. Centavos are always computed/validated here, on
 * the server — never trusted from the client beyond this check.
 */
export function resolveTopupAmount(
  input: ResolveTopupAmountInput,
): { amountCents: number; packageCode: string | null } {
  if (input.packageCode) {
    const amountCents = PACKAGES_BY_CODE.get(input.packageCode);
    if (amountCents === undefined) throw new Error("Pacote inválido");
    return { amountCents, packageCode: input.packageCode };
  }

  const amountCents = input.amountCents;
  if (amountCents === null || amountCents === undefined || !Number.isFinite(amountCents)) {
    throw new Error("Pacote inválido");
  }
  const rounded = Math.round(amountCents);
  if (rounded < MIN_TOPUP_CENTS) {
    throw new Error("Valor mínimo de compra: R$ 100,00");
  }
  if (rounded > MAX_TOPUP_CENTS) {
    throw new Error("Valor máximo de compra: R$ 50.000,00");
  }
  return { amountCents: rounded, packageCode: null };
}

const MAX_DESCRIPTION_LENGTH = 140;

function formatBRL(amountCents: number): string {
  // Intl's pt-BR currency format inserts a U+00A0 (non-breaking space)
  // between "R$" and the number; normalize it to a regular space so the
  // description matches what designers/testers type and what the global
  // constraints doc shows verbatim ("R$ 1.000,00").
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(amountCents / 100)
    .replace(/ /g, " ");
}

/**
 * The description shown to the payer in the Upper checkout (global
 * constraints: up to 140 chars, no CNPJ/e-mail). When the house name alone
 * would push the whole string past 140 chars, the house name is the part
 * that gets cut, never the fixed suffix.
 */
export function topupDescription(tenantName: string, amountCents: number): string {
  const suffix = ` - Créditos BetLeads ${formatBRL(amountCents)}`;
  const maxNameLength = Math.max(0, MAX_DESCRIPTION_LENGTH - suffix.length);
  const name = tenantName.length > maxNameLength ? tenantName.slice(0, maxNameLength) : tenantName;
  return `${name}${suffix}`;
}
