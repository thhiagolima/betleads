// Pure summary of each house's monthly-fee billing state for the super-admin
// "Financeiro geral" view (Task 2): buckets, debtor list, and the month's
// paying/lost movements.
//
// Pure module: no Supabase, no env reads, no I/O. A client component
// imports `BUCKET_LABELS` at runtime, so this file must stay free of any
// server-only import.
//
// Dates are Brasília calendar days as `YYYY-MM-DD` strings (`todayBrt`) and
// `month` is `YYYY-MM`. `firstPaidAt` is an ISO timestamp; its month is
// decided by the Brasília calendar day of that instant, via `brtDayKey`
// from `src/lib/tz.ts` (pure: fixed UTC-3 offset, no I/O).
import { brtDayKey } from "@/lib/tz";

export type BillingStateInput = {
  tenantId: string;
  name: string;
  accessState: string; // tenant_billing.access_state
  openInvoice: { amountCents: number; dueDate: string } | null;
  firstPaidAt: string | null; // earliest billing_invoices.paid_at ever
  paidInMonth: boolean; // a paid invoice with paid_at inside the selected month
};

export type BillingBucket =
  "ok" | "due_soon" | "overdue" | "locked" | "awaiting_first_payment" | "exempt" | "frozen";

export const BUCKET_LABELS: Record<BillingBucket, string> = {
  ok: "Em dia",
  due_soon: "Vence em 5 dias",
  overdue: "Vencida",
  locked: "Bloqueada",
  awaiting_first_payment: "Aguardando 1º pagamento",
  exempt: "Isenta",
  frozen: "Congelada",
};

export type BillingStateRow = BillingStateInput & {
  bucket: BillingBucket;
  daysOverdue: number | null;
};

export type Debtor = {
  tenantId: string;
  name: string;
  amountCents: number;
  daysOverdue: number;
  bucket: BillingBucket;
};

export type BillingStateSummary = {
  rows: BillingStateRow[];
  counts: Record<BillingBucket, number>;
  owedCents: number;
  debtors: Debtor[];
  movements: { newPaying: string[]; lost: string[] };
};

// Buckets whose open-invoice amount counts as money owed, and whose houses
// show up in the debtor list.
const OWING_BUCKETS = new Set<BillingBucket>(["overdue", "locked", "awaiting_first_payment"]);

function toBucket(accessState: string): BillingBucket {
  switch (accessState) {
    case "ok":
    case "due_soon":
    case "overdue":
    case "awaiting_first_payment":
    case "exempt":
    case "frozen":
      return accessState;
    case "locked_unpaid":
    case "locked_manual":
      return "locked";
    default:
      return "ok";
  }
}

function parseYMD(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** Day-number serial (UTC, calendar-only) for a YYYY-MM-DD string. */
function toDaySerial(s: string): number {
  const { y, m, d } = parseYMD(s);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Whole days from `a` to `b` (b - a), both YYYY-MM-DD. */
function daysBetween(a: string, b: string): number {
  return toDaySerial(b) - toDaySerial(a);
}

/** "YYYY-MM" of the Brasília calendar day containing the ISO instant `iso`. */
function brtMonthOf(iso: string): string {
  return brtDayKey(new Date(iso)).slice(0, 7);
}

export function summarizeBillingStates(
  rows: BillingStateInput[],
  todayBrt: string,
  month: string,
): BillingStateSummary {
  const counts: Record<BillingBucket, number> = {
    ok: 0,
    due_soon: 0,
    overdue: 0,
    locked: 0,
    awaiting_first_payment: 0,
    exempt: 0,
    frozen: 0,
  };

  const outRows: BillingStateRow[] = [];
  const debtors: Debtor[] = [];
  const newPaying: string[] = [];
  const lost: string[] = [];
  let owedCents = 0;

  for (const input of rows) {
    const bucket = toBucket(input.accessState);
    counts[bucket] += 1;

    const daysOverdue =
      input.openInvoice && daysBetween(input.openInvoice.dueDate, todayBrt) > 0
        ? daysBetween(input.openInvoice.dueDate, todayBrt)
        : null;

    outRows.push({ ...input, bucket, daysOverdue });

    if (OWING_BUCKETS.has(bucket) && input.openInvoice) {
      owedCents += input.openInvoice.amountCents;
      debtors.push({
        tenantId: input.tenantId,
        name: input.name,
        amountCents: input.openInvoice.amountCents,
        daysOverdue: daysOverdue ?? 0,
        bucket,
      });
    }

    if (input.firstPaidAt && brtMonthOf(input.firstPaidAt) === month) {
      newPaying.push(input.name);
    }

    if ((bucket === "locked" || bucket === "frozen") && !input.paidInMonth) {
      lost.push(input.name);
    }
  }

  debtors.sort((a, b) => b.amountCents - a.amountCents || b.daysOverdue - a.daysOverdue);

  return {
    rows: outRows,
    counts,
    owedCents,
    debtors,
    movements: { newPaying, lost },
  };
}
