// PG1 Task 7 — house-facing price book: the SMS composer (and anything else
// that needs to show "this costs R$ X") reads the price here instead of a
// hard-coded literal.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getEffectivePrices } from "./billing/pricing.server";
import { resolveOperationalTenantId } from "./tenant-access.server";

export const getBillingPrices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return getEffectivePrices(tenantId);
  });
