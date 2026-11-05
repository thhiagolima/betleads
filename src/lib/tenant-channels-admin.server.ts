// Super admin: ligar/desligar canal da casa (Task 5 of
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md,
// §3 and §5). Desligar cancela os envios já agendados/pausados do canal;
// religar nunca reativa o que foi cancelado.

import type { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";
import { cancelSmsCampaignRow } from "@/lib/sms-campaign-dispatch.server";
import { invalidateTenantChannelsCache } from "@/lib/tenant-channels.server";
import {
  DEFAULT_ENABLED_CHANNELS,
  STEP_TYPE_CHANNEL,
  type ProviderChannel,
  type setTenantChannelInput,
  type tenantChannelImpactInput,
} from "@/lib/tenant-channels.shared";
import { cancelWebpushCampaign } from "@/lib/webpush/campaigns.server";

type AdminContext = { userId: string };

/* eslint-disable @typescript-eslint/no-explicit-any -- generic Supabase query builder shared by every table touched here. */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const SMS_CANCELLABLE_STATUSES = ["agendada", "pausada"];
const WEBPUSH_CANCELLABLE_STATUSES = ["agendada", "pausada"];
const CALL_QUEUE_CANCELLABLE_STATUSES = ["pending_audio", "audio_ready", "queued", "paused"];

const CHANNEL_DISABLED_SMS_MESSAGE = "Canal SMS desabilitado para a casa.";
const CHANNEL_DISABLED_EMAIL_REASON = "channel_disabled";

/** Table + status list used to size "scheduled campaigns" impact per channel. */
const IMPACT_SCOPE: Record<ProviderChannel, { table: string; statuses: string[] }> = {
  sms: { table: "sms_campaigns", statuses: ["agendada", "pausada", "enviando"] },
  webpush: { table: "webpush_campaigns", statuses: ["agendada", "pausada", "enviando"] },
  email: { table: "email_campaigns", statuses: ["agendada", "enviando", "pausada"] },
  voice: { table: "call_queue", statuses: ["pending_audio", "audio_ready", "queued", "paused"] },
};

async function countScheduledCampaigns(tenantId: string, channel: ProviderChannel): Promise<number> {
  const { table, statuses } = IMPACT_SCOPE[channel];
  const { count, error } = await db()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("status", statuses);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Active journeys of the house with an enabled step that sends on this channel. */
async function countActiveJourneysUsingChannel(
  tenantId: string,
  channel: ProviderChannel,
): Promise<number> {
  const stepType = Object.keys(STEP_TYPE_CHANNEL).find((key) => STEP_TYPE_CHANNEL[key] === channel);
  if (!stepType) return 0; // no journey step sends on this channel today (webpush)

  const { data: journeys, error: journeysError } = await db()
    .from("journeys")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (journeysError) throw new Error(journeysError.message);
  const journeyIds = ((journeys ?? []) as Array<{ id: string }>).map((j) => j.id);
  if (!journeyIds.length) return 0;

  const { data: steps, error: stepsError } = await db()
    .from("journey_steps")
    .select("journey_id")
    .in("journey_id", journeyIds)
    .eq("step_type", stepType)
    .eq("is_enabled", true);
  if (stepsError) throw new Error(stepsError.message);
  return new Set(((steps ?? []) as Array<{ journey_id: string }>).map((s) => s.journey_id)).size;
}

/**
 * Jornadas ativas e campanhas/itens agendados ou em pausa que o canal
 * atende hoje — mostrado ao super admin antes de desligar.
 */
export async function adminTenantChannelImpactFor(
  ctx: AdminContext,
  data: z.infer<typeof tenantChannelImpactInput>,
): Promise<{ activeJourneys: number; scheduledCampaigns: number }> {
  await assertSuperAdmin(ctx.userId);
  const [activeJourneys, scheduledCampaigns] = await Promise.all([
    countActiveJourneysUsingChannel(data.tenantId, data.channel),
    countScheduledCampaigns(data.tenantId, data.channel),
  ]);
  return { activeJourneys, scheduledCampaigns };
}

async function cancelSmsSends(tenantId: string): Promise<number> {
  const { data: rows, error } = await db()
    .from("sms_campaigns")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("status", SMS_CANCELLABLE_STATUSES);
  if (error) throw new Error(error.message);
  let cancelled = 0;
  for (const row of (rows ?? []) as Array<{ id: string }>) {
    const result = await cancelSmsCampaignRow(db(), {
      tenantId,
      campaignId: row.id,
      lastError: CHANNEL_DISABLED_SMS_MESSAGE,
    });
    if (result) cancelled += 1;
  }
  return cancelled;
}

async function cancelWebpushSends(tenantId: string): Promise<number> {
  const { data: rows, error } = await db()
    .from("webpush_campaigns")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("status", WEBPUSH_CANCELLABLE_STATUSES);
  if (error) throw new Error(error.message);
  let cancelled = 0;
  for (const row of (rows ?? []) as Array<{ id: string }>) {
    try {
      await cancelWebpushCampaign(db(), { tenantId, id: row.id });
      cancelled += 1;
    } catch (cancelError) {
      // A batch mid-flight (webpush_dispatch_batches 'enviado') refuses to
      // cancel until it settles; leave it for the house/Task 6 and move on.
      console.warn("[tenant-channels-admin] webpush campaign not cancellable now", {
        tenantId,
        campaignId: row.id,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
    }
  }
  return cancelled;
}

async function cancelEmailSends(tenantId: string): Promise<number> {
  const { data: rows, error } = await db()
    .from("email_campaigns")
    .update({ status: "pausada", blocked_reason: CHANNEL_DISABLED_EMAIL_REASON })
    .eq("tenant_id", tenantId)
    .eq("status", "agendada")
    .select("id");
  if (error) throw new Error(error.message);
  return (rows ?? []).length;
}

async function cancelVoiceSends(tenantId: string): Promise<number> {
  const { data: rows, error } = await db()
    .from("call_queue")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .in("status", CALL_QUEUE_CANCELLABLE_STATUSES)
    .select("id");
  if (error) throw new Error(error.message);
  return (rows ?? []).length;
}

/** Cancels pending/paused sends of the channel being disabled. Scheduled
 * campaigns already dispatching ('enviando') are left alone: Task 6 stops
 * them at dispatch time. */
async function cancelPendingSends(tenantId: string, channel: ProviderChannel): Promise<number> {
  if (channel === "sms") return cancelSmsSends(tenantId);
  if (channel === "webpush") return cancelWebpushSends(tenantId);
  if (channel === "email") return cancelEmailSends(tenantId);
  return cancelVoiceSends(tenantId);
}

/**
 * Turns a channel on/off for one house. Disabling it cancels what is still
 * agendada/pausada on that channel (never what is already enviando — Task
 * 6's job); re-enabling never brings those back. A channel already in the
 * requested state is a no-op: no write, no audit.
 */
export async function adminSetTenantChannelFor(
  ctx: AdminContext,
  data: z.infer<typeof setTenantChannelInput>,
): Promise<{ cancelled: number }> {
  await assertSuperAdmin(ctx.userId);
  const { tenantId, channel, enabled } = data;

  const { data: current, error: currentError } = await db()
    .from("tenant_channels")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .maybeSingle();
  if (currentError) throw new Error(currentError.message);
  const previousEnabled = (current as { enabled: boolean } | null)?.enabled ?? DEFAULT_ENABLED_CHANNELS[channel];
  if (previousEnabled === enabled) return { cancelled: 0 };

  const now = new Date().toISOString();
  const { error: upsertError } = await db()
    .from("tenant_channels")
    .upsert(
      {
        tenant_id: tenantId,
        channel,
        enabled,
        disabled_at: enabled ? null : now,
        updated_by: ctx.userId,
        updated_at: now,
      },
      { onConflict: "tenant_id,channel" },
    );
  if (upsertError) throw new Error(upsertError.message);
  invalidateTenantChannelsCache(tenantId);

  await auditAdminAction({
    actorUserId: ctx.userId,
    action: enabled ? "tenant_channel.enable" : "tenant_channel.disable",
    tenantId,
    before: { channel, enabled: previousEnabled },
    after: { channel, enabled },
  });

  if (!enabled) {
    const cancelled = await cancelPendingSends(tenantId, channel);
    return { cancelled };
  }
  return { cancelled: 0 };
}
