// Server side of the monthly plan lock (PG2 mensalidade, Task 4): the
// house's billing snapshot, who is locked, and who may pay.
//
// - Lock rule (global constraints): `frozen`/`locked_manual` always lock;
//   `locked_unpaid`/`awaiting_first_payment` only with
//   BILLING_ENFORCEMENT_ENABLED === "true"; the superadmin is never locked.
// - Who pays (monthly fee and credits): `admin`, `owner` or `gestor` of the
//   house, and the superadmin.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getCachedTenantBillingState,
  isBillingEnforcementEnabled,
  resolveTenantForBilling,
} from "@/lib/tenant-access.server";

import { isEffectiveLock, type BillingAccessState } from "./billing-view";

export { BILLING_LOCKED_TEXT, TenantBillingLockedError } from "./billing-locked-error";
export { isBillingEnforcementEnabled, resolveTenantForBilling };

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  in: (column: string, values: unknown[]) => LooseQuery<T>;
  limit: (count: number) => LooseQuery<T>;
  maybeSingle: () => Promise<DbResult<T>>;
};
type LooseSupabase = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
  from: <T = unknown>(table: string) => LooseQuery<T>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

/** Roles of a house that may pay the monthly fee and buy credits. */
export const PAYER_ROLES = ["admin", "owner", "gestor"] as const;

export type BillingSnapshotInvoice = {
  id: string;
  amountCents: number;
  dueDate: string;
  status: string;
};

export type TenantBillingSnapshot = {
  state: BillingAccessState;
  invoice: BillingSnapshotInvoice | null;
  nextDueDate: string | null;
  manualBlockReason: string | null;
};

/**
 * The house's billing row and its open invoice, read with `supabaseAdmin`.
 * A house without a `tenant_billing` row reads as `ok` with no invoice.
 */
export async function getTenantBillingSnapshot(tenantId: string): Promise<TenantBillingSnapshot> {
  const db = looseDb(supabaseAdmin);
  const [billingRes, invoiceRes] = await Promise.all([
    db
      .from<{
        access_state: BillingAccessState;
        next_due_date: string | null;
        manual_block_reason: string | null;
      }>("tenant_billing")
      .select("access_state,next_due_date,manual_block_reason")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    // At most one open invoice per house (partial unique index).
    db
      .from<{ id: string; amount_cents: number | string; due_date: string; status: string }>(
        "billing_invoices",
      )
      .select("id,amount_cents,due_date,status")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .maybeSingle(),
  ]);
  if (billingRes.error) throw new Error(billingRes.error.message);
  if (invoiceRes.error) throw new Error(invoiceRes.error.message);

  const billing = billingRes.data;
  const invoice = invoiceRes.data;
  return {
    state: billing?.access_state ?? "ok",
    invoice: invoice
      ? {
          id: invoice.id,
          amountCents: Number(invoice.amount_cents),
          dueDate: invoice.due_date,
          status: invoice.status,
        }
      : null,
    nextDueDate: billing?.next_due_date ?? null,
    manualBlockReason: billing?.manual_block_reason ?? null,
  };
}

/**
 * Whether `userId` is the super admin (`is_super_admin` RPC). Exported so
 * other server modules that need the same check (e.g. the MCP finance scope
 * listing and write gate) share this one definition instead of duplicating
 * it.
 */
export async function isSuperAdminUser(userId: string): Promise<boolean> {
  const { data, error } = await looseDb(supabaseAdmin).rpc("is_super_admin", {
    _user_id: userId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * Whether `userId` is locked out of `tenantId` by billing: the effective lock
 * (`isEffectiveLock` + BILLING_ENFORCEMENT_ENABLED) read from the 5 s
 * tenant-status cache; always false for the superadmin.
 */
export async function isBillingLockedFor(tenantId: string, userId: string): Promise<boolean> {
  const state = await getCachedTenantBillingState(tenantId);
  if (!state || !isEffectiveLock(state, isBillingEnforcementEnabled())) return false;
  return !(await isSuperAdminUser(userId));
}

/**
 * Non-throwing payer check through the caller's own client: true for the
 * superadmin and for an `admin`, `owner` or `gestor` of the house
 * (`user_roles`); false for `member`/`user` or no role.
 */
export async function isTenantPayer(
  supabase: unknown,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const db = looseDb(supabase);
  const { data: superAdmin, error: superAdminError } = await db.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (superAdminError) throw new Error(superAdminError.message);
  if (superAdmin === true) return true;

  const { data, error } = await db
    .from<Array<{ role: string }>>("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .in("role", [...PAYER_ROLES])
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * Accepts an `admin`, `owner` or `gestor` of the house, or the superadmin;
 * anyone else gets `message`. Runs on the caller's own client (RLS lets a
 * user read their own roles); `userId` is the authenticated caller.
 */
export async function requireTenantPayer(
  supabase: unknown,
  tenantId: string,
  message: string,
  userId: string,
): Promise<void> {
  if (!(await isTenantPayer(supabase, tenantId, userId))) throw new Error(message);
}
