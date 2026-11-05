// Monthly data loader for billing-month-report.ts's pure computation. Moved
// out of adminBillingMonthlyCsvFor (billing-admin.functions.ts) so the CSV
// and the "Financeiro geral" screen share the exact same reads.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { selectAllPages } from "@/lib/pagination";
import { listDemoTenantIds } from "@/lib/tenant-access.server";

import { parseBrtDayStart } from "../tz";
import type { MonthData, MonthLedgerRow, MonthTenant } from "./billing-month-report";

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

function nextYyyyMm(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type BillingPlanRow = { code: string; price_cents: number | string; exempt_all: boolean };
type TenantRow = { id: string; nome: string | null; slug: string | null; plano: string | null };
type AmountRow = { id: string; tenant_id: string; paid_amount_cents: number | string | null };
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

/** Loads one month's tenants, invoices, topups, ledger and Pix fees for computeMonthRows,
 * excluding demo tenants. Throws on any read error (same paging/keys as the CSV, I3/I4). */
export async function loadMonthData(month: string): Promise<MonthData> {
  const sb = looseDb(supabaseAdmin);

  const monthStart = `${month}-01`;
  const monthStartISO = parseBrtDayStart(monthStart).toISOString();
  const monthEndExclusiveISO = parseBrtDayStart(`${nextYyyyMm(month)}-01`).toISOString();

  const [tenantsRes, plansRes, invPaged, topupPaged, ledgerPaged, chargesPaged, demoIds] =
    await Promise.all([
      sb.from("tenants").select("id,nome,slug,plano").order("nome", { ascending: true }),
      sb.from("billing_plans").select("code,price_cents,exempt_all"),
      selectAllPages<AmountRow>("billing_invoices_paid_csv", () =>
        sb
          .from("billing_invoices")
          .select("id,tenant_id,paid_amount_cents")
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
      selectAllPages<LedgerRow>("wallet_ledger_csv", () =>
        sb
          .from("wallet_ledger")
          .select("id,tenant_id,item,units,amount,provider_unit_cost,entry_type")
          .eq("usage_month", monthStart)
          .in("entry_type", ["usage_reservation", "usage_refund"]),
      ),
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
  for (const res of [invPaged, topupPaged, ledgerPaged, chargesPaged]) {
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

  const ledger: MonthLedgerRow[] = ledgerPaged.data.map((r) => ({
    tenant_id: r.tenant_id,
    item: r.item,
    units: Number(r.units ?? 0),
    amount: Number(r.amount ?? 0),
    provider_unit_cost: r.provider_unit_cost == null ? null : Number(r.provider_unit_cost),
    entry_type: r.entry_type,
  }));

  return {
    month,
    tenants,
    invoicesPaid: invPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      paid_amount_cents: Number(r.paid_amount_cents ?? 0),
    })),
    topups: topupPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      paid_amount_cents: Number(r.paid_amount_cents ?? 0),
    })),
    ledger,
    pixFees: chargesPaged.data.map((r) => ({
      tenant_id: r.tenant_id,
      fee_cents: Number(r.fee_cents ?? 0),
    })),
  };
}
