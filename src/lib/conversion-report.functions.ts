/* eslint-disable @typescript-eslint/no-explicit-any -- conversion tables await generated DB types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
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

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

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

    const [smsResult, emailResult, dispatchResult] = await Promise.all([
      db
        .from("sms_campaigns")
        .select(
          "id,name,content,route,status,total_count,sent_count,failed_count,scheduled_at,created_at,updated_at,recipients",
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
    if (smsResult.error && emailResult.error)
      throw new Error(smsResult.error.message || emailResult.error.message);

    const sms = smsResult.data;
    const email = emailResult.data;
    const campaign = sms
      ? {
          channel: "sms" as const,
          name: sms.name,
          content: sms.content,
          route: sms.route,
          status: sms.status,
          total: Number(sms.total_count ?? 0),
          sent: Number(sms.sent_count ?? 0),
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
            failed: Number(email.stats?.failed ?? email.stats?.falhas ?? 0),
            scheduledAt: email.scheduled_at,
            createdAt: email.created_at,
            finishedAt: email.updated_at,
            audience: Number(email.stats?.total ?? email.stats?.destinatarios ?? 0),
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
              .select("tracking_token,event_type,occurred_at,monetary_value,classification")
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
      const deposit = attributionRows
        .filter((row) => row.event_type === "deposit_approved" && row.classification === "direct")
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))[0];
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
    const { data: issues, error: issuesError } = await db
      .from("conversion_attribution_issues")
      .select("reason,source_type,source_id")
      .eq("tenant_id", tenantId)
      .gte("created_at", issueSince);
    if (issuesError && !String(issuesError.message).includes("permission"))
      throw new Error(issuesError.message);
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
    if (syncStale)
      alerts.push({
        code: "click_sync_stale",
        severity: "warning",
        message: `${syncStale} link(s) ainda não possuem sincronização recente de cliques.`,
      });
    const relevantIssues = (issues ?? []).filter(
      (issue: any) =>
        !issue.source_id ||
        (issue.source_type === data.sourceType && issue.source_id === data.sourceId),
    );
    if (relevantIssues.length)
      alerts.push({
        code: "attribution_rejected",
        severity: "warning",
        message: `${relevantIssues.length} evento(s) sem atribuição determinística nas últimas 24 horas. Verifique token, origem e envio.`,
      });
    return { healthy: alerts.length === 0, alerts };
  });

export const getConversionDrilldown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => drilldownSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireConversionReportAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: rows, error } = await db
      .from("conversion_attributions")
      .select(
        "event_type,event_id,occurred_at,monetary_value,is_ftd,tracking_token,players(nome,email,telefone)",
      )
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .order("occurred_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
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
    const [dispatchResult, attributionResult] = await Promise.all([
      db
        .from("link_dispatches")
        .select(
          "id,tracked_link_id,idempotency_key,message_log_id,send_status,delivery_status,sent_at,updated_at,channel,journey_step_id,journey_step_position",
        )
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId),
      db
        .from("conversion_attributions")
        .select("event_type,monetary_value,is_ftd,occurred_at,created_at,classification")
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId)
        .in("classification", ["direct", "assisted"]),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    if (attributionResult.error) throw new Error(attributionResult.error.message);
    const dispatches = dispatchResult.data ?? [];
    const attributions = attributionResult.data ?? [];
    const linkIds = dispatches.map((item: any) => item.tracked_link_id).filter(Boolean);
    const [{ data: snapshots, error: snapshotError }, canViewSensitive] = await Promise.all([
      linkIds.length
        ? await db
            .from("link_click_snapshots")
            .select("tracked_link_id,clicks,human_clicks,snapshot_at")
            .in("tracked_link_id", linkIds)
        : Promise.resolve({ data: [], error: null }),
      hasConversionReportAdmin(context, tenantId),
    ]);
    if (snapshotError) throw new Error(snapshotError.message);
    const clicksByLink = new Map<string, { clicks: number; snapshot_at: string }>();
    for (const snapshot of snapshots ?? []) {
      const previous = clicksByLink.get(snapshot.tracked_link_id);
      if (!previous || snapshot.snapshot_at > previous.snapshot_at)
        clicksByLink.set(snapshot.tracked_link_id, snapshot);
    }
    const sent = uniqueDeliveryCount(dispatches, (item) => item.send_status === "sent");
    const deliveredCount = uniqueDeliveryCount(
      dispatches,
      (item) => item.delivery_status === "delivered",
    );
    const clicked = [...clicksByLink.values()].reduce(
      (sum, item) => sum + Number(item.clicks ?? 0),
      0,
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
      delivered: deliveredCount || null,
      clicked: clicksByLink.size ? clicked : null,
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
      })),
      historical: dispatches.length === 0 && attributions.length === 0,
    };
  });
