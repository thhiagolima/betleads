import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { withoutProviderCost } from "./sms-credits.functions";

describe("withoutProviderCost", () => {
  it("drops the provider cost from every item in prices, keeps the unit price", () => {
    const out = withoutProviderCost({
      balance: 10,
      prices: {
        sms: { unit_price: 0.08, provider_unit_cost: 0.059, free_monthly_units: 0 },
        voice_30s: { unit_price: 0.09, free_monthly_units: 0 },
      },
    });
    expect(out).toEqual({
      balance: 10,
      prices: {
        sms: { unit_price: 0.08, free_monthly_units: 0 },
        voice_30s: { unit_price: 0.09, free_monthly_units: 0 },
      },
    });
    expect(JSON.stringify(out)).not.toContain("provider_unit_cost");
  });

  it("handles a missing summary or prices", () => {
    expect(withoutProviderCost(null)).toEqual({});
    expect(withoutProviderCost({ balance: 1 })).toEqual({ balance: 1 });
  });
});
