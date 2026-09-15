// Server functions do construtor de Fluxos de Ligação (estrutura SEQUENCIAL).
// Fluxo = lista ordenada de blocos (call|delay). Cada bloco de ligação tem N SMS
// condicionais por resultado da chamada. Sem randomização / sem roteiros aleatórios.

import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  cancelProgress,
  enrollPlayerInFlow,
  tickFlows,
} from "./call-flows.server";

const SmsConditionSchema = z.enum([
  "always",
  "answered",
  "not_answered",
  "listened_gte",
  "listened_lt",
  "hangup_before",
  "voicemail",
  "busy",
  "failed",
  "no_answer",
]);

const BlockSmsSchema = z.object({
  condition: SmsConditionSchema,
  threshold_seconds: z.number().int().min(0).max(3600).nullable().optional(),
  template: z.string().max(800).default(""),
});

const CallBlockSchema = z.object({
  block_type: z.literal("call"),
  name: z.string().max(120).default(""),
  script_id: dbUuid().nullable().optional(),
  voice_id: z.string().max(120).nullable().optional(),
  max_call_seconds: z.number().int().min(5).max(600).default(60),
  max_attempts: z.number().int().min(1).max(10).default(1),
  delay_after_seconds: z.number().int().min(0).max(86400).default(0),
  sms: z.array(BlockSmsSchema).default([]),
});

const DelayBlockSchema = z.object({
  block_type: z.literal("delay"),
  delay_seconds: z.number().int().min(1).max(60 * 60 * 24 * 365).default(86400),
});

const BlockSchema = z.discriminatedUnion("block_type", [
  CallBlockSchema,
  DelayBlockSchema,
]);

const ExitConditionsSchema = z.object({
  login: z.boolean().default(true),
  deposit: z.boolean().default(true),
  first_deposit: z.boolean().default(true),
  voltou_jogar: z.boolean().default(false),
  deposit_amount_gte: z.number().min(0).nullable().optional(),
  bets_count_gte: z.number().int().min(0).nullable().optional(),
});

const FlowInputSchema = z.object({
  id: dbUuid().optional(),
  name: z.string().min(1).max(120),
  trigger_name: z.string().max(120).nullable().optional(),
  is_active: z.boolean().default(true),
  exit_conditions: ExitConditionsSchema,
  blocks: z.array(BlockSchema).default([]),
});

export const listCallFlows = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: flows, error } = await context.supabase
      .from("call_flows")
      .select("*, call_flow_blocks(*, call_flow_block_sms(*))")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { flows: flows ?? [] };
  });

export const getCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: flow, error } = await context.supabase
      .from("call_flows")
      .select("*, call_flow_blocks(*, call_flow_block_sms(*))")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!flow) throw new Error("Fluxo não encontrado");
    return { flow };
  });

export const saveCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => FlowInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const flowPayload = {
      name: data.name,
      trigger_name: data.trigger_name ?? null,
      is_active: data.is_active,
      // mantemos os campos legados desabilitados (sem efeito no runtime novo)
      randomize_scripts: false,
      avoid_last_script: false,
      exit_conditions: data.exit_conditions,
    };

    let flowId = data.id;
    if (flowId) {
      const { error } = await supabase
        .from("call_flows")
        .update(flowPayload)
        .eq("id", flowId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await supabase
        .from("call_flows")
        .insert(flowPayload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      flowId = created.id;
    }

    // Substitui blocos (delete + reinsert). CASCADE em call_flow_block_sms.
    const { error: dErr } = await supabase
      .from("call_flow_blocks")
      .delete()
      .eq("flow_id", flowId);
    if (dErr) throw new Error(dErr.message);

    for (let i = 0; i < data.blocks.length; i++) {
      const b = data.blocks[i];
      const blockRow =
        b.block_type === "call"
          ? {
              flow_id: flowId,
              order_index: i,
              block_type: "call" as const,
              name: b.name || `Ligação ${i + 1}`,
              script_id: b.script_id ?? null,
              voice_id: b.voice_id ?? null,
              max_call_seconds: b.max_call_seconds,
              max_attempts: b.max_attempts,
              delay_after_seconds: b.delay_after_seconds,
              delay_seconds: 0,
            }
          : {
              flow_id: flowId,
              order_index: i,
              block_type: "delay" as const,
              delay_seconds: b.delay_seconds,
              max_call_seconds: 60,
              max_attempts: 1,
              delay_after_seconds: 0,
            };

      const { data: insBlock, error: bErr } = await supabase
        .from("call_flow_blocks")
        .insert(blockRow as any)
        .select("id")
        .single();
      if (bErr) throw new Error(bErr.message);

      if (b.block_type === "call" && b.sms.length > 0) {
        const smsRows = b.sms.map((s, idx) => ({
          block_id: insBlock.id,
          priority: idx,
          condition: s.condition,
          threshold_seconds: s.threshold_seconds ?? null,
          template: s.template ?? "",
        }));
        const { error: sErr } = await supabase
          .from("call_flow_block_sms")
          .insert(smsRows);
        if (sErr) throw new Error(sErr.message);
      }
    }

    return { id: flowId };
  });

export const deleteCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("call_flows")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ id: dbUuid(), is_active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("call_flows")
      .update({ is_active: data.is_active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// === Histórico / progressão do player no fluxo ===

export const getPlayerFlowProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ player_id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: progress, error } = await context.supabase
      .from("call_flow_progress")
      .select("*, call_flows(name)")
      .eq("player_id", data.player_id)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { progress: progress ?? [] };
  });

export const getPlayerFlowHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ player_id: dbUuid(), limit: z.number().int().min(1).max(500).default(100) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("call_flow_history")
      .select("*, call_flows(name)")
      .eq("player_id", data.player_id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { history: rows ?? [] };
  });

// === Engine: matricular / cancelar / tick manual ===

export const enrollPlayerInCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ flow_id: dbUuid(), player_id: dbUuid() })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return enrollPlayerInFlow(data.flow_id, data.player_id);
  });

export const cancelPlayerCallFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        progress_id: dbUuid(),
        reason: z.string().max(120).default("manual"),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await cancelProgress(data.progress_id, data.reason);
    return { ok: true };
  });

export const runCallFlowsTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return tickFlows(100);
  });

export const listActiveCallFlowProgress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("call_flow_progress")
      .select("*, call_flows(name), players(nome, telefone)")
      .in("status", ["active", "waiting"])
      .order("next_run_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return { progress: data ?? [] };
  });