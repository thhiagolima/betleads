/* eslint-disable @typescript-eslint/no-explicit-any -- Short.io tables are introduced by a migration pending generated client types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertTenantNotDemo,
  requireTenantAdmin,
  resolveOperationalTenantId,
} from "./tenant-access.server";
import { z } from "zod";

type OverviewRow = {
  channel: string;
  source_type: string;
  sent: number | string;
  links: number | string;
  clicks: number | string;
};

/** Shapes the rows of the `link_tracking_overview` RPC (bigints arrive as strings). */
export function overviewFromRows(rows: OverviewRow[]) {
  const mapped = rows.map((row) => {
    const sent = Number(row.sent ?? 0);
    const clicks = Number(row.clicks ?? 0);
    return {
      channel: row.channel,
      sourceType: row.source_type,
      sent,
      clicks,
      links: Number(row.links ?? 0),
      ctr: sent ? clicks / sent : 0,
    };
  });
  return {
    rows: mapped,
    sent: mapped.reduce((sum, row) => sum + row.sent, 0),
    clicks: mapped.reduce((sum, row) => sum + row.clicks, 0),
  };
}

export const getLinkTrackingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    // Aggregated in the database (migration 20261031100000): ~226k dispatches a
    // month are too many to sum row by row here. Clicks are the sends clicked on
    // our own redirect, so they need no Short.io sync.
    const overview = await db.rpc("link_tracking_overview", { _tenant: tenantId, _since: since });
    if (overview.error) throw new Error(overview.error.message);
    const { rows, sent, clicks } = overviewFromRows((overview.data ?? []) as OverviewRow[]);
    return { since, sent, clicks, rows };
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
    // Human clicks on our own redirect, recorded the moment they happen and in
    // every house. Short.io snapshots depend on a background sync, count bots
    // and lag behind.
    const ids = (rows ?? []).map((r: any) => r.id);
    const { data: events, error: eventsError } = ids.length
      ? await db
          .from("click_events")
          .select("link_dispatch_id")
          .eq("tenant_id", tenantId)
          .eq("is_human", true)
          .in("link_dispatch_id", ids)
      : { data: [], error: null };
    if (eventsError) throw new Error(eventsError.message);
    const clicks = new Map<string, number>();
    for (const e of events ?? [])
      clicks.set(e.link_dispatch_id, (clicks.get(e.link_dispatch_id) ?? 0) + 1);
    return (rows ?? []).map((row: any) => ({
      ...row,
      clicks: clicks.get(row.id) ?? 0,
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
  // Accepted for compatibility with older clients but IGNORED: the shortener
  // domain is now managed through tenant_domains (Configuração da casa), and
  // this form must never overwrite shortio_settings.domain.
  domain: z.string().trim().max(253).nullable().optional(),
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

/** Builds the shortio_settings upsert row. Never includes `domain` (nor any
 * other column not listed here), so a save from the links settings page can
 * not null the legacy shortener domain. */
export function buildShortioSettingsUpsert(
  data: z.infer<typeof settingsInput>,
  tenantId: string,
  userId: string,
  now: Date = new Date(),
) {
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
  return {
    tenant_id: tenantId,
    enabled: data.enabled,
    attribution_mode: data.attribution_mode,
    fallback_mode: data.fallback_mode,
    default_ttl_days: data.default_ttl_days,
    allowed_destination_hosts: hosts,
    enabled_channels: data.enabled_channels,
    updated_by: userId,
    updated_at: now.toISOString(),
  };
}

export const saveShortioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => settingsInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireShortioAdmin(context);
    await assertTenantNotDemo(tenantId);
    const { error } = await (context.supabase as any)
      .from("shortio_settings")
      .upsert(buildShortioSettingsUpsert(data, tenantId, context.userId), { onConflict: "tenant_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
