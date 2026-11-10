// Web push — billing PER LEAD (item `webpush_lead`, R$ 0,01 per new push
// subscription, charged once). The hourly cron
// (20261222100000_webpush_lead_billing_cron.sql) hits
// /api/public/hooks/webpush-lead-billing, which runs `runWebpushLeadBilling`.
//
// All the money logic lives in SQL
// (20261217100000_webpush_lead_billing.sql): `webpush_lead_bill_tenant`
// locks up to N pending subscriptions of ONE house, reserves them in the
// wallet and marks them billed in a single transaction, with an idempotency
// key derived from the exact set of rows — a crash or retry can neither
// double-charge nor skip. This module only loops: one RPC per house per batch
// (one transaction each), so a failure in one house never blocks another.
// A house without balance is left pending and retried next hour.
//
// The public subscribe endpoint (subscriptions.server.ts) never touches any
// of this.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const LEAD_BILLING_BATCH_SIZE = 1000;
/** Batches per house per run: 20 x 1000 = 20k leads/hour per house. */
export const LEAD_BILLING_MAX_BATCHES_PER_TENANT = 20;
export const LEAD_BILLING_MAX_TENANTS = 500;
/** Stop starting new batches after this (the cron's HTTP timeout is 55 s). */
export const LEAD_BILLING_TIME_BUDGET_MS = 40_000;

export type LeadBillTenantResult = {
  ok: boolean;
  status: "nada" | "cobrado" | "saldo_insuficiente";
  tenant_id: string;
  units: number;
  amount?: number | string;
  ledger_id?: string;
  exempt?: boolean;
  idempotent?: boolean;
};

export type LeadBillingDeps = {
  listTenants: (limit: number) => Promise<string[]>;
  billTenant: (tenantId: string, limit: number) => Promise<LeadBillTenantResult>;
  now: () => number;
};

export type LeadBillingSummary = {
  tenants: number;
  batches: number;
  billedUnits: number;
  chargedAmount: number;
  insufficientBalance: Array<{ tenantId: string; pendingUnits: number }>;
  errors: Array<{ tenantId: string; message: string }>;
  /** True when the time budget ran out before every house was finished. */
  truncated: boolean;
};

const defaultDeps: LeadBillingDeps = {
  async listTenants(limit) {
    const { data, error } = await supabaseAdmin.rpc("webpush_lead_billing_tenants", {
      _limit: limit,
    });
    if (error) throw new Error(`webpush_lead_billing_tenants: ${error.message}`);
    return (data ?? []) as string[];
  },
  async billTenant(tenantId, limit) {
    const { data, error } = await supabaseAdmin.rpc("webpush_lead_bill_tenant", {
      _tenant: tenantId,
      _limit: limit,
    });
    if (error) throw new Error(error.message);
    return data as unknown as LeadBillTenantResult;
  },
  now: () => Date.now(),
};

export async function runWebpushLeadBilling(
  overrides: Partial<LeadBillingDeps> = {},
  opts: {
    batchSize?: number;
    maxBatchesPerTenant?: number;
    maxTenants?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<LeadBillingSummary> {
  const deps = { ...defaultDeps, ...overrides };
  const batchSize = opts.batchSize ?? LEAD_BILLING_BATCH_SIZE;
  const maxBatches = opts.maxBatchesPerTenant ?? LEAD_BILLING_MAX_BATCHES_PER_TENANT;
  const deadline = deps.now() + (opts.timeBudgetMs ?? LEAD_BILLING_TIME_BUDGET_MS);

  const tenants = await deps.listTenants(opts.maxTenants ?? LEAD_BILLING_MAX_TENANTS);
  const summary: LeadBillingSummary = {
    tenants: tenants.length,
    batches: 0,
    billedUnits: 0,
    chargedAmount: 0,
    insufficientBalance: [],
    errors: [],
    truncated: false,
  };

  outer: for (const tenantId of tenants) {
    for (let i = 0; i < maxBatches; i++) {
      if (deps.now() >= deadline) {
        summary.truncated = true;
        break outer;
      }
      let result: LeadBillTenantResult;
      try {
        result = await deps.billTenant(tenantId, batchSize);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push({ tenantId, message });
        break;
      }
      if (result.status === "saldo_insuficiente") {
        summary.insufficientBalance.push({ tenantId, pendingUnits: Number(result.units) || 0 });
        break;
      }
      if (result.status !== "cobrado") break;
      summary.batches += 1;
      summary.billedUnits += Number(result.units) || 0;
      summary.chargedAmount += Number(result.amount) || 0;
      // A short batch means nothing else is pending for this house (rows
      // locked by a concurrent run are skipped and picked up next hour).
      if ((Number(result.units) || 0) < batchSize) break;
    }
  }

  summary.chargedAmount = Math.round(summary.chargedAmount * 10_000) / 10_000;
  return summary;
}
