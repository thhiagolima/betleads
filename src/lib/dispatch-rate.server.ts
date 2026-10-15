// Helpers de cadência por canal e log de execução do dispatcher.
// Centraliza acesso a dispatch_rate_state e dispatcher_runs.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordCompletedRun } from "@/lib/observability/job-monitor.server";

export type Channel = "sms" | "email";

export type RateState = {
  channel: Channel;
  target_per_minute: number;
  max_per_minute: number;
  window_started_at: string;
  sent_in_window: number;
  backoff_until: string | null;
  last_provider_error: string | null;
};

export async function getRateState(channel: Channel): Promise<RateState | null> {
  const { data } = await supabaseAdmin
    .from("dispatch_rate_state")
    .select("*")
    .eq("channel", channel)
    .maybeSingle();
  return (data as RateState | null) ?? null;
}

/** Consome budget (token bucket). Retorna 0 quando em backoff ou no teto do minuto. */
export async function consumeBudget(channel: Channel, want: number): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("consume_dispatch_budget", {
    p_channel: channel,
    p_want: want,
  });
  if (error) {
    console.error("[dispatch-rate] consume_dispatch_budget falhou", channel, error.message);
    return 0;
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

/** Registra rate-limit do provedor: aplica backoff e guarda último erro. */
export async function registerThrottle(
  channel: Channel,
  retryAfterSeconds: number,
  error: string,
): Promise<void> {
  const { error: rpcErr } = await supabaseAdmin.rpc("register_provider_throttle", {
    p_channel: channel,
    p_retry_after_seconds: Math.max(5, Math.floor(retryAfterSeconds)),
    p_error: error.slice(0, 800),
  });
  if (rpcErr) {
    console.error("[dispatch-rate] register_provider_throttle falhou", channel, rpcErr.message);
  }
}

/** Extrai Retry-After de um body/header de resposta. Default 60s. */
export function parseRetryAfter(body: unknown, headers?: Headers | null): number {
  if (headers) {
    const h = headers.get?.("retry-after");
    if (h) {
      const n = Number(h);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 600);
    }
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const cand = o.retry_after ?? o.retryAfter ?? (o.headers as Record<string, unknown> | undefined)?.["retry-after"];
    if (typeof cand === "number" && cand > 0) return Math.min(cand, 600);
    if (typeof cand === "string") {
      const n = Number(cand);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 600);
    }
  }
  return 60;
}

// ============================================================
// dispatcher_runs — log estruturado por execução
// ============================================================

export type RunRecord = {
  channel: string;
  kind?: "tick" | "recovery" | "campaign";
  queue_before?: number;
  claimed?: number;
  sent?: number;
  errors?: number;
  rescheduled?: number;
  rate_limited?: number;
  lock_recovered?: number;
  target_rate?: number | null;
  actual_rate?: number | null;
  stop_reason?: string | null;
  provider?: string | null;
  last_provider_error?: string | null;
  /** Job name for health/heartbeats. Default: `${channel}_${kind}`. */
  job?: string;
  status?: "succeeded" | "failed" | "partial";
  tenantId?: string | null;
  /** Ping the Better Stack heartbeat for `job` (default true). */
  heartbeat?: boolean;
};

/**
 * Writes one already-finished run. Kept for existing callers; long-running
 * jobs should use `startJobRun` (src/lib/observability/job-monitor.server.ts)
 * so a hung worker leaves a 'running' row with a stale heartbeat.
 */
export async function recordRun(start: number, rec: RunRecord) {
  const kind = rec.kind ?? "tick";
  try {
    await recordCompletedRun(
      rec.job ?? `${rec.channel}_${kind}`,
      start,
      { channel: rec.channel, kind, tenantId: rec.tenantId ?? null, provider: rec.provider },
      {
        status: rec.status,
        queue_before: rec.queue_before,
        claimed: rec.claimed,
        sent: rec.sent,
        errors: rec.errors,
        rescheduled: rec.rescheduled,
        rate_limited: rec.rate_limited,
        lock_recovered: rec.lock_recovered,
        target_rate: rec.target_rate,
        actual_rate: rec.actual_rate,
        stop_reason: rec.stop_reason,
        provider: rec.provider,
        last_provider_error: rec.last_provider_error,
      },
      { heartbeat: rec.heartbeat },
    );
  } catch (e) {
    console.error("[dispatch-rate] recordRun insert falhou", e);
  }
}

export async function countQueuePending(table: "sms_flow_leads" | "email_flow_leads"): Promise<number> {
  const { count } = await supabaseAdmin
    .from(table)
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "running"])
    .lte("next_run_at", new Date().toISOString());
  return count ?? 0;
}
