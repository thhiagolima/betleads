import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { resolveOperationalTenantId } from "@/lib/tenant-access.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";

const channelSchema = z.enum(["sms", "email", "voice"]);
export type ObservabilityChannel = z.infer<typeof channelSchema>;

export type ChannelObservability = {
  channel: ObservabilityChannel;
  provider: string;
  providerConfigured: boolean;
  providerAvailable: boolean;
  providerError: string | null;
  paused: boolean;
  pauseReason: string | null;
  pending: number;
  stuck: number;
  sent24h: number;
  delivered24h: number;
  failed24h: number;
  deliveryRate: number;
  errorRate: number;
  lastWorkerAt: string | null;
  workerDelayMinutes: number | null;
  workerHealthy: boolean;
};

type StatusRow = { status: string; delivery_status?: string | null };
type RunRow = {
  channel: string;
  started_at: string;
  finished_at: string | null;
  errors: number;
  stop_reason: string | null;
};
type RateRow = {
  channel: string;
  last_provider_error: string | null;
  backoff_until: string | null;
};

const channelAliases: Record<ObservabilityChannel, string[]> = {
  sms: ["sms"],
  email: ["email"],
  voice: ["call", "voice"],
};

function rate(values: number, total: number) {
  return total > 0 ? Math.round((values / total) * 10_000) / 100 : 0;
}

export function summarizeChannelDelivery(channel: ObservabilityChannel, rows: StatusRow[]) {
  const failedStates = new Set(["failed", "falhou", "error", "rejected", "cancelled"]);
  const deliveredStates = new Set(["delivered", "completed", "answered", "sent", "enviado"]);
  let failed = 0;
  let delivered = 0;
  for (const row of rows) {
    const status = String(row.delivery_status ?? row.status ?? "").toLowerCase();
    if (failedStates.has(status)) failed += 1;
    if (deliveredStates.has(status)) delivered += 1;
  }
  // Voz não possui um callback "delivered"; chamada concluída/atendida é o equivalente operacional.
  if (channel === "voice" && delivered === 0) {
    delivered = rows.filter((row) => ["completed", "answered"].includes(row.status)).length;
  }
  return { total: rows.length, failed, delivered };
}

function providerConfigured(channel: ObservabilityChannel) {
  if (channel === "sms") {
    return Boolean(process.env.SHORT_BRASIL_SMS_USUARIO && process.env.SHORT_BRASIL_SMS_CHAVE);
  }
  return Boolean(process.env.INFOBIP_BASE_URL && process.env.INFOBIP_API_KEY);
}

async function auditOperation(args: {
  tenantId: string;
  userId: string;
  action: string;
  channel: ObservabilityChannel;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin.from("tenant_audit_logs").insert({
    tenant_id: args.tenantId,
    actor_user_id: args.userId,
    action: args.action,
    entity_type: "channel_operation",
    entity_id: args.channel,
    before_data: (args.before ?? null) as Json,
    after_data: (args.after ?? null) as Json,
    metadata: (args.metadata ?? {}) as Json,
  });
  if (error) throw new Error(`A ação foi executada, mas a auditoria falhou: ${error.message}`);
}

export const getChannelObservability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({ context }): Promise<{ channels: ChannelObservability[]; generatedAt: string }> => {
      // Operational provider, queue and worker data is platform infrastructure,
      // never tenant-facing information. Keep this guard server-side so a
      // direct server-function request is denied as well as the UI access.
      await assertSuperAdmin(context.userId);
      const tenantId = await resolveOperationalTenantId(context.supabase);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const campaignStuckBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const voiceStuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const [
        pauses,
        rates,
        runs,
        smsPending,
        smsStuck,
        emailPending,
        emailStuck,
        voicePending,
        voiceStuck,
        smsLogs,
        emailLogs,
        voiceLogs,
      ] = await Promise.all([
        supabaseAdmin
          .from("dispatch_pause_state")
          .select("channel,paused,reason")
          .eq("tenant_id", tenantId),
        supabaseAdmin
          .from("dispatch_rate_state")
          .select("channel,last_provider_error,backoff_until"),
        supabaseAdmin
          .from("dispatcher_runs")
          .select("channel,started_at,finished_at,errors,stop_reason")
          .order("started_at", { ascending: false })
          .limit(60),
        supabaseAdmin
          .from("sms_campaigns")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .in("status", ["agendada", "enviando"]),
        supabaseAdmin
          .from("sms_campaigns")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "enviando")
          .lt("locked_at", campaignStuckBefore),
        supabaseAdmin
          .from("email_campaigns")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .in("status", ["agendada", "enviando"]),
        supabaseAdmin
          .from("email_campaigns")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "enviando")
          .lt("locked_at", campaignStuckBefore),
        supabaseAdmin
          .from("call_queue")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .in("status", ["pending_audio", "audio_ready", "queued", "waiting_provider", "calling"]),
        supabaseAdmin
          .from("call_queue")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "calling")
          .lt("updated_at", voiceStuckBefore),
        supabaseAdmin
          .from("sms_send_logs")
          .select("status,delivery_status")
          .eq("tenant_id", tenantId)
          .gte("created_at", since)
          .limit(10_000),
        supabaseAdmin
          .from("email_send_logs")
          .select("status")
          .eq("tenant_id", tenantId)
          .gte("created_at", since)
          .limit(10_000),
        supabaseAdmin
          .from("call_history")
          .select("status")
          .eq("tenant_id", tenantId)
          .gte("created_at", since)
          .limit(10_000),
      ]);

      const results = [
        pauses,
        rates,
        runs,
        smsPending,
        smsStuck,
        emailPending,
        emailStuck,
        voicePending,
        voiceStuck,
        smsLogs,
        emailLogs,
        voiceLogs,
      ];
      const failedQuery = results.find((result) => result.error);
      if (failedQuery?.error) throw new Error(failedQuery.error.message);

      const pending = {
        sms: smsPending.count ?? 0,
        email: emailPending.count ?? 0,
        voice: voicePending.count ?? 0,
      };
      const stuck = {
        sms: smsStuck.count ?? 0,
        email: emailStuck.count ?? 0,
        voice: voiceStuck.count ?? 0,
      };
      const logs = {
        sms: summarizeChannelDelivery("sms", smsLogs.data ?? []),
        email: summarizeChannelDelivery("email", emailLogs.data ?? []),
        voice: summarizeChannelDelivery("voice", voiceLogs.data ?? []),
      };
      const pauseRows = pauses.data ?? [];
      const rateRows = (rates.data ?? []) as RateRow[];
      const runRows = (runs.data ?? []) as RunRow[];

      const channels = (["sms", "email", "voice"] as const).map((channel) => {
        const aliases = channelAliases[channel];
        const pause = pauseRows.find((row) => aliases.includes(row.channel));
        const providerRate = rateRows.find((row) => aliases.includes(row.channel));
        const lastRun = runRows.find((row) => aliases.includes(row.channel));
        const workerDelayMinutes = lastRun
          ? Math.max(0, Math.floor((Date.now() - new Date(lastRun.started_at).getTime()) / 60_000))
          : null;
        const backoffActive = providerRate?.backoff_until
          ? new Date(providerRate.backoff_until).getTime() > Date.now()
          : false;
        const configured = providerConfigured(channel);
        const providerError = backoffActive ? (providerRate?.last_provider_error ?? null) : null;
        return {
          channel,
          provider: channel === "sms" ? "Short Brasil" : "Infobip",
          providerConfigured: configured,
          providerAvailable: configured && !providerError,
          providerError,
          paused: pause?.paused ?? false,
          pauseReason: pause?.reason ?? null,
          pending: pending[channel],
          stuck: stuck[channel],
          sent24h: logs[channel].total,
          delivered24h: logs[channel].delivered,
          failed24h: logs[channel].failed,
          deliveryRate: rate(logs[channel].delivered, logs[channel].total),
          errorRate: rate(logs[channel].failed, logs[channel].total),
          lastWorkerAt: lastRun?.started_at ?? null,
          workerDelayMinutes,
          workerHealthy:
            workerDelayMinutes !== null && workerDelayMinutes <= 10 && !lastRun?.stop_reason,
        } satisfies ChannelObservability;
      });

      return { channels, generatedAt: new Date().toISOString() };
    },
  );

export const setChannelOperationalPause = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) =>
    z
      .object({
        channel: channelSchema,
        paused: z.boolean(),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const dbChannel = data.channel === "voice" ? "call" : data.channel;
    const { data: before } = await supabaseAdmin
      .from("dispatch_pause_state")
      .select("channel,paused,paused_at,reason")
      .eq("tenant_id", tenantId)
      .eq("channel", dbChannel)
      .maybeSingle();
    const after = {
      tenant_id: tenantId,
      channel: dbChannel,
      paused: data.paused,
      paused_at: data.paused ? new Date().toISOString() : null,
      reason: data.reason,
    };
    const { error } = await supabaseAdmin
      .from("dispatch_pause_state")
      .upsert(after, { onConflict: "channel,tenant_id" });
    if (error) throw new Error(error.message);
    await auditOperation({
      tenantId,
      userId: context.userId,
      action: data.paused ? "channel.paused" : "channel.resumed",
      channel: data.channel,
      before,
      after,
    });
    return { ok: true };
  });

export const reprocessStuckChannel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => z.object({ channel: channelSchema }).parse(value))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const campaignStuckBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const voiceStuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let recoveredIds: string[] = [];

    if (data.channel === "sms") {
      const { data: recovered, error } = await supabaseAdmin
        .from("sms_campaigns")
        .update({
          status: "agendada",
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("status", "enviando")
        .lt("locked_at", campaignStuckBefore)
        .select("id");
      if (error) throw new Error(error.message);
      recoveredIds = (recovered ?? []).map((row) => row.id);
    } else if (data.channel === "email") {
      const { data: recovered, error } = await supabaseAdmin
        .from("email_campaigns")
        .update({
          status: "agendada",
          scheduled_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("status", "enviando")
        .lt("locked_at", campaignStuckBefore)
        .select("id");
      if (error) throw new Error(error.message);
      recoveredIds = (recovered ?? []).map((row) => row.id);
    } else {
      const { data: recovered, error } = await supabaseAdmin
        .from("call_queue")
        .update({
          status: "queued",
          scheduled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("status", "calling")
        .lt("updated_at", voiceStuckBefore)
        .select("id");
      if (error) throw new Error(error.message);
      recoveredIds = (recovered ?? []).map((row) => row.id);
    }

    await auditOperation({
      tenantId,
      userId: context.userId,
      action: "channel.stuck_reprocessed",
      channel: data.channel,
      metadata: { recovered_count: recoveredIds.length, recovered_ids: recoveredIds.slice(0, 100) },
    });
    return { ok: true, recovered: recoveredIds.length };
  });
