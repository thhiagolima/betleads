// Provider failure classification for queue workers (ENV-04 + B1).
//
//   defer   : the provider ANSWERED and refused for now: 429, 5xx, 408/425,
//             402 / insufficient credit, or `temporary` with a real status
//             -> retry later WITHOUT consuming an attempt (60 s, longer on
//                Retry-After; 15 min for credit). The worker caps consecutive
//                no-cost defers per item (MAX_NO_COST_DEFERS) and then falls
//                back to consuming attempts, so nothing loops forever.
//   unknown : no response and the request MAY have reached the provider
//             (client timeout/abort, connection reset; status 0 without a
//             known kind) -> treat as possibly sent: keep the execution
//             `claimed` (reserve_journey_delivery answers `in_flight` for
//             15 min), consume an attempt, retry no sooner than 15 min.
//   provider_account : the provider refused the ACCOUNT (Short Brasil 101 /
//             505, HTTP 401/402/403 from the provider; errorKind
//             `provider_account`). Not the lead's fault: never consumes an
//             attempt, never fails the item, no MAX_NO_COST_DEFERS cap. The
//             item waits for the SMS circuit breaker (sms-provider-breaker).
//   fail    : definitely not accepted (invalid recipient, 4xx, request never
//             left: DNS/ECONNREFUSED) or provider misconfigured (missing
//             credentials) -> the caller's normal attempts/backoff policy.
//
// Workers wrap a non-ok provider result in ProviderSendError so the status,
// body and transport kind survive until the classification.

import { isInsufficientFunds } from "@/lib/dispatch-pause-insufficient.server";
import { parseRetryAfter } from "@/lib/dispatch-rate.server";
import { isProviderErrorKind, type ProviderErrorKind } from "./transport-errors";

export type { ProviderErrorKind } from "./transport-errors";

export type ProviderFailureKind = "defer" | "unknown" | "fail" | "provider_account";

export type ProviderFailureDecision = {
  kind: ProviderFailureKind;
  reason:
    | "insufficient_credit"
    | "provider_account"
    | "provider_rate_limited"
    | "provider_unavailable"
    | "transient_error"
    | "outcome_unknown"
    | "provider_misconfigured"
    | "not_sent"
    | "permanent_error";
  /** Delay before the item becomes due again (defer/unknown only). */
  retryAfterMs: number;
};

export const PROVIDER_DEFER_MS = 60_000;
/** Backoff for missing credit: no pause, the item simply comes back later. */
export const CREDIT_DEFER_MS = 15 * 60_000;
/**
 * Possibly-sent items wait at least this long; matches the `in_flight`
 * window of reserve_journey_delivery (20261015111000, c_in_flight_lease).
 */
export const OUTCOME_UNKNOWN_RETRY_MS = 15 * 60_000;
/** Fallback wait for provider_account when the breaker state is unknown. */
export const PROVIDER_ACCOUNT_DEFER_MS = 2 * 60_000;
/** Consecutive no-cost defers per step before attempts start being consumed. */
export const MAX_NO_COST_DEFERS = 10;
const MAX_DEFER_MS = 10 * 60_000;

export class ProviderSendError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly temporary: boolean;
  readonly channel: string;
  readonly errorKind: ProviderErrorKind | null;

  constructor(args: {
    channel: string;
    message: string;
    status?: number | null;
    body?: unknown;
    temporary?: boolean;
    errorKind?: ProviderErrorKind | null;
  }) {
    super(args.message);
    this.name = "ProviderSendError";
    this.channel = args.channel;
    this.status = Number.isFinite(Number(args.status)) ? Number(args.status) : 0;
    this.body = args.body;
    this.temporary = Boolean(args.temporary);
    this.errorKind = isProviderErrorKind(args.errorKind) ? args.errorKind : null;
  }
}

// Plain errors never come from a provider result (those are wrapped in
// ProviderSendError); they are DB/network blips before the provider call.
const TRANSIENT_MESSAGE =
  /time(?:d)?\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network error|aborted|service unavailable|too many requests|bad gateway|gateway time/i;

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function classifyProviderFailure(error: unknown): ProviderFailureDecision {
  if (error instanceof ProviderSendError) {
    if (error.errorKind === "provider_account") {
      return {
        kind: "provider_account",
        reason: "provider_account",
        retryAfterMs: PROVIDER_ACCOUNT_DEFER_MS,
      };
    }
    if (error.errorKind === "misconfigured") {
      return { kind: "fail", reason: "provider_misconfigured", retryAfterMs: 0 };
    }
    if (error.errorKind === "not_sent") {
      return { kind: "fail", reason: "not_sent", retryAfterMs: 0 };
    }
    // No HTTP response: unless proven otherwise, the provider may have it.
    if (error.errorKind === "outcome_unknown" || error.status === 0) {
      return { kind: "unknown", reason: "outcome_unknown", retryAfterMs: OUTCOME_UNKNOWN_RETRY_MS };
    }
    const body = parseBody(error.body);
    if (
      isInsufficientFunds(error.status, body) ||
      isInsufficientFunds(undefined, error.message)
    ) {
      return { kind: "defer", reason: "insufficient_credit", retryAfterMs: CREDIT_DEFER_MS };
    }
    if (error.status === 429) {
      const hinted = parseRetryAfter(body) * 1000;
      return {
        kind: "defer",
        reason: "provider_rate_limited",
        retryAfterMs: Math.min(MAX_DEFER_MS, Math.max(PROVIDER_DEFER_MS, hinted)),
      };
    }
    if (
      error.status === 408 ||
      error.status === 425 ||
      error.status >= 500 ||
      error.temporary
    ) {
      return { kind: "defer", reason: "provider_unavailable", retryAfterMs: PROVIDER_DEFER_MS };
    }
    return { kind: "fail", reason: "permanent_error", retryAfterMs: 0 };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isInsufficientFunds(undefined, message)) {
    return { kind: "defer", reason: "insufficient_credit", retryAfterMs: CREDIT_DEFER_MS };
  }
  if (TRANSIENT_MESSAGE.test(message)) {
    return { kind: "defer", reason: "transient_error", retryAfterMs: PROVIDER_DEFER_MS };
  }
  return { kind: "fail", reason: "permanent_error", retryAfterMs: 0 };
}
