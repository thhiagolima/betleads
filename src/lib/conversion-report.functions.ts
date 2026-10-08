/* eslint-disable @typescript-eslint/no-explicit-any -- conversion tables await generated DB types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "./tenant-access.server";

const inputSchema = z.object({
  sourceType: z.enum(["campaign", "journey"]),
  sourceId: z.string().uuid(),
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
        .select("id,send_status,sent_at,updated_at")
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
    const sent = dispatches.filter((item: any) => item.send_status === "sent").length;
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
      delivered: null,
      clicked: null,
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
