/* eslint-disable @typescript-eslint/no-explicit-any -- P2 tables precede generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveOperationalTenantId } from "./tenant-access.server";

const sourceSchema = z.object({
  sourceType: z.enum(["campaign", "journey"]),
  sourceId: z.string().uuid(),
});

async function requireAdmin(context: any, tenantId: string) {
  const db = context.supabase as any;
  const { data: superAdmin, error: superAdminError } = await db.rpc("is_super_admin", {
    _user_id: context.userId,
  });
  if (superAdminError) throw new Error("Não foi possível validar a permissão.");
  if (superAdmin) return;
  const { data, error } = await db
    .from("user_roles")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error || data?.role !== "admin") throw new Error("Acesso restrito a administradores.");
}

const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function defaultRange(from?: string, to?: string) {
  return {
    from: from ?? new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: to ?? new Date().toISOString(),
  };
}

async function sourceMetric(
  db: any,
  tenantId: string,
  source: z.infer<typeof sourceSchema>,
  from: string,
  to: string,
) {
  const sourceNamePromise =
    source.sourceType === "journey"
      ? db
          .from("journeys")
          .select("name")
          .eq("tenant_id", tenantId)
          .eq("id", source.sourceId)
          .maybeSingle()
      : Promise.all([
          db
            .from("sms_campaigns")
            .select("name")
            .eq("tenant_id", tenantId)
            .eq("id", source.sourceId)
            .maybeSingle(),
          db
            .from("email_campaigns")
            .select("name")
            .eq("tenant_id", tenantId)
            .eq("id", source.sourceId)
            .maybeSingle(),
        ]);
  const [dispatches, attributions, sourceNameResult] = await Promise.all([
    db
      .from("link_dispatches")
      .select("id,channel,send_status,delivery_status")
      .eq("tenant_id", tenantId)
      .eq("source_type", source.sourceType)
      .eq("source_id", source.sourceId)
      .gte("sent_at", from)
      .lte("sent_at", to),
    db
      .from("conversion_attributions")
      .select("event_type,monetary_value,classification,is_ftd")
      .eq("tenant_id", tenantId)
      .eq("source_type", source.sourceType)
      .eq("source_id", source.sourceId)
      .gte("occurred_at", from)
      .lte("occurred_at", to),
    sourceNamePromise,
  ]);
  if (dispatches.error) throw new Error(dispatches.error.message);
  if (attributions.error) throw new Error(attributions.error.message);
  const sends = dispatches.data ?? [];
  const conversions = attributions.data ?? [];
  const directDeposits = conversions.filter(
    (row: any) => row.event_type === "deposit_approved" && row.classification === "direct",
  );
  const assistedDeposits = conversions.filter(
    (row: any) => row.event_type === "deposit_approved" && row.classification === "assisted",
  );
  const sourceName = Array.isArray(sourceNameResult)
    ? sourceNameResult.find((result: any) => result.data?.name)?.data?.name
    : sourceNameResult.data?.name;
  return {
    ...source,
    name: sourceName ?? (source.sourceType === "campaign" ? "Campanha" : "Jornada"),
    sent: sends.filter((row: any) => row.send_status === "sent").length,
    delivered: sends.filter((row: any) => row.delivery_status === "delivered").length,
    conversions: directDeposits.length,
    directRevenue: directDeposits.reduce(
      (sum: number, row: any) => sum + Number(row.monetary_value ?? 0),
      0,
    ),
    assistedRevenue: assistedDeposits.reduce(
      (sum: number, row: any) => sum + Number(row.monetary_value ?? 0),
      0,
    ),
    channels: Object.fromEntries(
      ["sms", "email", "whatsapp"].map((channel) => [
        channel,
        sends.filter((row: any) => row.channel === channel).length,
      ]),
    ),
  };
}

export const compareConversionSources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    rangeSchema.extend({ sources: z.array(sourceSchema).min(2).max(5) }).parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const range = defaultRange(data.from, data.to);
    const rows = await Promise.all(
      data.sources.map((source) =>
        sourceMetric(context.supabase as any, tenantId, source, range.from, range.to),
      ),
    );
    return { ...range, rows };
  });

export const getExecutiveConversionReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => rangeSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const range = defaultRange(data.from, data.to);
    const { data: origins, error } = await db
      .from("link_dispatches")
      .select("source_type,source_id")
      .eq("tenant_id", tenantId)
      .in("source_type", ["campaign", "journey"])
      .gte("sent_at", range.from)
      .lte("sent_at", range.to)
      .limit(10000);
    if (error) throw new Error(error.message);
    const unique = new Map<string, z.infer<typeof sourceSchema>>();
    for (const origin of origins ?? []) {
      const parsed = sourceSchema.safeParse({
        sourceType: origin.source_type,
        sourceId: origin.source_id,
      });
      if (parsed.success)
        unique.set(`${parsed.data.sourceType}:${parsed.data.sourceId}`, parsed.data);
    }
    const rows = await Promise.all(
      [...unique.values()].map((source) =>
        sourceMetric(db, tenantId, source, range.from, range.to),
      ),
    );
    return {
      ...range,
      rows,
      totals: rows.reduce(
        (total, row) => ({
          sent: total.sent + row.sent,
          conversions: total.conversions + row.conversions,
          directRevenue: total.directRevenue + row.directRevenue,
          assistedRevenue: total.assistedRevenue + row.assistedRevenue,
        }),
        { sent: 0, conversions: 0, directRevenue: 0, assistedRevenue: 0 },
      ),
    };
  });

const experimentSchema = sourceSchema.extend({
  name: z.string().trim().min(1).max(120),
  dimension: z.enum(["template", "cta", "channel", "journey_step"]),
  variantA: z.record(z.string(), z.unknown()).default({}),
  variantB: z.record(z.string(), z.unknown()).default({}),
});

export const createConversionExperiment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => experimentSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireAdmin(context, tenantId);
    const db = context.supabase as any;
    const { data: created, error } = await db
      .from("conversion_experiments")
      .insert({
        tenant_id: tenantId,
        source_type: data.sourceType,
        source_id: data.sourceId,
        name: data.name,
        dimension: data.dimension,
        variant_a: data.variantA,
        variant_b: data.variantB,
        split_a: 50,
        status: "draft",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const listConversionExperiments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => sourceSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: rows, error } = await (context.supabase as any)
      .from("conversion_experiments")
      .select("id,name,dimension,status,variant_a,variant_b,started_at,ended_at,created_at")
      .eq("tenant_id", tenantId)
      .eq("source_type", data.sourceType)
      .eq("source_id", data.sourceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const setConversionExperimentStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({ id: z.string().uuid(), status: z.enum(["active", "paused", "completed"]) })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    await requireAdmin(context, tenantId);
    const patch =
      data.status === "active"
        ? { status: data.status, started_at: new Date().toISOString(), ended_at: null }
        : data.status === "completed"
          ? { status: data.status, ended_at: new Date().toISOString() }
          : { status: data.status };
    const { error } = await (context.supabase as any)
      .from("conversion_experiments")
      .update(patch)
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getConversionExperimentResults = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ id: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const [dispatchResult, assignmentResult] = await Promise.all([
      db
        .from("link_dispatches")
        .select(
          "id,experiment_variant,send_status,conversion_attributions(event_type,monetary_value,classification)",
        )
        .eq("tenant_id", tenantId)
        .eq("experiment_id", data.id),
      db
        .from("conversion_experiment_assignments")
        .select("variant")
        .eq("tenant_id", tenantId)
        .eq("experiment_id", data.id),
    ]);
    if (dispatchResult.error) throw new Error(dispatchResult.error.message);
    if (assignmentResult.error) throw new Error(assignmentResult.error.message);
    const dispatches = dispatchResult.data ?? [];
    const assignments = assignmentResult.data ?? [];
    const summarize = (variant: "A" | "B") => {
      const rows = dispatches.filter((row: any) => row.experiment_variant === variant);
      const recipients = assignments.filter((row: any) => row.variant === variant).length;
      const conversions = rows
        .flatMap((row: any) => row.conversion_attributions ?? [])
        .filter(
          (row: any) => row.event_type === "deposit_approved" && row.classification === "direct",
        );
      return {
        variant,
        recipients,
        conversions: conversions.length,
        conversionRate: recipients ? conversions.length / recipients : 0,
        revenue: conversions.reduce(
          (sum: number, row: any) => sum + Number(row.monetary_value ?? 0),
          0,
        ),
      };
    };
    return { variants: [summarize("A"), summarize("B")] };
  });
