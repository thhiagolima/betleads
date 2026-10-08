/* eslint-disable @typescript-eslint/no-explicit-any -- tables are introduced by the current migration before generated DB types refresh. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { journeyInputSchema, journeyStatusSchema } from "./journeys.shared";
import { journeyEntryKey } from "./journey-policy";
import { conversionFunnelSnapshot } from "./conversion-funnel";

const journeyIdSchema = z.object({ id: z.string().uuid() });
const legacyJourneySchema = z.object({
  sourceType: z.enum(["sms_flow", "email_flow"]),
  sourceId: z.string().uuid(),
});
const manualEnrollmentSchema = z.object({
  journeyId: z.string().uuid(),
  playerId: z.string().uuid(),
  entryKey: z.string().trim().min(1).max(160).default("manual"),
});
const db = supabaseAdmin as unknown as {
  from: (table: string) => any;
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function tenant(context: { supabase: Parameters<typeof resolveOperationalTenantId>[0] }) {
  return resolveOperationalTenantId(context.supabase);
}

type JourneyRole = "admin" | "gestor" | "member" | "super_admin";

async function journeyRole(userId: string, tenantId: string): Promise<JourneyRole | null> {
  const { data: superAdmin, error: superAdminError } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (superAdminError) throw new Error("Não foi possível validar a permissão.");
  if (superAdmin) return "super_admin";
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error("Não foi possível validar a permissão.");
  return (data?.role as JourneyRole | undefined) ?? null;
}

async function requireJourneyDraftEditor(userId: string, tenantId: string) {
  const role = await journeyRole(userId, tenantId);
  if (role !== "admin" && role !== "gestor" && role !== "super_admin") {
    throw new Error("Você não tem permissão para editar jornadas.");
  }
}

async function requireJourneyPublisher(userId: string, tenantId: string) {
  const role = await journeyRole(userId, tenantId);
  if (role !== "admin" && role !== "super_admin") {
    throw new Error("Somente administradores podem publicar, pausar ou arquivar jornadas.");
  }
}

export const listJourneys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await tenant(context);
    const { data, error } = await db
      .from("journeys")
      .select(
        "id,name,description,status,trigger_type,daily_limit,cooldown_hours,updated_at,journey_steps(id,position,step_type,config,is_enabled)",
      )
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    const journeys = await Promise.all(
      (data ?? []).map(async (journey: any) => {
        const { data: metricData, error: metricsError } = await db.rpc("journey_metrics", {
          p_tenant_id: tenantId,
          p_journey_id: journey.id,
        });
        if (metricsError) throw new Error(metricsError.message);
        return { ...journey, metrics: metricData ?? {} };
      }),
    );
    return { journeys };
  });

/** Compatibility inventory used only while the old SMS/e-mail engines are retired. */
export const listLegacyJourneys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await tenant(context);
    const [sms, email, converted] = await Promise.all([
      db
        .from("sms_flows")
        .select("id,name,trigger_name,is_active,updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false }),
      db
        .from("email_flows")
        .select("id,name,trigger_type,active,updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false }),
      db
        .from("journeys")
        .select("id,status,legacy_source_type,legacy_source_id")
        .eq("tenant_id", tenantId)
        .not("legacy_source_id", "is", null),
    ]);
    if (sms.error || email.error || converted.error)
      throw new Error("Não foi possível carregar as automações legadas.");
    const migrated = new Map<
      string,
      { id: string; status: "draft" | "active" | "paused" | "archived" }
    >(
      (
        (converted.data ?? []) as Array<{
          id: string;
          status: "draft" | "active" | "paused" | "archived";
          legacy_source_type: string;
          legacy_source_id: string;
        }>
      ).map((row) => [
        `${row.legacy_source_type}:${row.legacy_source_id}`,
        { id: row.id, status: row.status },
      ]),
    );
    return {
      items: [
        ...(sms.data ?? []).map((flow: any) => ({
          sourceType: "sms_flow" as const,
          sourceId: flow.id,
          channel: "sms" as const,
          name: flow.name,
          trigger: flow.trigger_name ?? "manual",
          active: flow.is_active,
          updatedAt: flow.updated_at,
          journeyId: migrated.get(`sms_flow:${flow.id}`)?.id ?? null,
          journeyStatus: migrated.get(`sms_flow:${flow.id}`)?.status ?? null,
        })),
        ...(email.data ?? []).map((flow: any) => ({
          sourceType: "email_flow" as const,
          sourceId: flow.id,
          channel: "email" as const,
          name: flow.name,
          trigger: flow.trigger_type,
          active: flow.active,
          updatedAt: flow.updated_at,
          journeyId: migrated.get(`email_flow:${flow.id}`)?.id ?? null,
          journeyStatus: migrated.get(`email_flow:${flow.id}`)?.status ?? null,
        })),
      ],
    };
  });

/** Final sunset step: disable the old runner only after its replacement is active. */
export const retireLegacyJourney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => legacyJourneySchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyPublisher(context.userId, tenantId);
    const { data: journey, error } = await db
      .from("journeys")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .eq("legacy_source_type", data.sourceType)
      .eq("legacy_source_id", data.sourceId)
      .maybeSingle();
    if (error || !journey) throw new Error("Converta esta automação antes de desativá-la.");
    if (journey.status !== "active")
      throw new Error("Revise e publique a jornada convertida antes de desativar o legado.");
    const table = data.sourceType === "sms_flow" ? "sms_flows" : "email_flows";
    const activeColumn = data.sourceType === "sms_flow" ? "is_active" : "active";
    const { error: retireError } = await db
      .from(table)
      .update({ [activeColumn]: false })
      .eq("tenant_id", tenantId)
      .eq("id", data.sourceId);
    if (retireError) throw new Error("Não foi possível desativar a automação legada.");
    await db.from("journey_events").insert({
      tenant_id: tenantId,
      journey_id: journey.id,
      event_type: "legacy_retired",
      actor_user_id: context.userId,
      detail: { source_type: data.sourceType, source_id: data.sourceId },
    });
    return { ok: true };
  });

/** Converts one legacy automation to an inert, reviewable journey draft. */
export const convertLegacyJourney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => legacyJourneySchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyDraftEditor(context.userId, tenantId);
    const { data: existing } = await db
      .from("journeys")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("legacy_source_type", data.sourceType)
      .eq("legacy_source_id", data.sourceId)
      .maybeSingle();
    if (existing) return { id: existing.id, alreadyConverted: true, warnings: [] as string[] };

    const steps: Array<{
      step_type: "wait" | "sms" | "email" | "end";
      label?: string;
      config: Record<string, unknown>;
    }> = [];
    const warnings: string[] = [];
    const addWait = (seconds: number, label?: string) => {
      if (seconds > 0)
        steps.push({
          step_type: "wait",
          label,
          config: { delay_seconds: Math.max(60, Math.round(seconds)) },
        });
    };
    let journey: {
      name: string;
      trigger: string;
      dailyLimit: number;
      cooldownHours: number;
      exitRules: Record<string, unknown>;
    };

    if (data.sourceType === "sms_flow") {
      const { data: flow, error } = await db
        .from("sms_flows")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", data.sourceId)
        .maybeSingle();
      if (error || !flow) throw new Error("Automação legada de SMS não encontrada.");
      const { data: legacySteps, error: stepError } = await db
        .from("sms_flow_steps")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("flow_id", data.sourceId)
        .eq("is_active", true)
        .order("order_index", { ascending: true });
      if (stepError) throw new Error("Não foi possível ler as etapas legadas de SMS.");
      const templateIds = (legacySteps ?? []).map((step: any) => step.template_id).filter(Boolean);
      const templates = templateIds.length
        ? await db
            .from("sms_templates")
            .select("id,name,content,version,is_active")
            .eq("tenant_id", tenantId)
            .in("id", templateIds)
        : { data: [], error: null };
      const byId = new Map((templates.data ?? []).map((template: any) => [template.id, template]));
      for (const step of legacySteps ?? []) {
        const delay = Number(step.delay_days ?? 0) * 86400 + Number(step.delay_hours ?? 0) * 3600;
        addWait(delay, delay ? `Espera antes de ${Number(step.order_index) + 1}` : undefined);
        if (step.step_type === "delay") continue;
        const template: any = step.template_id ? byId.get(step.template_id) : null;
        const content = String(
          step.content ?? template?.content ?? step.template_snapshot?.content ?? "",
        ).trim();
        if (!content)
          throw new Error(`A etapa ${Number(step.order_index) + 1} não possui mensagem de SMS.`);
        if (step.template_id && (!template || template.is_active === false))
          warnings.push(
            `A etapa ${Number(step.order_index) + 1} usava um template inativo ou removido; o texto salvo foi preservado.`,
          );
        steps.push({
          step_type: "sms",
          label: `SMS ${Number(step.order_index) + 1}`,
          config: {
            content,
            ...(template
              ? {
                  template_id: template.id,
                  template_snapshot: {
                    id: template.id,
                    name: template.name,
                    content,
                    version: Number(template.version ?? 1),
                  },
                }
              : {}),
          },
        });
      }
      journey = {
        name: flow.name,
        trigger: flow.trigger_name ?? "manual",
        dailyLimit: flow.daily_limit,
        cooldownHours: flow.cooldown_hours,
        exitRules: flow.exit_conditions ?? {},
      };
    } else {
      const { data: flow, error } = await db
        .from("email_flows")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", data.sourceId)
        .maybeSingle();
      if (error || !flow) throw new Error("Automação legada de e-mail não encontrada.");
      const { data: blocks, error: blockError } = await db
        .from("email_flow_blocks")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("flow_id", data.sourceId)
        .order("order_index", { ascending: true });
      if (blockError) throw new Error("Não foi possível ler as etapas legadas de e-mail.");
      const templateIds = (blocks ?? []).flatMap((block: any) => block.template_ids ?? []);
      const templates = templateIds.length
        ? await db
            .from("email_templates")
            .select("id,subject,body_html,version,is_active,lifecycle_status")
            .eq("tenant_id", tenantId)
            .in("id", templateIds)
        : { data: [], error: null };
      const byId = new Map((templates.data ?? []).map((template: any) => [template.id, template]));
      for (const block of blocks ?? []) {
        if (block.block_type === "start") continue;
        if (block.block_type === "delay") {
          addWait(Number(block.delay_seconds ?? 0), block.label ?? "Espera");
          continue;
        }
        if (block.block_type === "end" || block.block_type === "remove") {
          steps.push({ step_type: "end", label: block.label ?? "Fim", config: {} });
          continue;
        }
        if (block.block_type === "condition" || block.block_type === "tag") {
          warnings.push(
            `O bloco "${block.label ?? block.block_type}" era apenas informativo no executor legado e não foi copiado.`,
          );
          continue;
        }
        if (block.block_type !== "send_email") continue;
        addWait(Number(block.pre_delay_seconds ?? 0), `Espera antes de ${block.label ?? "e-mail"}`);
        const ids = block.template_ids ?? [];
        const template: any = byId.get(ids[0]);
        if (!template || template.is_active === false || template.lifecycle_status === "archived")
          throw new Error(
            `O bloco "${block.label ?? "E-mail"}" não possui um template ativo para conversão.`,
          );
        if (ids.length > 1)
          warnings.push(
            `O bloco "${block.label ?? "E-mail"}" tinha variações; a primeira foi mantida para revisão.`,
          );
        if (block.send_at_hour != null)
          warnings.push(
            `O horário fixo do bloco "${block.label ?? "E-mail"}" deve ser revisado antes da publicação.`,
          );
        steps.push({
          step_type: "email",
          label: block.label ?? "E-mail",
          config: {
            template_id: template.id,
            ...(block.smtp_config_id ? { sender_id: block.smtp_config_id } : {}),
            template_snapshot: {
              id: template.id,
              subject: block.subject_override ?? template.subject,
              body_html: template.body_html,
              version: Number(template.version ?? 1),
            },
          },
        });
      }
      journey = {
        name: flow.name,
        trigger: flow.trigger_type,
        dailyLimit: flow.daily_limit,
        cooldownHours: flow.cooldown_hours,
        exitRules: flow.exit_conditions ?? {},
      };
    }
    if (!steps.some((step) => step.step_type === "sms" || step.step_type === "email"))
      throw new Error("A automação legada não possui nenhuma etapa de envio compatível.");
    if (steps.at(-1)?.step_type !== "end")
      steps.push({ step_type: "end", label: "Fim", config: {} });
    const { data: journeyId, error: saveError } = await db.rpc("save_journey_draft", {
      p_tenant_id: tenantId,
      p_journey_id: null,
      p_actor_user_id: context.userId,
      p_journey: {
        name: journey.name,
        description: `Convertida de uma automação legada de ${data.sourceType === "sms_flow" ? "SMS" : "e-mail"}. Revise antes de publicar.`,
        trigger_type: journey.trigger,
        trigger_config: {},
        entry_rules: { reentry: "never" },
        exit_rules: journey.exitRules,
        daily_limit: journey.dailyLimit,
        cooldown_hours: journey.cooldownHours,
      },
      p_steps: steps,
    });
    if (saveError || !journeyId) throw new Error("Não foi possível criar o rascunho convertido.");
    const { error: linkError } = await db
      .from("journeys")
      .update({
        legacy_source_type: data.sourceType,
        legacy_source_id: data.sourceId,
        legacy_migrated_at: new Date().toISOString(),
      })
      .eq("id", journeyId)
      .eq("tenant_id", tenantId);
    if (linkError) {
      await db.from("journeys").delete().eq("id", journeyId).eq("tenant_id", tenantId);
      const { data: raced } = await db
        .from("journeys")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("legacy_source_type", data.sourceType)
        .eq("legacy_source_id", data.sourceId)
        .maybeSingle();
      if (raced) return { id: raced.id, alreadyConverted: true, warnings: [] as string[] };
      throw new Error("Não foi possível vincular a conversão ao item legado.");
    }
    await db.from("journey_events").insert({
      tenant_id: tenantId,
      journey_id: journeyId,
      event_type: "legacy_converted",
      actor_user_id: context.userId,
      detail: { source_type: data.sourceType, source_id: data.sourceId, warnings },
    });
    return { id: String(journeyId), alreadyConverted: false, warnings };
  });

export const getJourney = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => journeyIdSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    const { data: journey, error } = await db
      .from("journeys")
      .select("*")
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!journey) throw new Error("Jornada não encontrada");
    const { data: steps, error: stepsError } = await db
      .from("journey_steps")
      .select("*")
      .eq("journey_id", data.id)
      .order("position");
    if (stepsError) throw new Error(stepsError.message);
    const { data: metricData, error: metricsError } = await db.rpc("journey_metrics", {
      p_tenant_id: tenantId,
      p_journey_id: data.id,
    });
    if (metricsError) throw new Error(metricsError.message);
    const aggregate = (metricData ?? {}) as {
      total?: number;
      byStatus?: Record<string, number>;
      exits?: Record<string, number>;
      positions?: Record<string, number>;
      recovered?: number;
      sentByChannel?: Record<string, number>;
    };
    const sentByChannel = aggregate.sentByChannel ?? {};
    const recovered = Number(aggregate.recovered ?? 0);
    const cost =
      (sentByChannel.sms ?? 0) * 0.12 +
      (sentByChannel.email ?? 0) * 0.01 +
      (sentByChannel.voice ?? 0) * 0.35;
    return {
      journey,
      steps: steps ?? [],
      metrics: {
        total: Number(aggregate.total ?? 0),
        byStatus: aggregate.byStatus ?? {},
        exits: aggregate.exits ?? {},
        positions: aggregate.positions ?? {},
        recovered,
        sentByChannel,
        cost,
        roi: cost > 0 ? recovered / cost : null,
      },
    };
  });

export const saveJourney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ id: z.string().uuid().optional(), journey: journeyInputSchema }).parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyDraftEditor(context.userId, tenantId);
    const input = data.journey;
    const payload = {
      name: input.name,
      description: input.description ?? null,
      trigger_type: input.trigger_type,
      trigger_config: input.trigger_config,
      entry_rules: input.entry_rules,
      exit_rules: input.exit_rules,
      daily_limit: input.daily_limit,
      cooldown_hours: input.cooldown_hours,
      conversion_objective: input.conversion_objective,
    };
    const steps = await Promise.all(
      input.steps.map(async (step, position) => {
        let config: Record<string, unknown> = step.config;
        if (step.step_type === "email") {
          const { data: template } = await db
            .from("email_templates")
            .select("id,subject,body_html,version,is_active,lifecycle_status")
            .eq("id", step.config.template_id)
            .eq("tenant_id", tenantId)
            .maybeSingle();
          if (!template || template.is_active === false || template.lifecycle_status === "archived")
            throw new Error("Selecione um template de e-mail ativo deste tenant.");
          if (step.config.sender_id) {
            const { data: sender } = await db
              .from("email_smtp_configs")
              .select("id")
              .eq("id", step.config.sender_id)
              .eq("tenant_id", tenantId)
              .maybeSingle();
            if (!sender) throw new Error("Selecione um remetente de e-mail deste tenant.");
          }
          config = {
            ...step.config,
            template_snapshot: {
              id: template.id,
              subject: template.subject,
              body_html: template.body_html,
              version: Number(template.version ?? 1),
            },
          };
        }
        if (step.step_type === "voice") {
          const { data: asset } = await db
            .from("journey_voice_assets")
            .select("id, is_archived")
            .eq("id", step.config.asset_id)
            .eq("tenant_id", tenantId)
            .maybeSingle();
          if (!asset || asset.is_archived)
            throw new Error("Selecione um áudio de voz ativo deste tenant.");
        }
        return {
          tenant_id: tenantId,
          position,
          step_type: step.step_type,
          label: step.label ?? null,
          config,
        };
      }),
    );
    const { data: journeyId, error } = await db.rpc("save_journey_draft", {
      p_tenant_id: tenantId,
      p_journey_id: data.id ?? null,
      p_actor_user_id: context.userId,
      p_journey: payload,
      p_steps: steps.map(({ tenant_id: _tenantId, ...step }) => step),
    });
    if (error || !journeyId) {
      // The database keeps detailed diagnostics in its logs; never expose its
      // schema/provider details to a tenant user.
      throw new Error("Não foi possível salvar a jornada. Revise os dados e tente novamente.");
    }
    return { id: String(journeyId) };
  });

export const setJourneyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ id: z.string().uuid(), status: journeyStatusSchema }).parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyPublisher(context.userId, tenantId);
    const { data: journey, error: journeyError } = await db
      .from("journeys")
      .select("id,version,status,conversion_objective,conversion_funnel_snapshot")
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (journeyError || !journey) throw new Error("Jornada não encontrada.");
    if (data.status === "active") {
      const { data: steps, error: stepsError } = await db
        .from("journey_steps")
        .select("step_type,config,is_enabled")
        .eq("journey_id", data.id)
        .eq("tenant_id", tenantId)
        .eq("is_enabled", true);
      if (stepsError) throw new Error(stepsError.message);
      const actionable = (steps ?? []).filter(
        (step: { step_type: string }) => step.step_type !== "end",
      );
      if (!actionable.length)
        throw new Error("Adicione ao menos uma etapa de envio antes de publicar a jornada.");
      for (const step of actionable as Array<{
        step_type: string;
        config: Record<string, unknown>;
      }>) {
        if (step.step_type === "sms" && !String(step.config.content ?? "").trim())
          throw new Error("Há uma etapa de SMS sem mensagem.");
        if (step.step_type === "email" && !step.config.template_id)
          throw new Error("Há uma etapa de e-mail sem template.");
        if (step.step_type === "voice") {
          const assetId = String(step.config.asset_id ?? "");
          const { data: asset } = await db
            .from("journey_voice_assets")
            .select("id")
            .eq("id", assetId)
            .eq("tenant_id", tenantId)
            .eq("is_archived", false)
            .maybeSingle();
          if (!asset) throw new Error("Há uma etapa de voz sem áudio ativo deste tenant.");
        }
      }
    }
    const now = new Date().toISOString();
    const statusFields =
      data.status === "active"
        ? {
            activated_at: now,
            paused_at: null,
            archived_at: null,
            published_version: journey.version,
            approved_by: context.userId,
            conversion_funnel_snapshot:
              journey.conversion_funnel_snapshot ??
              conversionFunnelSnapshot(journey.conversion_objective ?? "journey", "journey"),
          }
        : data.status === "paused"
          ? { paused_at: now }
          : data.status === "archived"
            ? { archived_at: now }
            : {};
    const { error } = await db
      .from("journeys")
      .update({ status: data.status, ...statusFields })
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    await db.from("journey_events").insert({
      tenant_id: tenantId,
      journey_id: data.id,
      event_type: "status_changed",
      actor_user_id: context.userId,
      detail: { from: journey.status, to: data.status, version: journey.version },
    });
    return { ok: true };
  });

export const deleteJourney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => journeyIdSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyPublisher(context.userId, tenantId);
    const { data: journey, error: findError } = await db
      .from("journeys")
      .select("id,status")
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (findError || !journey) throw new Error("Jornada não encontrada.");
    if (journey.status === "active") throw new Error("Desligue a jornada antes de excluí-la.");
    const { error } = await db
      .from("journeys")
      .delete()
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error("Não foi possível excluir a jornada.");
    return { ok: true };
  });

/** Explicit, auditable entry point for journeys whose trigger is manual/API. */
export const enrollJourneyManually = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => manualEnrollmentSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    await requireJourneyDraftEditor(context.userId, tenantId);
    const { data: journey, error: journeyError } = await db
      .from("journeys")
      .select("id,version,status,trigger_type,entry_rules")
      .eq("id", data.journeyId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (journeyError || !journey) throw new Error("Jornada não encontrada.");
    if (journey.status !== "active" || journey.trigger_type !== "manual")
      throw new Error("Esta jornada não aceita matrícula manual no estado atual.");
    const { data: player, error: playerError } = await db
      .from("players")
      .select("id,total_depositado")
      .eq("id", data.playerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (playerError || !player) throw new Error("Jogador não encontrado.");
    if (journey.entry_rules?.reentry === "after_cooldown") {
      const hours = Math.max(1, Number(journey.entry_rules.reentry_cooldown_hours ?? 24));
      const { data: previous } = await db
        .from("journey_enrollments")
        .select("created_at")
        .eq("journey_id", journey.id)
        .eq("player_id", player.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (previous && Date.parse(previous.created_at) > Date.now() - hours * 3600_000)
        throw new Error("Este jogador ainda está no período de reentrada da jornada.");
    }
    const { data: created, error } = await db
      .from("journey_enrollments")
      .insert({
        tenant_id: tenantId,
        journey_id: journey.id,
        journey_version: journey.version,
        player_id: player.id,
        entry_key: journeyEntryKey("manual", journey.entry_rules ?? {}, data.entryKey),
        metadata: {
          trigger: "manual",
          actor_user_id: context.userId,
          deposited_before_entry: Number(player.total_depositado ?? 0),
        },
      })
      .select("id")
      .maybeSingle();
    if (error && !/duplicate|unique/i.test(error.message))
      throw new Error("Não foi possível matricular o jogador.");
    if (!created) return { ok: true, duplicate: true };
    await db.from("journey_events").insert({
      tenant_id: tenantId,
      journey_id: journey.id,
      enrollment_id: created.id,
      event_type: "manually_enrolled",
      detail: { player_id: player.id, occurrence_key: data.entryKey },
      actor_user_id: context.userId,
    });
    return { ok: true, duplicate: false };
  });

export const listJourneyOperations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await tenant(context);
    const { data, error } = await db
      .from("journey_enrollments")
      .select(
        "id,journey_id,player_id,status,current_position,next_run_at,exit_reason,journeys(name),players(nome,telefone)",
      )
      .eq("tenant_id", tenantId)
      .in("status", ["active", "waiting", "failed"])
      .order("next_run_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return { items: data ?? [] };
  });
