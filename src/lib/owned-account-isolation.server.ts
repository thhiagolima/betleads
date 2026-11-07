// Conta própria de provedor (Task 9): isolation of a house-owned provider
// account (sms / email / voice) from everybody else on the same instance.
//
//   * Timeout: every request to an owned account is aborted after
//     OWNED_ACCOUNT_REQUEST_TIMEOUT_MS. Platform accounts keep the timeout
//     each adapter always had.
//   * Concurrency: at most OWNED_ACCOUNT_MAX_INFLIGHT requests in flight per
//     owned account (semaphore per `account.id`, per instance; shared by the
//     account's channels). A send over the limit is NOT made: the caller hands
//     the item back to the queue with the 429-shaped result below (item
//     backoff: nothing sent, nothing charged, no attempt consumed). Platform
//     accounts have no limit here.
//
// Pure module (no node-only imports): the Infobip adapters are in the client
// module graph (tree-shaken).

export const OWNED_ACCOUNT_REQUEST_TIMEOUT_MS = 8_000;
export const OWNED_ACCOUNT_MAX_INFLIGHT = 4;

/** Status of the "over the limit" result: the existing per-item 429 backoff of every worker. */
export const OWNED_ACCOUNT_BUSY_STATUS = 429;
export const OWNED_ACCOUNT_BUSY_MESSAGE =
  "Conta própria da casa no limite de envios simultâneos; o envio volta para a fila.";

type AccountRef = { id: string; ownerTenantId: string | null };

const owned = (account: AccountRef) => account.ownerTenantId !== null;

/** Request timeout for `account`: owned accounts get OWNED_ACCOUNT_REQUEST_TIMEOUT_MS. */
export function requestTimeoutMsFor(account: AccountRef, platformMs: number): number {
  return owned(account) ? OWNED_ACCOUNT_REQUEST_TIMEOUT_MS : platformMs;
}

/** The provider did not answer within the request timeout (no HTTP response). */
export class ProviderRequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isProviderRequestTimeout(error: unknown): error is ProviderRequestTimeoutError {
  return error instanceof ProviderRequestTimeoutError;
}

/**
 * fetch() + reading the body as text, both bounded by `timeoutMs`
 * (setTimeout + AbortController rather than AbortSignal.timeout, so the
 * deadline is the timer every test fakes). A timeout throws
 * ProviderRequestTimeoutError (`message`), which the transport classification
 * reads as outcome_unknown: the request may have been accepted.
 */
export async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  message = `Provedor não respondeu em ${timeoutMs / 1000}s`,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, text: await response.text() };
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderRequestTimeoutError(message, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same deadline, response headers only (the caller reads the body). Kept for
 * the Short Brasil adapter, whose timeout always covered only the headers.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  message = `Provedor não respondeu em ${timeoutMs / 1000}s`,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderRequestTimeoutError(message, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type AccountSlot = { release(): void };

const NO_LIMIT: AccountSlot = { release() {} };
const inflight = new Map<string, number>();

/**
 * One in-flight request slot of `account`. null = the owned account already
 * has OWNED_ACCOUNT_MAX_INFLIGHT requests in flight on this instance: do not
 * send, hand the item back. Platform accounts always get a (no-op) slot.
 * `release` is idempotent.
 */
export function tryAcquireAccountSlot(account: AccountRef): AccountSlot | null {
  if (!owned(account)) return NO_LIMIT;
  const used = inflight.get(account.id) ?? 0;
  if (used >= OWNED_ACCOUNT_MAX_INFLIGHT) {
    console.warn("[owned-account] limite de envios simultâneos; item volta para a fila", {
      providerAccountId: account.id,
      inflight: used,
    });
    return null;
  }
  inflight.set(account.id, used + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const left = (inflight.get(account.id) ?? 1) - 1;
      if (left <= 0) inflight.delete(account.id);
      else inflight.set(account.id, left);
    },
  };
}

/** Requests in flight of an owned account on this instance (observability/tests). */
export function ownedAccountInflight(accountId: string): number {
  return inflight.get(accountId) ?? 0;
}

/** Test hook. */
export function __resetOwnedAccountIsolationForTests() {
  inflight.clear();
}
