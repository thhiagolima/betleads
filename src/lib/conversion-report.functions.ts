/* eslint-disable @typescript-eslint/no-explicit-any -- conversion tables await generated DB types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "./tenant-access.server";

const inputSchema = z.object({
  sourceType: z.enum(["campaign", "journey"]),
  sourceId: z.string().uuid(),
});

async function requireConversionReportAdmin(context: any, tenantId: string) {
  const db = context.supabase as any;
  const { data: superAdmin, error: superAdminError } = await db.rpc("is_super_admin", {
    _user_id: context.userId,
  });
  if (superAdminError) throw new Error("Não foi possível validar a permissão.");
  if (superAdmin) return;
  const { data: membership, error } = await db
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error || membership?.role !== "admin") throw new Error("Acesso restrito a administradores.");
}

const drilldownSchema = inputSchema.extend({
  limit: z.number().int().min(1).max(500).default(100),
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
    await db
      .from("conversion_report_audit_events")
      .insert({
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
    await db
      .from("conversion_report_audit_events")
      .insert({
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
        .select("id,tracked_link_id,send_status,delivery_status,sent_at,updated_at")
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId),
      db
        .from("conversion_attributions")
        .select("event_type,monetary_value,is_ftd,occurred_at,created_at")
        .eq("tenant_id", tenantId)
        .eq("source_type", data.sourceType)
        .eq("source_id", data.sourceId)
        .eq("classification", "direct"),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    if (attributionResult.error) throw new Error(attributionResult.error.message);
    const dispatches = dispatchResult.data ?? [];
    const attributions = attributionResult.data ?? [];
    const linkIds = dispatches.map((item: any) => item.tracked_link_id).filter(Boolean);
    const { data: snapshots, error: snapshotError } = linkIds.length
      ? await db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks,snapshot_at")
          .in("tracked_link_id", linkIds)
      : { data: [], error: null };
    if (snapshotError) throw new Error(snapshotError.message);
    const clicksByLink = new Map<string, { clicks: number; snapshot_at: string }>();
    for (const snapshot of snapshots ?? []) {
      const previous = clicksByLink.get(snapshot.tracked_link_id);
      if (!previous || snapshot.snapshot_at > previous.snapshot_at)
        clicksByLink.set(snapshot.tracked_link_id, snapshot);
    }
    const sent = dispatches.filter((item: any) => item.send_status === "sent").length;
    const delivered = dispatches.filter((item: any) => item.delivery_status === "delivered").length;
    const clicked = [...clicksByLink.values()].reduce(
      (sum, item) => sum + Number(item.clicks ?? 0),
      0,
    );
    const count = (eventType: string) =>
      attributions.filter((item: any) => item.event_type === eventType).length;
    const deposits = count("deposit_approved");
    const revenue = attributions
      .filter((item: any) => item.event_type === "deposit_approved")
      .reduce((sum: number, item: any) => sum + Number(item.monetary_value ?? 0), 0);
    const latest =
      [...dispatches, ...attributions]
        .map((item: any) => item.updated_at ?? item.created_at ?? item.occurred_at ?? item.sent_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    return {
      sent,
      delivered: delivered || null,
      clicked: clicksByLink.size ? clicked : null,
      registered: count("registered"),
      loginOrGame: count("login") + count("game"),
      deposits,
      ftd: attributions.filter((item: any) => item.event_type === "deposit_approved" && item.is_ftd)
        .length,
      revenue,
      latest,
      historical: dispatches.length === 0 && attributions.length === 0,
    };
  });
