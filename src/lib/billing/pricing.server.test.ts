// PG1 Task 7 — getReportUnitPrices / getEffectivePrices read the price book
// through billing_report_unit_price / billing_effective_price (Task 2) only;
// no literal price lives in this module.
import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...(args as [string, Record<string, unknown>])) },
}));

import { getEffectivePrices, getReportUnitPrices } from "./pricing.server";

describe("getReportUnitPrices", () => {
  it("returns sms/voice_30s/email via billing_report_unit_price", async () => {
    const byItem: Record<string, number> = { sms: 0.08, voice_30s: 0.09, email: 0.002 };
    rpc.mockImplementation((fn: string, args: { _tenant: string; _item: string }) => {
      expect(fn).toBe("billing_report_unit_price");
      return Promise.resolve({ data: byItem[args._item], error: null });
    });

    const prices = await getReportUnitPrices("tenant-1");

    expect(prices).toEqual({ sms: 0.08, voice_30s: 0.09, email: 0.002 });
  });

  it("throws if any item comes back null", async () => {
    rpc.mockImplementation((_fn: string, args: { _item: string }) =>
      Promise.resolve({ data: args._item === "email" ? null : 0.08, error: null }),
    );

    await expect(getReportUnitPrices("tenant-1")).rejects.toThrow();
  });

  it("throws the RPC error message instead of swallowing it", async () => {
    rpc.mockImplementation(() =>
      Promise.resolve({ data: null, error: { message: "forbidden" } }),
    );

    await expect(getReportUnitPrices("tenant-1")).rejects.toThrow("forbidden");
  });
});

describe("getEffectivePrices", () => {
  it("maps billing_effective_price into unitPrice/freeMonthlyUnits/exempt", async () => {
    rpc.mockImplementation((fn: string, args: { _item: string }) => {
      expect(fn).toBe("billing_effective_price");
      return Promise.resolve({
        data: {
          item: args._item,
          unit_price: 0.08,
          provider_unit_cost: 0.059,
          free_monthly_units: 0,
          exempt: false,
          source: "default",
        },
        error: null,
      });
    });

    const prices = await getEffectivePrices("tenant-1");

    expect(prices.sms).toEqual({ unitPrice: 0.08, freeMonthlyUnits: 0, exempt: false });
  });

  it("never returns provider_unit_cost, house-facing", async () => {
    rpc.mockImplementation(() =>
      Promise.resolve({
        data: { unit_price: 0.08, provider_unit_cost: 0.059, free_monthly_units: 0, exempt: true },
        error: null,
      }),
    );

    const prices = await getEffectivePrices("tenant-1");

    expect(JSON.stringify(prices)).not.toContain("provider_unit_cost");
    expect(prices.sms.exempt).toBe(true);
  });
});
