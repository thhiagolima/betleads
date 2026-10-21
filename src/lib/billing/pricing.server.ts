// PG1 Task 7 — no hard-coded price anywhere in the code: every cost reads
// the price book (Task 2) through these two helpers.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type BillingItem = "sms" | "voice_30s" | "email";

const ITEMS: BillingItem[] = ["sms", "voice_30s", "email"];

/**
 * The price used for internal cost/ROI accounting (campaign report, SMS
 * dashboard ROI, journey cost): `billing_report_unit_price` — for an exempt
 * tenant this is the provider's cost (what Betleads pays), never the sale
 * price. Throws if any item comes back null (no price configured).
 */
export async function getReportUnitPrices(
  tenantId: string,
): Promise<Record<BillingItem, number>> {
  const results = await Promise.all(
    ITEMS.map((item) =>
      supabaseAdmin.rpc("billing_report_unit_price", { _tenant: tenantId, _item: item }),
    ),
  );
  const prices = {} as Record<BillingItem, number>;
  ITEMS.forEach((item, index) => {
    const { data, error } = results[index];
    if (error) throw new Error(error.message);
    if (data == null) {
      throw new Error(`Preço de relatório não encontrado para o item "${item}".`);
    }
    prices[item] = Number(data);
  });
  return prices;
}

export type EffectivePrice = {
  unitPrice: number;
  freeMonthlyUnits: number;
  exempt: boolean;
};

/**
 * The price shown to a house (composer estimate, publication estimate,
 * etc.): `billing_effective_price`, stripped down to the fields that are
 * safe to show a tenant. Never returns `provider_unit_cost` — that field is
 * superadmin-only (see `billing_effective_price` / `hide_sms_provider_cost`).
 */
export async function getEffectivePrices(
  tenantId: string,
): Promise<Record<BillingItem, EffectivePrice>> {
  const results = await Promise.all(
    ITEMS.map((item) =>
      supabaseAdmin.rpc("billing_effective_price", { _tenant: tenantId, _item: item }),
    ),
  );
  const prices = {} as Record<BillingItem, EffectivePrice>;
  ITEMS.forEach((item, index) => {
    const { data, error } = results[index];
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as {
      unit_price?: number | string | null;
      free_monthly_units?: number | string | null;
      exempt?: boolean | null;
    };
    prices[item] = {
      unitPrice: Number(row.unit_price ?? 0),
      freeMonthlyUnits: Number(row.free_monthly_units ?? 0),
      exempt: row.exempt === true,
    };
  });
  return prices;
}
