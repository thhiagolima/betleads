import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { withoutProviderCost } from "./sms-credits.functions";

describe("withoutProviderCost", () => {
  it("drops the provider cost and keeps the sale price", () => {
    const out = withoutProviderCost({
      balance_credits: 10,
      pricing: { sale_price_per_sms: 0.12, provider_cost_per_sms: 0.059, low_balance_threshold: 5 },
    });
    expect(out).toEqual({
      balance_credits: 10,
      pricing: { sale_price_per_sms: 0.12, low_balance_threshold: 5 },
    });
    expect(JSON.stringify(out)).not.toContain("provider_cost");
  });

  it("handles a missing summary or pricing", () => {
    expect(withoutProviderCost(null)).toEqual({});
    expect(withoutProviderCost({ balance_credits: 1 })).toEqual({ balance_credits: 1 });
  });
});
