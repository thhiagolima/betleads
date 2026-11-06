import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/tenant-access.server", () => ({
  listDemoTenantIds: vi.fn(async () => [] as string[]),
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import { loadMonthData } from "./billing-month-data.server";
import type { MonthUsageRow } from "./billing-month-report";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";

// The aggregates billing_month_usage returns for the ledger rows seeded below.
const EXPECTED_USAGE: MonthUsageRow[] = [
  {
    tenant_id: TENANT,
    item: "sms",
    units: 1090, // 1000 - 10 (refund) + 100 (null cost)
    sale_amount: 87.2,
    provider_cost: 57.42, // 990 x 0.058
    missing_cost_units: 100,
  },
  {
    tenant_id: OTHER_TENANT,
    item: "email",
    units: 300,
    sale_amount: 0.3,
    provider_cost: 0.12, // 300 x 0.0004
    missing_cost_units: 0,
  },
];

function ledgerRow(
  id: string,
  tenant_id: string,
  entry_type: string,
  item: string | null,
  units: number | null,
  amount: number,
  provider_unit_cost: number | null,
  usage_month = "2026-10-01",
) {
  return { id, tenant_id, entry_type, item, units, amount, provider_unit_cost, usage_month };
}

function usageRpcCalls(calls: unknown[][]) {
  return calls.filter(([fn]) => fn === "billing_month_usage");
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin
    .rows("tenants")
    .push(
      { id: TENANT, nome: "Casa A", slug: "casa-a", plano: "crm_unico" },
      { id: OTHER_TENANT, nome: "Casa B", slug: "casa-b", plano: "crm_unico" },
    );
  fake.admin
    .rows("billing_plans")
    .push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
  fake.admin
    .rows("wallet_ledger")
    .push(
      ledgerRow("l1", TENANT, "usage_reservation", "sms", 1000, -80, 0.058),
      ledgerRow("l2", TENANT, "usage_refund", "sms", 10, 0.8, 0.058),
      ledgerRow("l3", TENANT, "usage_reservation", "sms", 100, -8, null),
      ledgerRow("l4", TENANT, "usage_reservation", "sms", 50, -4, 0.058, "2026-09-01"),
      ledgerRow("l5", TENANT, "purchase", null, null, 500, null),
      ledgerRow("l6", OTHER_TENANT, "usage_reservation", "email", 300, -0.3, 0.0004),
    );
});

function roundUsage(rows: MonthUsageRow[]) {
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return [...rows]
    .sort((a, b) => `${a.tenant_id}${a.item}`.localeCompare(`${b.tenant_id}${b.item}`))
    .map((row) => ({
      ...row,
      units: r(row.units),
      sale_amount: r(row.sale_amount),
      provider_cost: r(row.provider_cost),
      missing_cost_units: r(row.missing_cost_units),
    }));
}

describe("loadMonthData usage", () => {
  it("uses billing_month_usage when it exists, without reading wallet_ledger", async () => {
    const spy = vi.spyOn(fake.admin.client, "rpc");
    fake.admin.onRpc("billing_month_usage", () => ({
      // PostgREST returns numeric columns as strings.
      data: EXPECTED_USAGE.map((row) => ({
        ...row,
        units: String(row.units),
        sale_amount: String(row.sale_amount),
        provider_cost: String(row.provider_cost),
        missing_cost_units: String(row.missing_cost_units),
      })),
      error: null,
    }));

    const data = await loadMonthData("2026-10");

    expect(usageRpcCalls(spy.mock.calls)).toEqual([
      ["billing_month_usage", { _month: "2026-10-01" }],
    ]);
    expect(fake.admin.calls.some((c) => c.table === "wallet_ledger")).toBe(false);
    expect(data.usage).toEqual(EXPECTED_USAGE);
  });

  it("falls back to the paged wallet_ledger read when the function does not exist (PGRST202)", async () => {
    fake.admin.onRpc("billing_month_usage", () => ({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.billing_month_usage(_month) in the schema cache",
      },
    }));

    const data = await loadMonthData("2026-10");

    expect(fake.admin.calls.some((c) => c.table === "wallet_ledger")).toBe(true);
    expect(roundUsage(data.usage)).toEqual(EXPECTED_USAGE);
  });

  it("falls back on a 'does not exist' message without a code", async () => {
    fake.admin.onRpc("billing_month_usage", () => ({
      data: null,
      error: { message: "function public.billing_month_usage(date) does not exist" },
    }));

    const data = await loadMonthData("2026-10");

    expect(roundUsage(data.usage)).toEqual(EXPECTED_USAGE);
  });

  it("throws on any other RPC error", async () => {
    fake.admin.onRpc("billing_month_usage", () => ({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    }));

    await expect(loadMonthData("2026-10")).rejects.toThrow(/statement timeout/);
    expect(fake.admin.calls.some((c) => c.table === "wallet_ledger")).toBe(false);
  });
});
