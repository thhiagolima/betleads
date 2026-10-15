// Channel budget: DB-backed rate limits shared by every process (ENV-04).
//
// Limits live in public.channel_rate_limits (editable without deploy):
//   scope 'global'         tenant_id NULL  shared by all tenants
//   scope 'tenant_default' tenant_id NULL  applied to each tenant separately
//   scope 'tenant'         tenant_id set   overrides tenant_default
//   per_second      token bucket rate (burst defaults to max(1, per_second))
//   max_concurrency semaphore size; permits expire after concurrency_hold_seconds
// Seed (docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md, seção 5):
//   sms 15/s global, 5/s per tenant; email 10/s, 4/s; voice 5 / 2 concurrent.
// A channel without rows is unlimited.
//
// Usage (one send):
//
//   const admission = await channelBudget.acquire(tenantId, "sms", { deadline });
//   if (!admission.ok) return deferItem(admission.retryAfterMs); // no attempt consumed
//   try {
//     const result = await send();
//     if (!result.ok) throw new ProviderSendError({...});   // see provider-errors.server.ts
//   } catch (error) {
//     await channelBudget.release(admission);                // frees a concurrency permit
//     throw error;
//   }
//   // On success keep a voice permit: the call is ongoing; it expires after hold.
//   // For non-concurrency channels release() is a no-op.
//
// Bulk senders can call consume(tenantId, channel, n) and send `granted` items.
// RPC errors fail closed (nothing granted, retry in 30 s): a broken limiter must
// not turn into an unlimited burst against the provider.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sleep as defaultSleep } from "./pool";

export type BudgetChannel = "sms" | "email" | "voice" | (string & {});
export type LimitedBy = "global" | "tenant" | "error" | null;

export type BudgetGrant = { granted: number; retryAfterMs: number; limitedBy: LimitedBy };

export type Admission =
  | { ok: true; permitId: string | null; waitedMs: number }
  | { ok: false; retryAfterMs: number; limitedBy: LimitedBy; waitedMs: number };

export type AcquireOptions = {
  /** Wait for tokens at most this long in total (default 2000 ms). */
  maxWaitMs?: number;
  /** Absolute epoch ms after which no more waiting happens. */
  deadline?: number;
  /** Also take a concurrency permit (default: true for voice). */
  slot?: boolean;
  /** Permit TTL override in seconds (default: concurrency_hold_seconds). */
  holdSeconds?: number;
  /** Diagnostic label stored with the permit. */
  holder?: string;
  provider?: string;
};

type RpcResult = { data: unknown; error: { message: string } | null };
export type ChannelBudgetRpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

export const ERROR_RETRY_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 2_000;

const defaultRpc: ChannelBudgetRpc = async (fn, args) => {
  // The generated types know these RPCs only after the migration is deployed.
  const { data, error } = await (
    supabaseAdmin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
    }
  ).rpc(fn, args);
  return { data, error };
};

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
  return (data as Record<string, unknown>) ?? null;
}

export function createChannelBudget(
  options: {
    rpc?: ChannelBudgetRpc;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string, detail: Record<string, unknown>) => void;
  } = {},
) {
  const rpc = options.rpc ?? defaultRpc;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((message: string, detail: Record<string, unknown>) =>
      console.error(`[channel-budget] ${message}`, detail));

  /** Takes up to `n` tokens for (tenant, channel) right now; never waits. */
  async function consume(
    tenantId: string,
    channel: BudgetChannel,
    n = 1,
    provider?: string,
  ): Promise<BudgetGrant> {
    const { data, error } = await rpc("consume_channel_budget", {
      p_tenant_id: tenantId,
      p_channel: channel,
      p_n: n,
      p_provider: provider ?? null,
    });
    if (error) {
      log("consume_channel_budget failed", { channel, error: error.message });
      return { granted: 0, retryAfterMs: ERROR_RETRY_MS, limitedBy: "error" };
    }
    const row = firstRow(data);
    return {
      granted: Number(row?.granted ?? 0),
      retryAfterMs: Number(row?.retry_after_ms ?? 0),
      limitedBy: (row?.limited_by as LimitedBy) ?? null,
    };
  }

  async function acquireSlot(
    tenantId: string,
    channel: BudgetChannel,
    opts: AcquireOptions,
  ): Promise<{ ok: true; permitId: string | null } | { ok: false; retryAfterMs: number; limitedBy: LimitedBy }> {
    const { data, error } = await rpc("acquire_channel_slot", {
      p_tenant_id: tenantId,
      p_channel: channel,
      p_holder: opts.holder ?? null,
      p_hold_seconds: opts.holdSeconds ?? null,
      p_provider: opts.provider ?? null,
    });
    if (error) {
      log("acquire_channel_slot failed", { channel, error: error.message });
      return { ok: false, retryAfterMs: ERROR_RETRY_MS, limitedBy: "error" };
    }
    const row = firstRow(data);
    const permitId = (row?.permit_id as string | null) ?? null;
    const limitedBy = (row?.limited_by as LimitedBy) ?? null;
    if (!permitId && limitedBy) {
      return { ok: false, retryAfterMs: Number(row?.retry_after_ms ?? 1000), limitedBy };
    }
    return { ok: true, permitId };
  }

  /** Frees a concurrency permit (no-op for admissions without one). */
  async function release(admission: Admission | { permitId: string | null } | null | undefined) {
    const permitId = admission && "permitId" in admission ? admission.permitId : null;
    if (!permitId) return;
    const { error } = await rpc("release_channel_slot", { p_permit_id: permitId });
    if (error) log("release_channel_slot failed", { error: error.message });
  }

  /**
   * Admits one send: waits (sleeping the hinted retry time) while the bucket
   * is empty, up to `maxWaitMs` and `deadline`. Returns ok:false with
   * retryAfterMs when the caller should defer the item instead.
   */
  async function acquire(
    tenantId: string,
    channel: BudgetChannel,
    opts: AcquireOptions = {},
  ): Promise<Admission> {
    const startedAt = now();
    const waitLimit = Math.min(
      startedAt + (opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS),
      opts.deadline ?? Number.POSITIVE_INFINITY,
    );
    const wantsSlot = opts.slot ?? channel === "voice";
    for (;;) {
      let permitId: string | null = null;
      let denial: { retryAfterMs: number; limitedBy: LimitedBy } | null = null;
      if (wantsSlot) {
        const slot = await acquireSlot(tenantId, channel, opts);
        if (slot.ok) permitId = slot.permitId;
        else denial = slot;
      }
      if (!denial) {
        const grant = await consume(tenantId, channel, 1, opts.provider);
        if (grant.granted >= 1) return { ok: true, permitId, waitedMs: now() - startedAt };
        await release({ permitId });
        denial = { retryAfterMs: Math.max(1, grant.retryAfterMs), limitedBy: grant.limitedBy };
      }
      const wakeAt = now() + denial.retryAfterMs;
      if (denial.limitedBy === "error" || wakeAt > waitLimit) {
        return {
          ok: false,
          retryAfterMs: denial.retryAfterMs,
          limitedBy: denial.limitedBy,
          waitedMs: now() - startedAt,
        };
      }
      await sleep(denial.retryAfterMs);
    }
  }

  return { consume, acquire, release };
}

export type ChannelBudget = ReturnType<typeof createChannelBudget>;

/** Process-wide instance backed by supabaseAdmin. */
export const channelBudget: ChannelBudget = createChannelBudget();

// ---------------------------------------------------------------------------
// Tenant channel pause (dispatch_pause_state, same table as the UI switch and
// the SMS/e-mail flow claims). Journeys/campaigns stop claiming the channel for
// that tenant until someone resumes it in the UI.
// ---------------------------------------------------------------------------

export type PauseChannel = "sms" | "email" | "call";

export function pauseChannelFor(channel: BudgetChannel): PauseChannel | null {
  if (channel === "sms") return "sms";
  if (channel === "email") return "email";
  if (channel === "voice" || channel === "call") return "call";
  return null;
}

const lastPauseAt = new Map<string, number>();

export async function pauseTenantChannel(
  tenantId: string,
  channel: BudgetChannel,
  reason: string,
): Promise<boolean> {
  const pauseChannel = pauseChannelFor(channel);
  if (!pauseChannel) return false;
  const key = `${tenantId}:${pauseChannel}`;
  const at = Date.now();
  if ((lastPauseAt.get(key) ?? 0) > at - 5_000) return true;
  lastPauseAt.set(key, at);
  const nowIso = new Date(at).toISOString();
  const { error } = await supabaseAdmin.from("dispatch_pause_state").upsert(
    {
      tenant_id: tenantId,
      channel: pauseChannel,
      paused: true,
      paused_at: nowIso,
      reason: reason.slice(0, 500),
      updated_at: nowIso,
    },
    { onConflict: "channel,tenant_id" },
  );
  if (error) {
    console.error("[channel-budget] pauseTenantChannel failed", {
      tenantId,
      channel: pauseChannel,
      error: error.message,
    });
    return false;
  }
  return true;
}
