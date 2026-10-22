// Pure banner/lock view model for the monthly plan (PG2, Task 1).
//
// Pure module: no Supabase, no env reads, no I/O. The browser (client
// banner/lock UI) and the server (Task 6 — enforcing requests) both import
// this, so it must stay free of any server-only import.
//
// Dates are Brasília calendar days as `YYYY-MM-DD` strings. All date math
// here is plain calendar arithmetic done with `Date.UTC` on the parsed
// year/month/day parts — never the machine's local timezone, and never a
// `new Date(string)` parse (which some engines treat as UTC-midnight and
// others as local-midnight, depending on string shape).

import { brl } from "../format";

export type BillingAccessState =
  | "exempt"
  | "frozen"
  | "locked_manual"
  | "awaiting_first_payment"
  | "ok"
  | "due_soon"
  | "overdue"
  | "locked_unpaid";

export type BillingRole = "payer" | "member" | "super_admin";

export type BillingInvoice = {
  amountCents: number;
  dueDate: string; // YYYY-MM-DD
};

export type BillingViewInput = {
  state: BillingAccessState;
  role: BillingRole;
  enforcement: boolean;
  invoice: BillingInvoice | null;
  today: string; // YYYY-MM-DD
};

export type BillingBanner = {
  tone: "yellow" | "red";
  text: string;
  showPay: boolean;
  memberHint: string | null;
};

export type BillingLock = {
  title: string;
  text: string;
  showPay: boolean;
  memberHint: string | null;
};

export type BillingView = {
  banner: BillingBanner | null;
  lock: BillingLock | null;
  canBuyCredits: boolean;
};

const MEMBER_HINT = "Peça ao administrador da casa para pagar a mensalidade.";

// ---------------------------------------------------------------------------
// Pure calendar math (no local timezone — everything via Date.UTC on the
// parsed Y/M/D parts).
// ---------------------------------------------------------------------------

function parseYMD(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** Day count since the Unix epoch for a YYYY-MM-DD, as pure calendar math. */
function toDaySerial(s: string): number {
  const { y, m, d } = parseYMD(s);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Whole days from `a` to `b` (b - a), both YYYY-MM-DD. */
function daysBetween(a: string, b: string): number {
  return toDaySerial(b) - toDaySerial(a);
}

/** `s` (YYYY-MM-DD) plus `n` days, as pure calendar math. */
function addDays(s: string, n: number): string {
  const { y, m, d } = parseYMD(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** DD/MM for a YYYY-MM-DD string. */
function formatDDMM(s: string): string {
  const { m, d } = parseYMD(s);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** "R$ 4.000,00" — `brl()` with the NBSP it inserts normalized to a space. */
function money(amountCents: number): string {
  return brl(amountCents / 100).replace(/ /g, " ");
}

function daysLabel(n: number): string {
  return n === 1 ? "1 dia" : `${n} dias`;
}

// ---------------------------------------------------------------------------
// Effective lock
// ---------------------------------------------------------------------------

/**
 * Whether `state` locks the house, given the enforcement switch — before
 * the superadmin exemption (the superadmin is never blocked; that is
 * applied by the caller, since this function has no `role`).
 */
export function isEffectiveLock(state: BillingAccessState, enforcement: boolean): boolean {
  if (state === "frozen" || state === "locked_manual") return true;
  if (state === "locked_unpaid" || state === "awaiting_first_payment") return enforcement;
  return false;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export function billingView(input: BillingViewInput): BillingView {
  const { state, role, enforcement, invoice, today } = input;

  const isMember = role === "member";
  const isSuperAdmin = role === "super_admin";
  // The superadmin is never blocked (global constraint), so the lock only
  // ever applies to payer/member.
  const locked = isEffectiveLock(state, enforcement) && !isSuperAdmin;

  const payShownTo = (showForPayerAndSuperAdmin: boolean) =>
    isMember ? false : showForPayerAndSuperAdmin;
  const hintFor = () => (isMember ? MEMBER_HINT : null);

  switch (state) {
    case "exempt":
    case "ok":
      return { banner: null, lock: null, canBuyCredits: true };

    case "due_soon": {
      if (!invoice) return { banner: null, lock: null, canBuyCredits: true };
      const n = daysBetween(today, invoice.dueDate);
      const text =
        `Sua mensalidade de ${money(invoice.amountCents)} vence em ${formatDDMM(invoice.dueDate)} ` +
        `(daqui a ${daysLabel(n)}). Pague por Pix para manter tudo funcionando.`;
      return {
        banner: { tone: "yellow", text, showPay: payShownTo(true), memberHint: hintFor() },
        lock: null,
        canBuyCredits: true,
      };
    }

    case "overdue": {
      if (!invoice) return { banner: null, lock: null, canBuyCredits: true };
      const dueFmt = formatDDMM(invoice.dueDate);
      const text = enforcement
        ? `Sua mensalidade venceu em ${dueFmt}. Se não for paga até ${formatDDMM(addDays(invoice.dueDate, 3))}, o acesso ao CRM será bloqueado.`
        : `Sua mensalidade venceu em ${dueFmt}. Pague para regularizar.`;
      return {
        banner: { tone: "red", text, showPay: payShownTo(true), memberHint: hintFor() },
        lock: null,
        canBuyCredits: true,
      };
    }

    case "locked_unpaid": {
      if (!invoice) return { banner: null, lock: null, canBuyCredits: true };
      const dueFmt = formatDDMM(invoice.dueDate);

      if (!enforcement) {
        // Enforcement off: never locks — same "regularizar" red banner as
        // an unenforced overdue house.
        return {
          banner: {
            tone: "red",
            text: `Sua mensalidade venceu em ${dueFmt}. Pague para regularizar.`,
            showPay: payShownTo(true),
            memberHint: hintFor(),
          },
          lock: null,
          canBuyCredits: true,
        };
      }

      if (isSuperAdmin) {
        // Never locked — sees the informational red banner instead.
        return {
          banner: {
            tone: "red",
            text: `Sua mensalidade venceu em ${dueFmt}. Pague para regularizar.`,
            showPay: true,
            memberHint: null,
          },
          lock: null,
          canBuyCredits: true,
        };
      }

      return {
        banner: null,
        lock: {
          title: "Acesso suspenso por falta de pagamento",
          text: `A mensalidade de ${money(invoice.amountCents)} venceu em ${dueFmt}. Pague por Pix e o acesso volta na hora.`,
          showPay: payShownTo(true),
          memberHint: hintFor(),
        },
        canBuyCredits: false,
      };
    }

    case "locked_manual": {
      if (isSuperAdmin) {
        return {
          banner: { tone: "red", text: "Plano com bloqueio manual. Fale com o suporte.", showPay: true, memberHint: null },
          lock: null,
          canBuyCredits: true,
        };
      }
      const hasOverdueInvoice = invoice !== null && today >= invoice.dueDate;
      return {
        banner: null,
        lock: {
          title: "Acesso suspenso",
          text: "Fale com o suporte.",
          showPay: payShownTo(hasOverdueInvoice),
          memberHint: hintFor(),
        },
        canBuyCredits: false,
      };
    }

    case "frozen": {
      if (isSuperAdmin) {
        return {
          banner: { tone: "red", text: "Plano pausado. Fale com o suporte.", showPay: true, memberHint: null },
          lock: null,
          canBuyCredits: true,
        };
      }
      return {
        banner: null,
        lock: { title: "Plano pausado", text: "Fale com o suporte.", showPay: false, memberHint: hintFor() },
        canBuyCredits: false,
      };
    }

    case "awaiting_first_payment": {
      if (!enforcement || !invoice) return { banner: null, lock: null, canBuyCredits: true };

      if (isSuperAdmin) {
        return {
          banner: {
            tone: "red",
            text: `Pague a primeira mensalidade de ${money(invoice.amountCents)} por Pix para começar a usar o CRM.`,
            showPay: true,
            memberHint: null,
          },
          lock: null,
          canBuyCredits: true,
        };
      }

      return {
        banner: null,
        lock: {
          title: "Ative sua conta",
          text: `Pague a primeira mensalidade de ${money(invoice.amountCents)} por Pix para começar a usar o CRM.`,
          showPay: payShownTo(true),
          memberHint: hintFor(),
        },
        canBuyCredits: false,
      };
    }

    default:
      return { banner: null, lock: null, canBuyCredits: true };
  }
}
