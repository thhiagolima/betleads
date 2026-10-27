// Error thrown when the monthly plan locks a house (PG2 mensalidade, Task 4).
//
// Pure module (no server-only import): the UI can recognize the error after
// a server function serializes it, and the server guards throw it.

import { isDemoBlockedError } from "../demo-tenant";

export const BILLING_LOCKED_CODE = "BILLING_LOCKED" as const;
export const BILLING_LOCKED_TEXT = "Acesso suspenso. Regularize a mensalidade em Plano e créditos.";

/**
 * The house has an effective billing lock (`isEffectiveLock`): it cannot
 * operate (for anyone but the superadmin) nor send (for anyone). Like
 * `DemoTenantBlockedError`, a dispatcher treats it as a final failure and
 * never retries the item.
 */
export class TenantBillingLockedError extends Error {
  code: typeof BILLING_LOCKED_CODE;

  constructor() {
    super(BILLING_LOCKED_TEXT);
    this.name = "TenantBillingLockedError";
    this.code = BILLING_LOCKED_CODE;
  }
}

/**
 * Recognizes a billing lock in any shape it may arrive in: the instance, an
 * object with `code = "BILLING_LOCKED"`, or a message/string that carries the
 * code or the exact copy (a result object's `error`, a ProviderSendError
 * built from it, or a serialized server function error).
 */
export function isBillingLockedError(e: unknown): boolean {
  if (e instanceof TenantBillingLockedError) return true;
  if (!e) return false;
  if (typeof e === "string") return matchesText(e);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === BILLING_LOCKED_CODE) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return matchesText(message);
  }
  return false;
}

function matchesText(text: string): boolean {
  return text.includes(BILLING_LOCKED_CODE) || text.includes(BILLING_LOCKED_TEXT);
}

/** A send refused by a tenant guard (demo or billing lock): final, never retried. */
export function isSendBlockedError(e: unknown): boolean {
  return isDemoBlockedError(e) || isBillingLockedError(e);
}
