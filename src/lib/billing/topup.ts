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
  // Centavos are always an integer: reject a fractional amount outright
  // instead of silently rounding it (a client sending cents should never
  // send a fraction of a cent; this is the server's source of truth).
  if (!Number.isInteger(amountCents)) {
    throw new Error("Valor inválido");
  }
  if (amountCents < MIN_TOPUP_CENTS) {
    throw new Error("Valor mínimo de compra: R$ 100,00");
  }
  if (amountCents > MAX_TOPUP_CENTS) {
    throw new Error("Valor máximo de compra: R$ 50.000,00");
  }
  return { amountCents, packageCode: null };
}

const MAX_DESCRIPTION_LENGTH = 140;

function formatBRL(amountCents: number): string {
  // Intl's pt-BR currency format inserts a U+00A0 (non-breaking space)
  // between "R$" and the number; normalize it to a regular space so the
  // description matches what designers/testers type and what the global
  // constraints doc shows verbatim ("R$ 1.000,00").
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(amountCents / 100)
    .replace(/\u00a0/g, " ");
}

/**
 * Shared description-truncation rule (PG2/PG4): cuts the house `name` so
 * `name + suffix` never exceeds `max` chars (default 140, the Upper
 * checkout limit). The house name is always the part that gets cut, never
 * the fixed `suffix`.
 *
 * Cutting is done by Unicode code point (`Array.from`), never by raw
 * `string.slice` — a plain UTF-16 slice can land in the middle of a
 * surrogate pair (an emoji, for instance) and produce a lone/broken
 * surrogate in the description Upper sends to the payer. Any trailing
 * whitespace left by the cut is trimmed, and a name that ends up empty
 * (blank, or trimmed down to nothing) falls back to "Casa" so the
 * description never starts with " - <suffix>".
 */
export function truncateDescription(name: string, suffix: string, max = MAX_DESCRIPTION_LENGTH): string {
  const maxNameLength = Math.max(0, max - suffix.length);
  const codePoints = Array.from(name);
  const cut = codePoints.length > maxNameLength ? codePoints.slice(0, maxNameLength).join("") : name;
  const safeName = cut.trimEnd() || "Casa";
  return `${safeName}${suffix}`;
}

/**
 * The description shown to the payer in the Upper checkout for a credit
 * top-up (global constraints: up to 140 chars, no CNPJ/e-mail). See
 * `truncateDescription` for the cutting rule.
 */
export function topupDescription(tenantName: string, amountCents: number): string {
  const suffix = ` - Créditos BetLeads ${formatBRL(amountCents)}`;
  return truncateDescription(tenantName, suffix);
}

/** Upper statuses after which a Pix can no longer be paid. */
const FINAL_TOPUP_STATUSES = new Set(["EXPIRED", "CANCELLED", "FAILED"]);

export type TopupStatusSnapshot = { status: string; credited: boolean; needsReview?: boolean };

export type TopupView = "credited" | "review" | "paid_confirming" | "expired" | "pay";

/**
 * Which screen the buy-credits dialog shows. Order matters: credited, then a
 * review flag (needs a human), then PAID-not-yet-credited ("Pagamento
 * recebido, confirmando…") — money received always beats "expired", even
 * when the local countdown already hit zero — then expired, else the Pix.
 */
export function topupView(args: {
  credited: boolean;
  needsReview: boolean;
  serverStatus: string | null;
  localExpired: boolean;
}): TopupView {
  if (args.credited) return "credited";
  if (args.needsReview) return "review";
  if (args.serverStatus === "PAID") return "paid_confirming";
  if (args.localExpired) return "expired";
  if (args.serverStatus !== null && FINAL_TOPUP_STATUSES.has(args.serverStatus)) return "expired";
  return "pay";
}

/** Keep polling (3 s) until credited, flagged for review, or a final unpaid status. */
export function shouldPollTopupStatus(data: TopupStatusSnapshot | undefined): boolean {
  if (!data) return true;
  if (data.credited || data.needsReview) return false;
  return !FINAL_TOPUP_STATUSES.has(data.status);
}
