/* eslint-disable @typescript-eslint/no-explicit-any -- Short.io tables are introduced by a migration pending generated client types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "./tenant-access.server";

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
