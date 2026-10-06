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
};

async function tenant(context: { supabase: Parameters<typeof resolveOperationalTenantId>[0] }) {
  return resolveOperationalTenantId(context.supabase);
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
      .select("status,exit_reason,current_position")
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
    return {
      journey,
      steps: steps ?? [],
      metrics: { total: rows.length, byStatus, exits, positions },
    };
  });

export const saveJourney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ id: z.string().uuid().optional(), journey: journeyInputSchema }).parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
    const input = data.journey;
    const payload = {
      tenant_id: tenantId,
      name: input.name,
      description: input.description ?? null,
      trigger_type: input.trigger_type,
      trigger_config: input.trigger_config,
      entry_rules: input.entry_rules,
      exit_rules: input.exit_rules,
      daily_limit: input.daily_limit,
      cooldown_hours: input.cooldown_hours,
    };
    let journeyId = data.id;
    if (journeyId) {
      const { error } = await db
        .from("journeys")
        .update(payload)
        .eq("id", journeyId)
        .eq("tenant_id", tenantId);
      if (error) throw new Error(error.message);
      const { error: removeError } = await db
        .from("journey_steps")
        .delete()
        .eq("journey_id", journeyId);
      if (removeError) throw new Error(removeError.message);
    } else {
      const { data: created, error } = await db
        .from("journeys")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      journeyId = created.id;
    }
    const steps = input.steps.map((step, position) => ({
      tenant_id: tenantId,
      journey_id: journeyId,
      position,
      step_type: step.step_type,
      label: step.label ?? null,
      config: step.config,
    }));
    const { error: stepsError } = await db.from("journey_steps").insert(steps);
    if (stepsError) throw new Error(stepsError.message);
    return { id: journeyId };
  });

export const setJourneyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ id: z.string().uuid(), status: journeyStatusSchema }).parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await tenant(context);
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
