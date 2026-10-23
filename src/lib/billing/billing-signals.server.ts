// PG6-03: records billing signals that otherwise leave no trace in the
// database (an Upper webhook with an invalid signature, an Upper API answer
// of 403 FEATURE_DISABLED or 401). Each call increments an hourly counter in
// `billing_monitor_signals` through `billing_record_signal` (service_role
// RPC, migration 20261024100400), which the billing health monitor
// (billing-health.server.ts) reads. `upper_unavailable` covers Upper 5xx,
// timeouts and network errors.
//
// Fire-and-forget and never throws: monitoring must never change what the
// webhook answers or how an Upper call fails. The detail is a short reason or
// error code only, never a secret, a header or a payload.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type BillingSignalCode =
  | "webhook_invalid_signature"
  | "upper_feature_disabled"
  | "upper_unauthorized"
  | "upper_unavailable";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = any;

export function recordBillingSignal(code: BillingSignalCode, detail: string | null): Promise<void> {
  try {
    const call = (supabaseAdmin as LooseDb).rpc("billing_record_signal", {
      _code: code,
      _detail: detail ? detail.slice(0, 200) : null,
    }) as PromiseLike<{ error: { message: string } | null }>;
    return Promise.resolve(call).then(
      (res) => {
        if (res?.error) {
          console.error("[billing-signals] record failed", { code, error: res.error.message });
        }
      },
      (error: unknown) => {
        console.error("[billing-signals] record failed", {
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  } catch (error) {
    console.error("[billing-signals] record failed", {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    return Promise.resolve();
  }
}

/**
 * Maps an Upper API error to the signal it should raise, or null. 403
 * FEATURE_DISABLED means the account's Pix functions are off (KYC); 401
 * (INVALID_API_KEY) means our key stopped working. Both block every charge.
 */
export function upperErrorSignal(status: number, code: string | null): BillingSignalCode | null {
  if (code === "FEATURE_DISABLED") return "upper_feature_disabled";
  if (status === 401 || code === "INVALID_API_KEY") return "upper_unauthorized";
  // Upper down: any 5xx, or a timeout/network failure (status 0).
  if (status >= 500 || code === "TIMEOUT" || code === "NETWORK_ERROR") return "upper_unavailable";
  return null;
}
