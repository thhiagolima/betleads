/* eslint-disable @typescript-eslint/no-explicit-any -- tables are introduced by the current migration before generated DB types refresh. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { journeyInputSchema, journeyStatusSchema } from "./journeys.shared";

const journeyIdSchema = z.object({ id: z.string().uuid() });
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
    const { data: enrollments, error: enrollmentsError } = await db
      .from("journey_enrollments")
      .select("status,exit_reason,current_position,metadata,players(total_depositado)")
      .eq("journey_id", data.id)
      .eq("tenant_id", tenantId);
    if (enrollmentsError) throw new Error(enrollmentsError.message);
    const rows = enrollments ?? [];
    const byStatus = rows.reduce((acc: Record<string, number>, row: { status: string }) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    const exits = rows
      .filter((row: { exit_reason?: string | null }) => row.exit_reason)
      .reduce((acc: Record<string, number>, row: { exit_reason: string }) => {
        acc[row.exit_reason] = (acc[row.exit_reason] ?? 0) + 1;
        return acc;
      }, {});
    const positions = rows.reduce(
      (acc: Record<string, number>, row: { current_position: number }) => {
        acc[String(row.current_position)] = (acc[String(row.current_position)] ?? 0) + 1;
        return acc;
      },
      {},
    );
    const recovered = rows.reduce(
      (
        sum: number,
        row: {
          metadata?: { deposited_before_entry?: number };
          players?: { total_depositado?: number | null } | null;
        },
      ) =>
        sum +
        Math.max(
          0,
          Number(row.players?.total_depositado ?? 0) -
            Number(row.metadata?.deposited_before_entry ?? row.players?.total_depositado ?? 0),
        ),
      0,
    );
    const { data: executions } = await db
      .from("journey_step_executions")
      .select("channel,status")
      .eq("journey_id", data.id)
      .eq("tenant_id", tenantId);
    const sentByChannel = (executions ?? [])
      .filter((row: { status: string }) => row.status === "sent" || row.status === "delivered")
      .reduce((acc: Record<string, number>, row: { channel: string | null }) => {
        const key = row.channel ?? "other";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    const cost =
      (sentByChannel.sms ?? 0) * 0.12 +
      (sentByChannel.email ?? 0) * 0.01 +
      (sentByChannel.voice ?? 0) * 0.35;
    return {
      journey,
      steps: steps ?? [],
      metrics: {
        total: rows.length,
        byStatus,
        exits,
        positions,
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
    if (input.trigger_type === "manual" && input.entry_rules.audience === "manual") {
      throw new Error("Público manual ainda não está disponível. Use uma audiência elegível.");
    }
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
    const steps = input.steps.map((step, position) => ({
      tenant_id: tenantId,
      position,
      step_type: step.step_type,
      label: step.label ?? null,
      config: step.config,
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
