// Monthly data loader for billing-month-report.ts's pure computation. Moved
// out of adminBillingMonthlyCsvFor (billing-admin.functions.ts) so the CSV
// and the "Financeiro geral" screen share the exact same reads.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { selectAllPages } from "@/lib/pagination";
import { listDemoTenantIds } from "@/lib/tenant-access.server";

import { parseBrtDayStart } from "../tz";
import type { MonthData, MonthTenant, MonthUsageRow } from "./billing-month-report";

type DbError = { message: string; code?: string; details?: string | null };
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
type LooseSupabase = {
  from: <T = unknown>(table: string) => LooseQuery<T>;
  rpc: <T = unknown>(fn: string, args: Record<string, unknown>) => PromiseLike<DbResult<T>>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

function nextYyyyMm(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type BillingPlanRow = { code: string; price_cents: number | string; exempt_all: boolean };
type TenantRow = { id: string; nome: string | null; slug: string | null; plano: string | null };
type AmountRow = { id: string; tenant_id: string; paid_amount_cents: number | string | null };
type PaidInvoiceRow = AmountRow & { channel_fees_cents: number | string | null };
type LedgerRow = {
  id: string;
  tenant_id: string;
  item: string | null;
  units: number | string | null;
  amount: number | string;
  provider_unit_cost: number | string | null;
  entry_type: string;
};
type FeeRow = { id: string; tenant_id: string; fee_cents: number | string | null };
type UsageRpcRow = {
  tenant_id: string;
  item: string | null;
  units: number | string | null;
  sale_amount: number | string | null;
  provider_cost: number | string | null;
  missing_cost_units: number | string | null;
};

/** PostgREST's "function not found" (PGRST202), or Postgres' own "does not exist": the
 * billing_month_usage migration (20261211100000) is not applied yet. */
function isMissingFunction(error: DbError): boolean {
  return (
    error.code === "PGRST202" || /could not find the function|does not exist/i.test(error.message)
  );
}

/** Pre-migration path: pages the month's raw usage rows and aggregates them per tenant × item
 * exactly like billing_month_usage does in SQL. ~50 s for a 330k-row month in production, so it
 * only runs while that function is missing. */
async function loadMonthUsageFromLedger(
  sb: LooseSupabase,
  monthStart: string,
): Promise<MonthUsageRow[]> {
  const paged = await selectAllPages<LedgerRow>("wallet_ledger_csv", () =>
    sb
      .from("wallet_ledger")
      .select("id,tenant_id,item,units,amount,provider_unit_cost,entry_type")
      .eq("usage_month", monthStart)
      .in("entry_type", ["usage_reservation", "usage_refund"]),
  );
  if (paged.error) throw new Error(paged.error.message);

  const byKey = new Map<string, MonthUsageRow>();
  for (const r of paged.data) {
    const key = `${r.tenant_id}|${r.item ?? ""}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        tenant_id: r.tenant_id,
        item: r.item,
        units: 0,
        sale_amount: 0,
        provider_cost: 0,
        missing_cost_units: 0,
      };
      byKey.set(key, agg);
    }
    const signedUnits = (r.entry_type === "usage_reservation" ? 1 : -1) * Number(r.units ?? 0);
    agg.units += signedUnits;
    agg.sale_amount -= Number(r.amount ?? 0);
    if (r.provider_unit_cost == null) {
      agg.missing_cost_units += signedUnits;
    } else {
      agg.provider_cost += signedUnits * Number(r.provider_unit_cost);
    }
  }
  return [...byKey.values()];
}

/** The month's usage per tenant × item: billing_month_usage in SQL, or the paged fallback while
 * that function does not exist. Any other RPC error throws. */
async function loadMonthUsage(sb: LooseSupabase, monthStart: string): Promise<MonthUsageRow[]> {
  const res = await sb.rpc<UsageRpcRow[]>("billing_month_usage", { _month: monthStart });
  if (res.error) {
    if (isMissingFunction(res.error)) return loadMonthUsageFromLedger(sb, monthStart);
    throw new Error(res.error.message);
  }
  return (res.data ?? []).map((r) => ({
    tenant_id: r.tenant_id,
    item: r.item,
    units: Number(r.units ?? 0),
    sale_amount: Number(r.sale_amount ?? 0),
    provider_cost: Number(r.provider_cost ?? 0),
    missing_cost_units: Number(r.missing_cost_units ?? 0),
  }));
}

/** Loads one month's tenants, invoices, topups, usage and Pix fees for computeMonthRows,
 * excluding demo tenants. Throws on any read error (same paging/keys as the CSV, I3/I4). */
export async function loadMonthData(month: string): Promise<MonthData> {
  const sb = looseDb(supabaseAdmin);

  const monthStart = `${month}-01`;
  const monthStartISO = parseBrtDayStart(monthStart).toISOString();
  const monthEndExclusiveISO = parseBrtDayStart(`${nextYyyyMm(month)}-01`).toISOString();

  const [tenantsRes, plansRes, invPaged, topupPaged, usage, chargesPaged, demoIds] =
    await Promise.all([
      sb.from("tenants").select("id,nome,slug,plano").order("nome", { ascending: true }),
      sb.from("billing_plans").select("code,price_cents,exempt_all"),
      selectAllPages<PaidInvoiceRow>("billing_invoices_paid_csv", () =>
        sb
          .from("billing_invoices")
          .select("id,tenant_id,paid_amount_cents,channel_fees_cents")
          .eq("status", "paid")
          .gte("paid_at", monthStartISO)
          .lt("paid_at", monthEndExclusiveISO),
      ),
      selectAllPages<AmountRow>("payment_charges_credit_topup_csv", () =>
        sb
          .from("payment_charges")
          .select("id,tenant_id,paid_amount_cents")
          .eq("kind", "credit_topup")
          .not("credited_at", "is", null)
          .gte("credited_at", monthStartISO)
          .lt("credited_at", monthEndExclusiveISO),
      ),
      loadMonthUsage(sb, monthStart),
      selectAllPages<FeeRow>("payment_charges_fee_csv", () =>
        sb
          .from("payment_charges")
          .select("id,tenant_id,fee_cents")
          .eq("status", "PAID")
          .gte("paid_at", monthStartISO)
          .lt("paid_at", monthEndExclusiveISO),
      ),
      listDemoTenantIds(),
    ]);
  for (const res of [tenantsRes, plansRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  for (const res of [invPaged, topupPaged, chargesPaged]) {
    if (res.error) throw new Error(res.error.message);
  }

  const plansByCode = new Map(
    ((plansRes.data ?? []) as BillingPlanRow[]).map((p) => [p.code, p] as const),
  );
  const demoSet = new Set(demoIds);

  const tenants: MonthTenant[] = ((tenantsRes.data ?? []) as TenantRow[])
    .filter((tenant) => !demoSet.has(tenant.id))
    .map((tenant) => {
      const plan = tenant.plano ? plansByCode.get(tenant.plano) : undefined;
      return {
        id: tenant.id,
        nome: tenant.nome ?? "",
        slug: tenant.slug ?? "",
        plano: plan?.code ?? tenant.plano ?? null,
        exempt: plan?.exempt_all === true,
      };
    });

  return {
    month,
    tenants,
    invoicesPaid: invPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      paid_amount_cents: Number(r.paid_amount_cents ?? 0),
      channel_fees_cents: Number(r.channel_fees_cents ?? 0),
    })),
    topups: topupPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      paid_amount_cents: Number(r.paid_amount_cents ?? 0),
    })),
    usage,
    pixFees: chargesPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      fee_cents: Number(r.fee_cents ?? 0),
    })),
  };
}
