import { describe, expect, it, vi } from "vitest";

import { runWebpushLeadBilling, type LeadBillTenantResult } from "./lead-billing.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const cobrado = (tenant: string, units: number, amount = units * 0.01): LeadBillTenantResult => ({
  ok: true,
  status: "cobrado",
  tenant_id: tenant,
  units,
  amount,
});
const nada = (tenant: string): LeadBillTenantResult => ({
  ok: true,
  status: "nada",
  tenant_id: tenant,
  units: 0,
});

describe("runWebpushLeadBilling", () => {
  it("bills every house with one call per batch and sums the result", async () => {
    const billTenant = vi.fn(async (tenant: string) =>
      tenant === A ? cobrado(A, 3) : cobrado(B, 1),
    );
    const summary = await runWebpushLeadBilling(
      { listTenants: async () => [A, B], billTenant, now: () => 0 },
      { batchSize: 10 },
    );
    expect(billTenant).toHaveBeenCalledTimes(2);
    expect(billTenant).toHaveBeenCalledWith(A, 10);
    expect(summary).toEqual({
      tenants: 2,
      batches: 2,
      billedUnits: 4,
      chargedAmount: 0.04,
      insufficientBalance: [],
      errors: [],
      truncated: false,
    });
  });

  it("keeps billing a house while batches come back full, up to the batch cap", async () => {
    const results = [cobrado(A, 2), cobrado(A, 2), cobrado(A, 1)];
    const billTenant = vi.fn(async () => results.shift() ?? nada(A));
    const summary = await runWebpushLeadBilling(
      { listTenants: async () => [A], billTenant, now: () => 0 },
      { batchSize: 2, maxBatchesPerTenant: 10 },
    );
    expect(billTenant).toHaveBeenCalledTimes(3);
    expect(summary.billedUnits).toBe(5);

    const capped = vi.fn(async () => cobrado(A, 2));
    const cappedSummary = await runWebpushLeadBilling(
      { listTenants: async () => [A], billTenant: capped, now: () => 0 },
      { batchSize: 2, maxBatchesPerTenant: 3 },
    );
    expect(capped).toHaveBeenCalledTimes(3);
    expect(cappedSummary.batches).toBe(3);
  });

  it("isolates houses: an error or missing balance in one never stops the others", async () => {
    const billTenant = vi.fn(async (tenant: string) => {
      if (tenant === A) throw new Error("price_not_found");
      if (tenant === B)
        return { ok: false, status: "saldo_insuficiente", tenant_id: B, units: 7 } as LeadBillTenantResult;
      return cobrado(C, 1);
    });
    const summary = await runWebpushLeadBilling(
      { listTenants: async () => [A, B, C], billTenant, now: () => 0 },
      { batchSize: 10 },
    );
    expect(billTenant).toHaveBeenCalledTimes(3);
    expect(summary.errors).toEqual([{ tenantId: A, message: "price_not_found" }]);
    expect(summary.insufficientBalance).toEqual([{ tenantId: B, pendingUnits: 7 }]);
    expect(summary.billedUnits).toBe(1);
  });

  it("parses numeric amounts returned as strings", async () => {
    const summary = await runWebpushLeadBilling(
      {
        listTenants: async () => [A],
        billTenant: async () => ({ ...cobrado(A, 3), amount: "0.0300" }),
        now: () => 0,
      },
      { batchSize: 10 },
    );
    expect(summary.chargedAmount).toBe(0.03);
  });

  it("stops starting batches once the time budget is spent", async () => {
    let clock = 0;
    const billTenant = vi.fn(async (tenant: string) => {
      clock += 1000;
      return cobrado(tenant, 1);
    });
    const summary = await runWebpushLeadBilling(
      { listTenants: async () => [A, B, C], billTenant, now: () => clock },
      { batchSize: 10, timeBudgetMs: 1500 },
    );
    expect(billTenant).toHaveBeenCalledTimes(2);
    expect(summary.truncated).toBe(true);
  });

  it("propagates a failure to list the houses", async () => {
    await expect(
      runWebpushLeadBilling({
        listTenants: async () => {
          throw new Error("db down");
        },
        billTenant: vi.fn(),
        now: () => 0,
      }),
    ).rejects.toThrow("db down");
  });
});
