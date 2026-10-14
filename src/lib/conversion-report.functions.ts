/* eslint-disable @typescript-eslint/no-explicit-any -- conversion tables await generated DB types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { canAccessConversionDrilldown, uniqueDeliveryCount } from "./conversion-report";

const inputSchema = z.object({
  sourceType: z.enum(["campaign", "journey"]),
  sourceId: z.string().uuid(),
});

async function hasConversionReportAdmin(context: any, tenantId: string) {
  const db = context.supabase as any;
  const { data: superAdmin, error: superAdminError } = await db.rpc("is_super_admin", {
    _user_id: context.userId,
  });
  if (superAdminError) throw new Error("Não foi possível validar a permissão.");
  if (superAdmin) return true;
  const { data: membership, error } = await db
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw new Error("Não foi possível validar a permissão.");
  return canAccessConversionDrilldown(membership?.role ?? null, false);
}

async function requireConversionReportAdmin(context: any, tenantId: string) {
  if (!(await hasConversionReportAdmin(context, tenantId)))
    throw new Error("Acesso restrito a administradores.");
}

const drilldownSchema = inputSchema.extend({
  limit: z.number().int().min(1).max(500).default(100),
});

const campaignDetailsSchema = z.object({
  campaignId: z.string().uuid(),
  limit: z.number().int().min(1).max(500).default(500),
});

const journeyDetailsSchema = z.object({ journeyId: z.string().uuid() });

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export const getJourneyReportDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => journeyDetailsSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    // The journey aggregate RPCs are intentionally restricted to service_role.
    // Tenant access is validated above using the authenticated request; every
    // elevated query below remains explicitly scoped to that tenant.
    const db = supabaseAdmin as any;
    const [journeyResult, stepsResult, metricsResult, eligibleResult] = await Promise.all([
      db
        .from("journeys")
        .select("id,name,description,status,trigger_type,trigger_config,created_at,updated_at")
        .eq("tenant_id", tenantId)
        .eq("id", data.journeyId)
        .maybeSingle(),
      db
        .from("journey_steps")
        .select("id,position,step_type,label,config,is_enabled")
        .eq("tenant_id", tenantId)
        .eq("journey_id", data.journeyId)
        .eq("is_enabled", true)
        .order("position"),
      db.rpc("journey_metrics", {
        p_tenant_id: tenantId,
        p_journey_id: data.journeyId,
      }),
      db.rpc("journey_eligible_lead_count", {
        p_tenant_id: tenantId,
        p_journey_id: data.journeyId,
      }),
    ]);
    const error = [
      journeyResult.error,
      stepsResult.error,
      metricsResult.error,
      eligibleResult.error,
    ].find(Boolean);
    if (error) throw new Error(error.message);
    if (!journeyResult.data) return { journey: null, steps: [], metrics: null };

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const countExecutions = async (
      stepId: string,
      statuses: string[],
      since?: string,
    ): Promise<number> => {
      let query = db
        .from("journey_step_executions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("journey_id", data.journeyId)
        .eq("step_id", stepId)
        .in("status", statuses);
      if (since) {
        // Older executions can be terminal with `executed_at` null. A
        // completed/updated timestamp is still valid operational evidence of
        // a send and must not make the seven-day counter show zero.
        query = query.or(
          `executed_at.gte.${since},completed_at.gte.${since},updated_at.gte.${since}`,
        );
      }
      const result = await query;
      if (result.error) throw new Error(result.error.message);
      return Number(result.count ?? 0);
    };
    const steps = await Promise.all(
      (stepsResult.data ?? []).map(async (step: any) => {
        if (step.step_type === "wait" || step.step_type === "end")
          return { ...step, queued: 0, sent: 0, sent7d: 0, failed: 0 };
        const [queued, sent, sent7d, failed] = await Promise.all([
          countExecutions(step.id, ["pending", "claimed", "retrying"]),
          countExecutions(step.id, ["sent", "delivered"]),
          countExecutions(step.id, ["sent", "delivered"], sevenDaysAgo),
          countExecutions(step.id, ["failed", "cancelled"]),
        ]);
        return { ...step, queued, sent, sent7d, failed };
      }),
    );
    const aggregate = metricsResult.data ?? {};
    return {
      journey: journeyResult.data,
      steps,
      metrics: {
        ...aggregate,
        eligible: Number(eligibleResult.data ?? 0),
        queued:
          Number(aggregate.byStatus?.active ?? 0) +
          Number(aggregate.byStatus?.waiting ?? 0) +
          Number(aggregate.byStatus?.paused_by_priority ?? 0),
      },
    };
  });

/**
 * Operational detail used by the campaign report. Link dispatches are grouped by
 * idempotency key because a message may contain more than one tracked URL.
 */
export const getCampaignReportDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => campaignDetailsSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;

    const [smsResult, emailResult, voiceResult, dispatchResult] = await Promise.all([
      db
        .from("sms_campaigns")
        .select(
          "id,name,content,route,status,total_count,sent_count,deduplicated_count,failed_count,scheduled_at,created_at,updated_at,recipients",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("email_campaigns")
        .select(
          "id,name,status,stats,scheduled_at,created_at,updated_at,template_snapshot,audience_filter",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("call_queue")
        .select(
          "id,lead_id,script_id,voice_asset_id,trigger_name,status,provider_status,phone_number,scheduled_at,created_at,updated_at,attempts,provider_response",
        )
        .eq("tenant_id", tenantId)
        .eq("id", data.campaignId)
        .maybeSingle(),
      db
        .from("link_dispatches")
        .select(
          "id,tracked_link_id,tracking_token,idempotency_key,recipient_player_id,send_status,delivery_status,sent_at,delivered_at,created_at,updated_at,message_log_id,channel",
        )
        .eq("tenant_id", tenantId)
        .eq("source_type", "campaign")
        .eq("source_id", data.campaignId)
        .order("created_at", { ascending: true })
        .limit(Math.min(data.limit * 4, 2000)),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    const sourceError = [smsResult.error, emailResult.error, voiceResult.error].find(Boolean);
    if (sourceError) throw new Error(sourceError.message);

    const sms = smsResult.data;
    const email = emailResult.data;
    const voice = voiceResult.data;
    const [voiceHistoryResult, voicePlayerResult, voiceScriptResult, voiceAssetResult] = voice
      ? await Promise.all([
          db
            .from("call_history")
            .select(
              "id,status,result,duration_seconds,created_at,error_message,provider,provider_call_id,to_phone,provider_status_code,provider_response",
            )
            .eq("tenant_id", tenantId)
            .eq("call_queue_id", voice.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          voice.lead_id
            ? db
                .from("players")
                .select("id,nome,telefone")
                .eq("tenant_id", tenantId)
                .eq("id", voice.lead_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          voice.script_id
            ? db
                .from("call_scripts")
                .select("id,name,content")
                .eq("tenant_id", tenantId)
                .eq("id", voice.script_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          voice.voice_asset_id
            ? db
                .from("journey_voice_assets")
                .select("id,name")
                .eq("tenant_id", tenantId)
                .eq("id", voice.voice_asset_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])
      : [
          { data: null, error: null },
          { data: null, error: null },
          { data: null, error: null },
          { data: null, error: null },
        ];
    const voiceDetailError = [
      voiceHistoryResult.error,
      voicePlayerResult.error,
      voiceScriptResult.error,
      voiceAssetResult.error,
    ].find(Boolean);
    if (voiceDetailError) throw new Error(voiceDetailError.message);
    const voiceHistory = voiceHistoryResult.data;
    const voicePlayer = voicePlayerResult.data;
    const voiceScript = voiceScriptResult.data;
    const voiceAsset = voiceAssetResult.data;
    const campaign = sms
      ? {
          channel: "sms" as const,
          name: sms.name,
          content: sms.content,
          route: sms.route,
          status: sms.status,
          total: Number(sms.total_count ?? 0),
          sent: Number(sms.sent_count ?? 0),
          deduplicated: Number(sms.deduplicated_count ?? 0),
          failed: Number(sms.failed_count ?? 0),
          scheduledAt: sms.scheduled_at,
          createdAt: sms.created_at,
          finishedAt: sms.updated_at,
          audience: Array.isArray(sms.recipients) ? sms.recipients.length : 0,
        }
      : email
        ? {
            channel: "email" as const,
            name: email.name,
            content:
              email.template_snapshot?.subject ??
              email.template_snapshot?.name ??
              "Conteúdo de e-mail preservado no template da campanha.",
            route: "E-mail",
            status: email.status,
            total: Number(email.stats?.total ?? email.stats?.destinatarios ?? 0),
            sent: Number(email.stats?.sent ?? email.stats?.enviados ?? 0),
            deduplicated: 0,
            failed: Number(email.stats?.failed ?? email.stats?.falhas ?? 0),
            scheduledAt: email.scheduled_at,
            createdAt: email.created_at,
            finishedAt: email.updated_at,
            audience: Number(email.stats?.total ?? email.stats?.destinatarios ?? 0),
          }
        : voice
          ? {
              channel: "voice" as const,
              name:
                voice.trigger_name ?? voiceScript?.name ?? voiceAsset?.name ?? "Ligação por voz",
              content:
                voiceScript?.content ?? (voiceAsset?.name ? `Áudio: ${voiceAsset.name}` : null),
              route: "Infobip Voice",
              status: voice.status,
              total: 1,
              sent: voiceHistory ? 1 : 0,
              deduplicated: 0,
              failed: voice.status === "failed" || voice.status === "cancelled" ? 1 : 0,
              scheduledAt: voice.scheduled_at,
              createdAt: voice.created_at,
              finishedAt: ["completed", "failed", "cancelled"].includes(voice.status)
                ? voice.updated_at
                : null,
              audience: 1,
            }
          : null;

    const voiceDetails = voice
      ? {
          queueStatus: voice.status,
          providerStatus: voice.provider_status,
          playerName: voicePlayer?.nome ?? null,
          phone: voiceHistory?.to_phone ?? voicePlayer?.telefone ?? voice.phone_number ?? null,
          attemptedAt: voiceHistory?.created_at ?? null,
          result: voiceHistory?.result ?? null,
          historyStatus: voiceHistory?.status ?? null,
          answered:
            voiceHistory?.result === "answered" ||
            voiceHistory?.status === "answered" ||
            voice.provider_status === "answered",
          durationSeconds: voiceHistory?.duration_seconds ?? null,
          error: voiceHistory?.error_message ?? null,
          provider: voiceHistory?.provider ?? "infobip",
          providerCallId: voiceHistory?.provider_call_id ?? null,
          providerStatusCode: voiceHistory?.provider_status_code ?? null,
          attempts: Number(voice.attempts ?? 0),
        }
      : null;

    const dispatches = dispatchResult.data ?? [];
    const deliveryMap = new Map<string, any[]>();
    for (const row of dispatches) {
      const key = row.idempotency_key || row.message_log_id || row.id;
      const group = deliveryMap.get(key) ?? [];
      group.push(row);
      deliveryMap.set(key, group);
    }
    const deliveries = [...deliveryMap.entries()].slice(0, data.limit);
    const playerIds = [
      ...new Set(deliveries.map(([, rows]) => rows[0]?.recipient_player_id).filter(Boolean)),
    ];
    const linkIds = [
      ...new Set(deliveries.flatMap(([, rows]) => rows.map((row) => row.tracked_link_id))),
    ];
    const tokens = [
      ...new Set(deliveries.flatMap(([, rows]) => rows.map((row) => row.tracking_token))),
    ];
    const messageLogIds = [
      ...new Set(deliveries.map(([, rows]) => rows[0]?.message_log_id).filter(Boolean)),
    ];

    const [playersResult, snapshotsResult, attributionsResult, depositsResult, smsLogsResult] =
      await Promise.all([
        playerIds.length
          ? db
              .from("players")
              .select("id,nome,telefone,email,total_depositado")
              .eq("tenant_id", tenantId)
              .in("id", playerIds)
          : Promise.resolve({ data: [], error: null }),
        linkIds.length
          ? db
              .from("link_click_snapshots")
              .select("tracked_link_id,clicks,human_clicks,snapshot_at")
              .eq("tenant_id", tenantId)
              .in("tracked_link_id", linkIds)
          : Promise.resolve({ data: [], error: null }),
        tokens.length
          ? db
              .from("conversion_attributions")
              .select("tracking_token,event_type,occurred_at,monetary_value,is_ftd,classification")
              .eq("tenant_id", tenantId)
              .eq("source_type", "campaign")
              .eq("source_id", data.campaignId)
              .in("tracking_token", tokens)
          : Promise.resolve({ data: [], error: null }),
        playerIds.length
          ? db
              .from("deposits")
              .select("player_id,valor,status,completed_at,created_at")
              .eq("tenant_id", tenantId)
              .in("player_id", playerIds)
              .eq("status", "aprovado")
          : Promise.resolve({ data: [], error: null }),
        sms?.id && messageLogIds.length
          ? db
              .from("sms_send_logs")
              .select("id,status,error,to_phone,created_at,delivered_at,delivery_status")
              .eq("tenant_id", tenantId)
              .in("id", messageLogIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
    const firstError = [
      playersResult.error,
      snapshotsResult.error,
      attributionsResult.error,
      depositsResult.error,
      smsLogsResult.error,
    ].find(Boolean);
    if (firstError) throw new Error(firstError.message);

    const players = new Map<string, any>(
      (playersResult.data ?? []).map((row: any) => [row.id, row]),
    );
    const logs = new Map<string, any>((smsLogsResult.data ?? []).map((row: any) => [row.id, row]));
    const latestSnapshot = new Map<string, any>();
    for (const row of snapshotsResult.data ?? []) {
      const previous = latestSnapshot.get(row.tracked_link_id);
      if (!previous || row.snapshot_at > previous.snapshot_at)
        latestSnapshot.set(row.tracked_link_id, row);
    }
    const depositsByPlayer = new Map<string, any[]>();
    for (const row of depositsResult.data ?? []) {
      const group = depositsByPlayer.get(row.player_id) ?? [];
      group.push(row);
      depositsByPlayer.set(row.player_id, group);
    }
    const attributionsByToken = new Map<string, any[]>();
    for (const row of attributionsResult.data ?? []) {
      const group = attributionsByToken.get(row.tracking_token) ?? [];
      group.push(row);
      attributionsByToken.set(row.tracking_token, group);
    }

    const recipients = deliveries.map(([key, rows]) => {
      const first = rows[0];
      const player = players.get(first.recipient_player_id) ?? null;
      const log = logs.get(first.message_log_id) ?? null;
      const snapshots = rows.map((row) => latestSnapshot.get(row.tracked_link_id)).filter(Boolean);
      const clicked = snapshots.some((row) => Number(row.human_clicks ?? row.clicks ?? 0) > 0);
      const clickCount = snapshots.reduce(
        (sum, row) => sum + Number(row.human_clicks ?? row.clicks ?? 0),
        0,
      );
      const attributionRows = rows.flatMap(
        (row) => attributionsByToken.get(row.tracking_token) ?? [],
      );
      const directAttributions = attributionRows
        .filter((row) => row.classification === "direct")
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      const registered = directAttributions.find((row) => row.event_type === "registered");
      const loginOrGame = directAttributions.find(
        (row) => row.event_type === "login" || row.event_type === "game",
      );
      const firstDeposit = directAttributions.find(
        (row) => row.event_type === "deposit_approved" && row.is_ftd === true,
      );
      const deposit = directAttributions.find((row) => row.event_type === "deposit_approved");
      const historicalDeposits = depositsByPlayer.get(first.recipient_player_id) ?? [];
      return {
        id: key,
        playerId: first.recipient_player_id,
        playerName: player?.nome ?? log?.to_phone ?? "Destinatário não identificado",
        contact: player?.telefone ?? player?.email ?? log?.to_phone ?? "",
        sendStatus: first.send_status,
        deliveryStatus: first.delivery_status ?? log?.delivery_status ?? null,
        error: log?.error ?? null,
        sentAt: first.sent_at ?? first.created_at,
        deliveredAt: first.delivered_at ?? log?.delivered_at ?? null,
        clicked,
        clickCount,
        clickedAt: clicked
          ? (snapshots
              .map((row) => row.snapshot_at)
              .sort()
              .at(0) ?? null)
          : null,
        registeredAt: registered?.occurred_at ?? null,
        loginOrGameAt: loginOrGame?.occurred_at ?? null,
        firstDepositAt: firstDeposit?.occurred_at ?? null,
        depositAt: deposit?.occurred_at ?? null,
        depositValue: Number(deposit?.monetary_value ?? 0),
        historicalDepositCount: historicalDeposits.length,
        historicalDepositValue: historicalDeposits.reduce(
          (sum, row) => sum + Number(row.valor ?? 0),
          0,
        ),
      };
    });

    return {
      campaign,
      voice: voiceDetails,
      recipients,
      recipientsShown: recipients.length,
      trackedDeliveries: deliveryMap.size,
      failureReasons: [...logs.values()]
        .filter((row: any) => row.error)
        .reduce((groups: Record<string, number>, row: any) => {
          const reason = String(row.error).slice(0, 140);
          groups[reason] = (groups[reason] ?? 0) + 1;
          return groups;
        }, {}),
    };
  });

export const exportCampaignRecipientsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ campaignId: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: dispatches, error } = await db
      .from("link_dispatches")
      .select(
        "recipient_player_id,send_status,delivery_status,sent_at,delivered_at,tracking_token,players(nome,email,telefone)",
      )
      .eq("tenant_id", tenantId)
      .eq("source_type", "campaign")
      .eq("source_id", data.campaignId)
      .limit(10000);
    if (error) throw new Error(error.message);
    const csv = [
      "jogador,email,telefone,status_envio,status_entrega,enviado_em,entregue_em,token_rastreamento",
      ...(dispatches ?? []).map((row: any) =>
        [
          row.players?.nome,
          row.players?.email,
          row.players?.telefone,
          row.send_status,
          row.delivery_status,
          row.sent_at,
          row.delivered_at,
          row.tracking_token,
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\n");
    return { csv };
  });

export const getConversionDataHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const staleAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: dispatches, error } = await db
      .from("link_dispatches")
      .select("id,send_status,created_at,tracked_links(last_synced_at)")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId);
    if (error) throw new Error(error.message);
    const issueSince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const issueReasons = [
      "missing_token",
      "token_without_dispatch",
      "invalid_origin_or_player",
      "dispatch_not_sent",
    ] as const;
    const [sourceIssues, globalIssues, ...globalReasonResults] = await Promise.all([
      db
        .from("conversion_attribution_issues")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId)
        .gte("created_at", issueSince),
      db
        .from("conversion_attribution_issues")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("source_id", null)
        .gte("created_at", issueSince),
      ...issueReasons.map((reason) =>
        db
          .from("conversion_attribution_issues")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .is("source_id", null)
          .eq("reason", reason)
          .gte("created_at", issueSince),
      ),
    ]);
    const issueError = [sourceIssues, globalIssues, ...globalReasonResults]
      .map((result: any) => result.error)
      .find(Boolean);
    if (issueError && !String(issueError.message).includes("permission"))
      throw new Error(issueError.message);
    const rows = dispatches ?? [];
    const preparedStale = rows.filter(
      (row: any) => row.send_status === "prepared" && row.created_at < staleAt,
    ).length;
    const syncStale = rows.filter(
      (row: any) =>
        !row.tracked_links?.last_synced_at || row.tracked_links.last_synced_at < staleAt,
    ).length;
    const alerts = [] as Array<{ code: string; severity: "warning" | "error"; message: string }>;
    if (preparedStale)
      alerts.push({
        code: "dispatch_stuck",
        severity: "error",
        message: `${preparedStale} envio(s) rastreado(s) permanecem preparados há mais de 30 minutos.`,
      });
    // Click synchronization is eventually consistent. Its operational health
    // is monitored by sync runs; it must not be presented as a journey fault.
    if (syncStale && process.env.EXPOSE_LINK_SYNC_DIAGNOSTICS === "true")
      alerts.push({
        code: "click_sync_stale",
        severity: "warning",
        message: `${syncStale} link(s) ainda não possuem sincronização recente de cliques.`,
      });
    const sourceIssueCount = Number(sourceIssues.count ?? 0);
    if (sourceIssueCount)
      alerts.push({
        code: "attribution_rejected",
        severity: "warning",
        message: `${sourceIssueCount} evento(s) desta origem ficaram sem atribuição determinística nas últimas 24 horas.`,
      });
    const globalIssueReasons = Object.fromEntries(
      issueReasons
        .map((reason, index) => [reason, Number(globalReasonResults[index]?.count ?? 0)] as const)
        .filter(([, count]) => count > 0),
    );
    return {
      healthy: alerts.length === 0,
      alerts,
      globalAttributionHealth: {
        count: Number(globalIssues.count ?? 0),
        periodHours: 24,
        reasons: globalIssueReasons,
      },
    };
  });

export const getConversionDrilldown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => drilldownSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: dispatches, error: dispatchError } = await db
      .from("link_dispatches")
      .select("id,recipient_player_id,idempotency_key,sent_at,created_at,send_status")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .not("recipient_player_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(data.limit * 3);
    if (dispatchError) throw new Error(dispatchError.message);
    const dispatchRows = dispatches ?? [];
    const dispatchIds = dispatchRows.map((row: any) => row.id);
    const playerIds = [...new Set(dispatchRows.map((row: any) => row.recipient_player_id))];
    const [clickResult, attributionResult, playersResult] = await Promise.all([
      dispatchIds.length
        ? db
            .from("click_events")
            .select("link_dispatch_id,occurred_at")
            .eq("tenant_id", tenantId)
            .eq("is_human", true)
            .in("link_dispatch_id", dispatchIds)
            .order("occurred_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      dispatchIds.length
        ? db
            .from("conversion_attributions")
            .select("link_dispatch_id,event_type,occurred_at,monetary_value,is_ftd")
            .eq("tenant_id", tenantId)
            .eq("source_type", data.sourceType)
            .eq("source_id", data.sourceId)
            .in("link_dispatch_id", dispatchIds)
        : Promise.resolve({ data: [], error: null }),
      playerIds.length
        ? db
            .from("players")
            .select("id,nome,email,telefone")
            .eq("tenant_id", tenantId)
            .in("id", playerIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const firstError = [clickResult.error, attributionResult.error, playersResult.error].find(
      Boolean,
    );
    if (firstError) throw new Error(firstError.message);
    const clicksByDispatch = new Map<string, string>();
    for (const click of clickResult.data ?? []) {
      if (!clicksByDispatch.has(click.link_dispatch_id))
        clicksByDispatch.set(click.link_dispatch_id, click.occurred_at);
    }
    const eventsByDispatch = new Map<string, any[]>();
    for (const event of attributionResult.data ?? []) {
      const group = eventsByDispatch.get(event.link_dispatch_id) ?? [];
      group.push(event);
      eventsByDispatch.set(event.link_dispatch_id, group);
    }
    const playersById = new Map<string, any>(
      (playersResult.data ?? []).map((row: any) => [row.id, row]),
    );
    const grouped = new Map<string, any[]>();
    for (const dispatch of dispatchRows) {
      const key = dispatch.idempotency_key || dispatch.id;
      const group = grouped.get(key) ?? [];
      group.push(dispatch);
      grouped.set(key, group);
    }
    const rows = Array.from(grouped.values())
      .slice(0, data.limit)
      .map((group: any[]) => {
        const first = group[0];
        const events = group.flatMap((dispatch) => eventsByDispatch.get(dispatch.id) ?? []);
        const findEvent = (types: string[]) =>
          events
            .filter((event: any) => types.includes(event.event_type))
            .sort((a: any, b: any) =>
              String(a.occurred_at).localeCompare(String(b.occurred_at)),
            )[0] ?? null;
        const deposit = findEvent(["deposit_approved"]);
        const player = playersById.get(first.recipient_player_id);
        return {
          playerId: first.recipient_player_id,
          playerName: player?.nome ?? "Jogador não identificado",
          contact: player?.telefone ?? player?.email ?? null,
          sentAt: first.sent_at ?? first.created_at,
          clickedAt:
            group
              .map((dispatch) => clicksByDispatch.get(dispatch.id))
              .filter(Boolean)
              .sort()[0] ?? null,
          loginAt: findEvent(["login", "game"])?.occurred_at ?? null,
          depositedAt: deposit?.occurred_at ?? null,
          depositValue: Number(deposit?.monetary_value ?? 0),
          isFtd: deposit?.is_ftd === true,
        };
      });
    await db.from("conversion_report_audit_events").insert({
      tenant_id: tenantId,
      source_type: data.sourceType,
      source_id: data.sourceId,
      actor_user_id: context.userId,
      action: "drilldown_viewed",
    });
    return { rows: rows ?? [] };
  });

export const exportConversionDrilldownCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: rows, error } = await db
      .from("conversion_attributions")
      .select("event_type,event_id,occurred_at,monetary_value,is_ftd,players(nome,email,telefone)")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .order("occurred_at", { ascending: false })
      .limit(10000);
    if (error) throw new Error(error.message);
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      "nome,email,telefone,event_type,event_id,ocorrido_em,valor,is_ftd",
      ...(rows ?? []).map((row: any) =>
        [
          row.players?.nome,
          row.players?.email,
          row.players?.telefone,
          row.event_type,
          row.event_id,
          row.occurred_at,
          row.monetary_value,
          row.is_ftd,
        ]
          .map(cell)
          .join(","),
      ),
    ].join("\n");
    await db.from("conversion_report_audit_events").insert({
      tenant_id: tenantId,
      source_type: data.sourceType,
      source_id: data.sourceId,
      actor_user_id: context.userId,
      action: "csv_exported",
    });
    return { csv };
  });

export const getConversionReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const [dispatchResult, attributionResult, smsCampaignResult, emailCampaignResult] =
      await Promise.all([
        db
          .from("link_dispatches")
          .select(
            "id,tracked_link_id,tracking_token,recipient_player_id,idempotency_key,message_log_id,send_status,delivery_status,sent_at,updated_at,channel,journey_step_id,journey_step_position,shortio_click_count,shortio_last_clicked_at",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", data.sourceType)
          .eq("source_id", data.sourceId),
        db
          .from("conversion_attributions")
          .select(
            "link_dispatch_id,tracking_token,event_type,event_id,monetary_value,is_ftd,occurred_at,created_at,classification",
          )
          .eq("tenant_id", tenantId)
          .eq("source_type", data.sourceType)
          .eq("source_id", data.sourceId)
          .in("classification", ["direct", "assisted"]),
        data.sourceType === "campaign"
          ? db
              .from("sms_campaigns")
              .select("sent_count,deduplicated_count")
              .eq("tenant_id", tenantId)
              .eq("id", data.sourceId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        data.sourceType === "campaign"
          ? db
              .from("email_campaigns")
              .select("stats")
              .eq("tenant_id", tenantId)
              .eq("id", data.sourceId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    if (attributionResult.error) throw new Error(attributionResult.error.message);
    const dispatches = dispatchResult.data ?? [];
    const attributions = attributionResult.data ?? [];
    const linkIds = dispatches.map((item: any) => item.tracked_link_id).filter(Boolean);
    const [
      { data: snapshots, error: snapshotError },
      { data: clickEvents, error: clickEventsError },
      canViewSensitive,
    ] = await Promise.all([
      linkIds.length
        ? await db
            .from("link_click_snapshots")
            .select("tracked_link_id,clicks,human_clicks,snapshot_at")
            .in("tracked_link_id", linkIds)
        : Promise.resolve({ data: [], error: null }),
      dispatches.length
        ? await db
            .from("click_events")
            .select("link_dispatch_id")
            .eq("tenant_id", tenantId)
            .eq("is_human", true)
            .in(
              "link_dispatch_id",
              dispatches.map((item: any) => item.id),
            )
        : Promise.resolve({ data: [], error: null }),
      hasConversionReportAdmin(context, tenantId),
    ]);
    if (snapshotError) throw new Error(snapshotError.message);
    if (clickEventsError) throw new Error(clickEventsError.message);
    const clicksByLink = new Map<string, { clicks: number; snapshot_at: string }>();
    for (const snapshot of snapshots ?? []) {
      const previous = clicksByLink.get(snapshot.tracked_link_id);
      if (!previous || snapshot.snapshot_at > previous.snapshot_at)
        clicksByLink.set(snapshot.tracked_link_id, snapshot);
    }
    const trackedSent = uniqueDeliveryCount(dispatches, (item) => item.send_status === "sent");
    const operationalSent = smsCampaignResult.data
      ? Number(smsCampaignResult.data.sent_count ?? 0)
      : emailCampaignResult.data
        ? Number(
            emailCampaignResult.data.stats?.sent ?? emailCampaignResult.data.stats?.enviados ?? 0,
          )
        : 0;
    const sent = Math.max(trackedSent, operationalSent);
    const deduplicated = Number(smsCampaignResult.data?.deduplicated_count ?? 0);
    const deliveredCount = uniqueDeliveryCount(
      dispatches,
      (item) => item.delivery_status === "delivered",
    );
    // The Short.io synchronizer persists the latest aggregate both in the
    // snapshot and in every individual dispatch. Prefer the dispatch value:
    // it remains tied to the exact journey step even when a tracked link is
    // shared by more than one message.
    const dispatchClickCount = (row: any) =>
      Math.max(
        Number(row.shortio_click_count ?? 0),
        Number(clicksByLink.get(row.tracked_link_id)?.clicks ?? 0),
      );
    const confirmedDispatchIds = new Set(
      (clickEvents ?? []).map((event: any) => String(event.link_dispatch_id)),
    );
    const clicked = uniqueDeliveryCount(dispatches, (row: any) => confirmedDispatchIds.has(row.id));
    const observedClicked = uniqueDeliveryCount(
      dispatches,
      (row: any) => dispatchClickCount(row) > 0,
    );
    const count = (eventType: string) =>
      attributions.filter(
        (item: any) => item.event_type === eventType && item.classification === "direct",
      ).length;
    const deposits = count("deposit_approved");
    const revenue = attributions
      .filter(
        (item: any) => item.event_type === "deposit_approved" && item.classification === "direct",
      )
      .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0);
    const latest =
      [...dispatches, ...attributions]
        .map((item: any) => item.updated_at ?? item.created_at ?? item.occurred_at ?? item.sent_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    return {
      sent,
      trackedSent,
      deduplicated,
      delivered: deliveredCount || null,
      // Attribution and the main funnel use only a click recorded by our
      // redirect. The aggregate Short.io number is retained separately for
      // legacy diagnostics and is never causal evidence.
      clicked: dispatches.length ? clicked : null,
      observedClicked: clicksByLink.size ? observedClicked : null,
      registered: count("registered"),
      loginOrGame: count("login") + count("game"),
      deposits,
      ftd: attributions.filter(
        (item: any) =>
          item.event_type === "deposit_approved" && item.is_ftd && item.classification === "direct",
      ).length,
      revenue,
      assistedRevenue: attributions
        .filter(
          (item: any) =>
            item.event_type === "deposit_approved" && item.classification === "assisted",
        )
        .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0),
      latest,
      canViewSensitive,
      byStepChannel: Array.from(
        dispatches.reduce((groups: Map<string, any>, row: any) => {
          const key = `${row.journey_step_position ?? "-"}:${row.channel}`;
          const current = groups.get(key) ?? {
            stepId: row.journey_step_id,
            stepPosition: row.journey_step_position,
            channel: row.channel,
            rows: [],
          };
          current.rows.push(row);
          groups.set(key, current);
          return groups;
        }, new Map<string, any>()),
      ).map(([, group]: any) => ({
        stepId: group.stepId,
        stepPosition: group.stepPosition,
        channel: group.channel,
        sent: uniqueDeliveryCount(group.rows, (row) => row.send_status === "sent"),
        delivered: uniqueDeliveryCount(group.rows, (row) => row.delivery_status === "delivered"),
        clicked: uniqueDeliveryCount(group.rows, (row) => confirmedDispatchIds.has(row.id)),
        deposits: attributions.filter(
          (item: any) =>
            item.classification === "direct" &&
            item.event_type === "deposit_approved" &&
            group.rows.some(
              (row: any) =>
                row.id === item.link_dispatch_id ||
                (!item.link_dispatch_id && row.tracking_token === item.tracking_token),
            ),
        ).length,
        recovered: attributions
          .filter(
            (item: any) =>
              item.classification === "direct" &&
              item.event_type === "deposit_approved" &&
              group.rows.some(
                (row: any) =>
                  row.id === item.link_dispatch_id ||
                  (!item.link_dispatch_id && row.tracking_token === item.tracking_token),
              ),
          )
          .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0),
      })),
      historical: dispatches.length === 0 && attributions.length === 0,
    };
  });
