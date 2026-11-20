// Error thrown by the send guards when the house is suspended or canceled
// (SA-02, auditoria 2026-11-19).
//
// Pure module (no server-only import): the UI can recognize the error after a
// server function serializes it, and the server guards throw it.

export const TENANT_SUSPENDED_CODE = "TENANT_SUSPENDED" as const;
export const TENANT_SUSPENDED_TEXT = "Esta casa está suspensa ou encerrada: nenhum envio sai.";

/**
 * The house's `tenants.status` is `suspended` or `canceled`: nothing may be
 * sent on its behalf, on any channel, for anyone. Like
 * `TenantBillingLockedError`, a dispatcher treats it as a final failure and
 * never retries the item (`isSendBlockedError`).
 */
export class TenantSuspendedError extends Error {
  code: typeof TENANT_SUSPENDED_CODE;

  constructor() {
    super(TENANT_SUSPENDED_TEXT);
    this.name = "TenantSuspendedError";
    this.code = TENANT_SUSPENDED_CODE;
  }
}

/**
 * Recognizes the refusal in any shape it may arrive in: the instance, an
 * object with `code = "TENANT_SUSPENDED"`, or a message/string that carries
 * the code or the exact copy (a result object's `error`, a ProviderSendError
 * built from it, or a serialized server function error).
 */
export function isTenantSuspendedError(e: unknown): boolean {
  if (e instanceof TenantSuspendedError) return true;
  if (!e) return false;
  if (typeof e === "string") return matchesText(e);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === TENANT_SUSPENDED_CODE) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return matchesText(message);
  }
  return false;
}

function matchesText(text: string): boolean {
  return text.includes(TENANT_SUSPENDED_CODE) || text.includes(TENANT_SUSPENDED_TEXT);
}
