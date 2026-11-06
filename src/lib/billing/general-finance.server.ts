// Task 3 — loader for the super admin "Financeiro geral" view: combines the
// monthly per-house numbers (Task 1, billing-month-report.ts/billing-month-data.server.ts)
// with each house's billing state (Task 2, billing-state-summary.ts).
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { selectAllPages } from "@/lib/pagination";

import { assertSuperAdmin } from "./billing-health.server";
import { loadMonthData } from "./billing-month-data.server";
import {
  computeMonthRows,
  sumMonthRows,
  type MonthHouseRow,
  type MonthTotals,
} from "./billing-month-report";
import {
  summarizeBillingStates,
  type BillingBucket,
  type BillingStateInput,
  type BillingStateSummary,
} from "./billing-state-summary";
import { brtDayKey } from "../tz";

type DbError = { message: string; details?: string | null };
type DbResult<T = unknown> = { data: T | null; error: DbError | null; count?: number | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string, options?: { count?: "exact"; head?: boolean }) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  in: (column: string, values: unknown[]) => LooseQuery<T>;
  not: (column: string, operator: string, value: unknown) => LooseQuery<T>;
  gte: (column: string, value: unknown) => LooseQuery<T>;
  lt: (column: string, value: unknown) => LooseQuery<T>;
  order: (column: string, options?: { ascending?: boolean }) => LooseQuery<T>;
  limit: (count: number) => LooseQuery<T>;
};
type LooseSupabase = { from: <T = unknown>(table: string) => LooseQuery<T> };

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

const MONTH_INVALID_MESSAGE = "Mês inválido (use AAAA-MM).";

// Same regex/message as adminBillingMonthlyCsvInput (billing-admin.functions.ts), plus a
// calendar-month-range refinement (01-12) so a shape-valid but impossible month like "2026-13"
// is rejected with the same message instead of silently rolling over to the next year.
export const generalFinanceInput = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, MONTH_INVALID_MESSAGE)
    .refine((value) => {
      const monthPart = Number(value.slice(5, 7));
      return monthPart >= 1 && monthPart <= 12;
    }, MONTH_INVALID_MESSAGE),
});

export type GeneralFinanceHouse = MonthHouseRow & {
  bucket: BillingBucket;
  daysOverdue: number | null;
  openInvoiceCents: number | null;
  /** The house has a row in tenant_channel_providers (its own provider account for some
   * channel), so the Short Brasil/Infobip split by item is only approximate for it. */
  ownProvider: boolean;
};

export type GeneralFinance = {
  month: string;
  generatedAt: string;
  totals: MonthTotals;
  states: Omit<BillingStateSummary, "rows">;
  houses: GeneralFinanceHouse[];
  /** Names of the houses with ownProvider, in `houses` order. */
  ownProviderHouses: string[];
};

const TRUNCATED_MESSAGE = "Histórico de faturas grande demais para calcular o Financeiro geral.";

type TenantBillingStateRow = { tenant_id: string; access_state: string };
type OpenInvoiceRow = {
  id: string;
  tenant_id: string;
  amount_cents: number | string;
  due_date: string;
};
type PaidAtRow = { id: string; tenant_id: string; paid_at: string };
type ChannelProviderRow = { tenant_id: string; channel: string };

export async function adminGeneralFinanceFor(
  ctx: { userId: string },
  data: unknown,
): Promise<GeneralFinance> {
  const input = generalFinanceInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const monthData = await loadMonthData(input.month);
  const monthRows = computeMonthRows(monthData);
  const totals = sumMonthRows(monthRows);

  const sb = looseDb(supabaseAdmin);
  const tenantIds = monthData.tenants.map((t) => t.id);

  const [tbPaged, openInvPaged, paidAtPaged, channelProviders] = await Promise.all([
    selectAllPages<TenantBillingStateRow>(
      "general_finance_tenant_billing",
      () => sb.from("tenant_billing").select("tenant_id,access_state"),
      "tenant_id",
    ),
    selectAllPages<OpenInvoiceRow>("general_finance_open_invoices", () =>
      sb.from("billing_invoices").select("id,tenant_id,amount_cents,due_date").eq("status", "open"),
    ),
    selectAllPages<PaidAtRow>("general_finance_paid_at", () =>
      sb.from("billing_invoices").select("id,tenant_id,paid_at").eq("status", "paid"),
    ),
    // Tiny table (at most houses × 3 channels): one plain read, no paging.
    tenantIds.length > 0
      ? sb
          .from<ChannelProviderRow[]>("tenant_channel_providers")
          .select("tenant_id,channel")
          .in("tenant_id", tenantIds)
      : Promise.resolve({ data: [] as ChannelProviderRow[], error: null }),
  ]);
  if (channelProviders.error) throw new Error(channelProviders.error.message);
  for (const res of [tbPaged, openInvPaged, paidAtPaged]) {
    if (res.error) throw new Error(res.error.message);
  }
  // Controller ruling: a result silently capped by selectAllPages' MAX_PAGES ceiling would make
  // every bucket/debtor/firstPaidAt computed below wrong without any error — fail loudly instead
  // of returning a plausible-looking but partial report.
  if (tbPaged.truncated || openInvPaged.truncated || paidAtPaged.truncated) {
    throw new Error(TRUNCATED_MESSAGE);
  }

  const accessStateByTenant = new Map(
    tbPaged.data.map((r) => [r.tenant_id, r.access_state] as const),
  );
  const openInvoiceByTenant = new Map(
    openInvPaged.data.map(
      (r) => [r.tenant_id, { amountCents: Number(r.amount_cents), dueDate: r.due_date }] as const,
    ),
  );
  const firstPaidAtByTenant = new Map<string, string>();
  for (const row of paidAtPaged.data) {
    if (!row.paid_at) continue;
    const current = firstPaidAtByTenant.get(row.tenant_id);
    if (!current || row.paid_at < current) firstPaidAtByTenant.set(row.tenant_id, row.paid_at);
  }
  const ownProviderTenants = new Set((channelProviders.data ?? []).map((r) => r.tenant_id));
  const paidInMonthTenants = new Set(monthData.invoicesPaid.map((r) => r.tenant_id));

  const todayBrt = brtDayKey(new Date());

  const stateInputs: BillingStateInput[] = monthData.tenants.map((tenant) => ({
    tenantId: tenant.id,
    name: tenant.nome,
    accessState: accessStateByTenant.get(tenant.id) ?? (tenant.exempt ? "exempt" : "ok"),
    openInvoice: openInvoiceByTenant.get(tenant.id) ?? null,
    firstPaidAt: firstPaidAtByTenant.get(tenant.id) ?? null,
    paidInMonth: paidInMonthTenants.has(tenant.id),
  }));

  const states = summarizeBillingStates(stateInputs, todayBrt, input.month);
  const stateRowByTenant = new Map(states.rows.map((r) => [r.tenantId, r] as const));

  const housesAll: GeneralFinanceHouse[] = monthRows.map((row) => {
    const stateRow = stateRowByTenant.get(row.tenantId);
    return {
      ...row,
      bucket: stateRow?.bucket ?? "ok",
      daysOverdue: stateRow?.daysOverdue ?? null,
      openInvoiceCents: openInvoiceByTenant.get(row.tenantId)?.amountCents ?? null,
      ownProvider: ownProviderTenants.has(row.tenantId),
    };
  });

  // debtors first, in states.debtors order; then the rest by margemPct ascending (null last).
  const debtorOrder = new Map(states.debtors.map((d, i) => [d.tenantId, i] as const));
  const debtorHouses = housesAll
    .filter((h) => debtorOrder.has(h.tenantId))
    .sort((a, b) => debtorOrder.get(a.tenantId)! - debtorOrder.get(b.tenantId)!);
  const restHouses = housesAll
    .filter((h) => !debtorOrder.has(h.tenantId))
    .sort((a, b) => {
      if (a.margemPct == null && b.margemPct == null) return 0;
      if (a.margemPct == null) return 1;
      if (b.margemPct == null) return -1;
      return a.margemPct - b.margemPct;
    });

  const { rows: _rows, ...statesWithoutRows } = states;
  const houses = [...debtorHouses, ...restHouses];

  return {
    month: input.month,
    generatedAt: new Date().toISOString(),
    totals,
    states: statesWithoutRows,
    houses,
    ownProviderHouses: houses.filter((h) => h.ownProvider).map((h) => h.name),
  };
}
