/* eslint-disable @typescript-eslint/no-explicit-any -- Short.io tables are introduced by a migration pending generated client types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertTenantNotDemo,
  requireTenantAdmin,
  resolveOperationalTenantId,
} from "./tenant-access.server";
import { z } from "zod";

// PostgREST devolve no máximo 1.000 linhas por requisição; sem paginar, os
// totais de links travavam em 1.000. Paginamos com ordem estável e quebramos
// listas grandes de ids em lotes (um `.in()` com milhares de ids estoura a URL).
const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const MAX_ROWS = 500_000; // teto de segurança
// Teto por tela: a sincronização grava um registro por link a cada rodada, então
// casas grandes podem ter milhões de linhas. Acima disso os números saem
// marcados como parciais (o conserto definitivo é agregar no banco).
const DISPATCH_BUDGET = 50_000;
const SNAPSHOT_BUDGET = 50_000;

export async function fetchAllPages<T>(
  buildPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize = PAGE_SIZE,
  maxRows = MAX_ROWS,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message ?? String(error));
    const got = data ?? [];
    out.push(...got);
    if (got.length < pageSize) break;
  }
  return out;
}

export function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchSnapshotsFor(db: any, tenantId: string, linkIds: string[]) {
  const all: Array<{ tracked_link_id: string; clicks: number | null }> = [];
  let truncated = false;
  for (const ids of chunk(linkIds)) {
    const remaining = SNAPSHOT_BUDGET - all.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    // (tracked_link_id, snapshot_at) é único: ordem estável para paginar e
    // coberta pelo índice link_click_snapshots_tenant_link_time_idx.
    const rows = await fetchAllPages<{ tracked_link_id: string; clicks: number | null }>(
      (from, to) =>
        db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks")
          .eq("tenant_id", tenantId)
          .in("tracked_link_id", ids)
          .order("tracked_link_id", { ascending: true })
          // Mais recentes primeiro: se o teto cortar, ficam os cliques acumulados mais novos.
          .order("snapshot_at", { ascending: false })
          .range(from, to),
      PAGE_SIZE,
      remaining,
    );
    all.push(...rows);
    if (rows.length >= remaining) truncated = true;
  }
  return { rows: all, truncated };
}

export const getLinkTrackingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [dispatches, { data: lastSync }] = await Promise.all([
      fetchAllPages<{
        id: string;
        channel: string;
        source_type: string;
        tracked_link_id: string;
      }>(
        (from, to) =>
          db
            .from("link_dispatches")
            .select("id,channel,source_type,tracked_link_id")
            .eq("tenant_id", tenantId)
            .eq("send_status", "sent")
            .gte("sent_at", since)
            .order("id", { ascending: true })
            .range(from, to),
        PAGE_SIZE,
        DISPATCH_BUDGET,
      ),
      db
        .from("link_tracking_sync_runs")
        .select("started_at,finished_at,status,links_processed,error")
        .eq("tenant_id", tenantId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const linkIds = Array.from(
      new Set(dispatches.map((row) => row.tracked_link_id).filter(Boolean)),
    ) as string[];
    const snapshotResult = linkIds.length
      ? await fetchSnapshotsFor(db, tenantId, linkIds)
      : { rows: [], truncated: false };
    const snapshots = snapshotResult.rows;
    const partial = dispatches.length >= DISPATCH_BUDGET || snapshotResult.truncated;
    const clicksByLink = new Map<string, number>();
    for (const row of snapshots) {
      const previous = clicksByLink.get(row.tracked_link_id) ?? 0;
      clicksByLink.set(row.tracked_link_id, Math.max(previous, Number(row.clicks ?? 0)));
    }
    const grouped = new Map<
      string,
      { channel: string; sourceType: string; sent: number; clicks: number; links: Set<string> }
    >();
    for (const row of dispatches) {
      const key = `${row.channel}:${row.source_type}`;
      const group = grouped.get(key) ?? {
        channel: row.channel,
        sourceType: row.source_type,
        sent: 0,
        clicks: 0,
        links: new Set(),
      };
      group.sent++;
      if (!group.links.has(row.tracked_link_id))
        group.clicks += clicksByLink.get(row.tracked_link_id) ?? 0;
      group.links.add(row.tracked_link_id);
      grouped.set(key, group);
    }
    const rows = Array.from(grouped.values()).map((row) => ({
      ...row,
      links: row.links.size,
      ctr: row.sent ? row.clicks / row.sent : 0,
    }));
    return {
      since,
      sent: dispatches.length,
      clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      rows,
      lastSync: lastSync ?? null,
      partial,
    };
  });

export const getPlayerLinkHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ playerId: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const { data: rows, error } = await db
      .from("link_dispatches")
      .select("id,channel,source_type,sent_url,original_url,sent_at,tracked_link_id")
      .eq("tenant_id", tenantId)
      .eq("recipient_player_id", data.playerId)
      .eq("send_status", "sent")
      .order("sent_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    const ids = Array.from(new Set((rows ?? []).map((r: any) => r.tracked_link_id)));
    const { data: snaps } = ids.length
      ? await db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks")
          .in("tracked_link_id", ids)
      : { data: [] };
    const clicks = new Map<string, number>();
    for (const s of snaps ?? [])
      clicks.set(
        s.tracked_link_id,
        Math.max(clicks.get(s.tracked_link_id) ?? 0, Number(s.clicks ?? 0)),
      );
    return (rows ?? []).map((row: any) => ({
      ...row,
      clicks: clicks.get(row.tracked_link_id) ?? 0,
    }));
  });

async function requireShortioAdmin(context: any) {
  const tenantId = await resolveOperationalTenantId(context.supabase);
  return requireTenantAdmin(
    context.supabase,
    tenantId,
    "Apenas administradores da conta podem configurar a Short.io.",
  );
}

export const getShortioSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireShortioAdmin(context);
    const db = context.supabase as any;
    const [{ data, error }, { data: lastSync }] = await Promise.all([
      db
        .from("shortio_settings")
        .select(
          "enabled,domain,attribution_mode,fallback_mode,default_ttl_days,allowed_destination_hosts,enabled_channels,updated_at",
        )
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      db
        .from("link_tracking_sync_runs")
        .select("finished_at,status,links_processed,error")
        .eq("tenant_id", tenantId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (error) throw new Error(error.message);
    return {
      settings: data ?? {
        enabled: false,
        domain: null,
        attribution_mode: "individual",
        fallback_mode: "block",
        default_ttl_days: null,
        allowed_destination_hosts: [],
        enabled_channels: ["sms", "email"],
      },
      health: { configured: Boolean(process.env.SHORTIO_API_KEY), lastSync: lastSync ?? null },
    };
  });

const settingsInput = z.object({
  enabled: z.boolean(),
  domain: z.string().trim().max(253).nullable(),
  // Aggregate attribution is intentionally unavailable until its data model
  // and reporting semantics are implemented.
  attribution_mode: z.literal("individual"),
  fallback_mode: z.enum(["block", "passthrough"]),
  default_ttl_days: z.number().int().min(1).max(3650).nullable(),
  allowed_destination_hosts: z.array(z.string().trim().min(1).max(253)).max(50),
  enabled_channels: z
    .array(z.enum(["sms", "email"]))
    .min(1)
    .max(2),
});

export const saveShortioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => settingsInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireShortioAdmin(context);
    await assertTenantNotDemo(tenantId);
    const domain =
      data.domain
        ?.replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .toLowerCase() || null;
    const hosts = Array.from(
      new Set(
        data.allowed_destination_hosts.map((host) =>
          host
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, "")
            .replace(/^\.+/, ""),
        ),
      ),
    );
    const { error } = await (context.supabase as any).from("shortio_settings").upsert(
      {
        ...data,
        tenant_id: tenantId,
        domain,
        allowed_destination_hosts: hosts,
        enabled_channels: data.enabled_channels,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
