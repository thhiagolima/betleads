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
