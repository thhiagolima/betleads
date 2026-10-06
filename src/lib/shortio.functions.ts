/* eslint-disable @typescript-eslint/no-explicit-any -- Short.io tables are introduced by a migration pending generated client types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { z } from "zod";

export const getLinkTrackingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: dispatches, error } = await db
      .from("link_dispatches")
      .select("id,channel,source_type,tracked_link_id,sent_at")
      .eq("tenant_id", tenantId)
      .eq("send_status", "sent")
      .gte("sent_at", since);
    if (error) throw new Error(error.message);
    const linkIds = Array.from(new Set((dispatches ?? []).map((row: any) => row.tracked_link_id)));
    const { data: snapshots } = linkIds.length
      ? await db
          .from("link_click_snapshots")
          .select("tracked_link_id,clicks,snapshot_at")
          .in("tracked_link_id", linkIds)
      : { data: [] };
    const clicksByLink = new Map<string, number>();
    for (const row of snapshots ?? []) {
      const previous = clicksByLink.get(row.tracked_link_id) ?? 0;
      clicksByLink.set(row.tracked_link_id, Math.max(previous, Number(row.clicks ?? 0)));
    }
    const grouped = new Map<
      string,
      { channel: string; sourceType: string; sent: number; clicks: number; links: Set<string> }
    >();
    for (const row of dispatches ?? []) {
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
      sent: (dispatches ?? []).length,
      clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      rows,
    };
  });

async function requireTenantAdmin(context: any) {
  const tenantId = await resolveOperationalTenantId(context.supabase);
  const { data, error } = await context.supabase.rpc("is_tenant_admin", { _tenant: tenantId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas administradores da conta podem configurar a Short.io.");
  return tenantId;
}

export const getShortioSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireTenantAdmin(context);
    const { data, error } = await (context.supabase as any)
      .from("shortio_settings")
      .select(
        "enabled,domain,attribution_mode,fallback_mode,default_ttl_days,allowed_destination_hosts,updated_at",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (
      data ?? {
        enabled: false,
        domain: null,
        attribution_mode: "individual",
        fallback_mode: "block",
        default_ttl_days: null,
        allowed_destination_hosts: [],
      }
    );
  });

const settingsInput = z.object({
  enabled: z.boolean(),
  domain: z.string().trim().max(253).nullable(),
  attribution_mode: z.enum(["individual", "aggregate"]),
  fallback_mode: z.enum(["block", "passthrough"]),
  default_ttl_days: z.number().int().min(1).max(3650).nullable(),
  allowed_destination_hosts: z.array(z.string().trim().min(1).max(253)).max(50),
});

export const saveShortioSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => settingsInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireTenantAdmin(context);
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
    const { error } = await (context.supabase as any)
      .from("shortio_settings")
      .upsert(
        {
          ...data,
          tenant_id: tenantId,
          domain,
          allowed_destination_hosts: hosts,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
