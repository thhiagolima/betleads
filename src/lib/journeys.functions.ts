/* eslint-disable @typescript-eslint/no-explicit-any -- tables are introduced by the current migration before generated DB types refresh. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { journeyInputSchema, journeyStatusSchema } from "./journeys.shared";
import { journeyEntryKey } from "./journey-policy";

const journeyIdSchema = z.object({ id: z.string().uuid() });
const manualEnrollmentSchema = z.object({
  journeyId: z.string().uuid(),
  playerId: z.string().uuid(),
  entryKey: z.string().trim().min(1).max(160).default("manual"),
});
const db = supabaseAdmin as unknown as {
  from: (table: string) => any;
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
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
        "id,name,description,status,trigger_type,daily_limit,cooldown_hours,updated_at,journey_steps(id)",
      )
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { journeys: data ?? [] };
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
      total?: number; byStatus?: Record<string, number>; exits?: Record<string, number>;
      positions?: Record<string, number>; recovered?: number; sentByChannel?: Record<string, number>;
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
    };
    const steps = await Promise.all(input.steps.map(async (step, position) => {
      let config: Record<string, unknown> = step.config;
      if (step.step_type === "email") {
        const { data: template } = await db.from("email_templates")
          .select("id,subject,body_html,version,is_active,lifecycle_status")
          .eq("id", step.config.template_id).eq("tenant_id", tenantId).maybeSingle();
        if (!template || template.is_active === false || template.lifecycle_status === "archived")
          throw new Error("Selecione um template de e-mail ativo deste tenant.");
        if (step.config.sender_id) {
          const { data: sender } = await db.from("email_smtp_configs").select("id")
            .eq("id", step.config.sender_id).eq("tenant_id", tenantId).maybeSingle();
          if (!sender) throw new Error("Selecione um remetente de e-mail deste tenant.");
        }
        config = { ...step.config, template_snapshot: {
          id: template.id, subject: template.subject, body_html: template.body_html,
          version: Number(template.version ?? 1),
        } };
      }
      if (step.step_type === "voice") {
        const { data: asset } = await db.from("journey_voice_assets").select("id")
          .eq("id", step.config.asset_id).eq("tenant_id", tenantId).maybeSingle();
        if (!asset) throw new Error("Selecione um áudio de voz deste tenant.");
      }
      return { tenant_id: tenantId, position, step_type: step.step_type, label: step.label ?? null, config };
    }));
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
    if (data.status === "active") {
      if (process.env.JOURNEYS_PUBLISHING_ENABLED !== "true") {
        throw new Error("A publicação de jornadas está temporariamente indisponível enquanto a validação operacional é concluída.");
      }
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
        throw new Error("Adicione ao menos uma etapa de envio antes de publicar a régua.");
      for (const step of actionable as Array<{
        step_type: string;
        config: Record<string, unknown>;
      }>) {
        if (step.step_type === "sms" && !String(step.config.content ?? "").trim())
          throw new Error("Há uma etapa de SMS sem mensagem.");
        if (step.step_type === "email" && !step.config.template_id)
          throw new Error("Há uma etapa de e-mail sem template.");
        if (step.step_type === "voice")
          throw new Error("Etapas de voz não podem ser publicadas até a certificação operacional do canal.");
      }
    }
    const { error } = await db
      .from("journeys")
      .update({ status: data.status })
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
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
      const { data: previous } = await db.from("journey_enrollments").select("created_at")
        .eq("journey_id", journey.id).eq("player_id", player.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (previous && Date.parse(previous.created_at) > Date.now() - hours * 3600_000)
        throw new Error("Este jogador ainda está no período de reentrada da jornada.");
    }
    const { data: created, error } = await db.from("journey_enrollments").insert({
      tenant_id: tenantId, journey_id: journey.id, journey_version: journey.version,
      player_id: player.id, entry_key: journeyEntryKey("manual", journey.entry_rules ?? {}, data.entryKey),
      metadata: { trigger: "manual", actor_user_id: context.userId, deposited_before_entry: Number(player.total_depositado ?? 0) },
    }).select("id").maybeSingle();
    if (error && !/duplicate|unique/i.test(error.message)) throw new Error("Não foi possível matricular o jogador.");
    if (!created) return { ok: true, duplicate: true };
    await db.from("journey_events").insert({
      tenant_id: tenantId, journey_id: journey.id, enrollment_id: created.id, event_type: "manually_enrolled",
      detail: { player_id: player.id, occurrence_key: data.entryKey }, actor_user_id: context.userId,
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
