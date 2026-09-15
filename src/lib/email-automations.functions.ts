// Server functions (RPC) para o construtor visual de automacoes de email.
import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runEmailFlowDispatcher } from "./email-automations.server";

const TriggerSchema = z.enum([
  "lead_cadastrado","recuperacao_vip","vip_esfriando","receita_em_queda","lead_quente_esfriando",
  "quase_vip","alto_potencial","reativacao_em_curso","dinheiro_parado",
  "engajado_sem_converter","frequencia_caindo","cadastrados_sem_deposito",
  "sem_login_7_14","sem_login_15_24","sem_login_25_34","sem_login_35_44",
  "sem_login_45_59","sem_login_60_mais",
]);

const BlockTypeSchema = z.enum(["start","send_email","delay","condition","tag","remove","end"]);

const BlockInputSchema = z.object({
  block_type: BlockTypeSchema,
  template_ids: z.array(dbUuid()).default([]),
  sender_id: dbUuid().nullable().optional(),
  smtp_config_id: dbUuid().nullable().optional(),
  subject_override: z.string().nullable().optional(),
  preheader_override: z.string().nullable().optional(),
  pre_delay_seconds: z.number().int().min(0).max(86400 * 30).default(0),
  delay_seconds: z.number().int().min(0).max(86400 * 30).default(0),
  condition_type: z.string().nullable().optional(),
  condition_value: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  send_at_hour: z.number().int().min(0).max(23).nullable().optional(),
  send_at_minute: z.number().int().min(0).max(59).default(0),
  skip_if_past: z.boolean().default(false),
});

const ExitConditionsSchema = z.object({
  login: z.boolean().default(false),
  deposit: z.boolean().default(false),
  first_deposit: z.boolean().default(false),
  bet: z.boolean().default(false),
  reply: z.boolean().default(false),
  human_takeover: z.boolean().default(false),
  became_vip: z.boolean().default(false),
  left_risk_group: z.boolean().default(false),
  manual: z.boolean().default(false),
});

// ---------- LIST ----------
export const listEmailFlows = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("email_flows")
      .select("id, name, trigger_type, active, daily_limit, cooldown_hours, exit_conditions, stats, activated_at, last_run_at, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    // Conta blocos e leads ativos por fluxo
    const ids = (data ?? []).map((f) => f.id);
    let counts: Record<string, { blocks: number; active_leads: number }> = {};
    if (ids.length > 0) {
      const { data: blocks } = await context.supabase
        .from("email_flow_blocks")
        .select("flow_id")
        .in("flow_id", ids);
      const { data: leads } = await context.supabase
        .from("email_flow_leads")
        .select("flow_id, status")
        .in("flow_id", ids);
      counts = ids.reduce<typeof counts>((acc, id) => {
        acc[id] = {
          blocks: (blocks ?? []).filter((b) => b.flow_id === id).length,
          active_leads: (leads ?? []).filter((l) => l.flow_id === id && (l.status === "pending" || l.status === "running")).length,
        };
        return acc;
      }, {});
    }
    return { flows: (data ?? []).map((f) => ({ ...f, counts: counts[f.id] ?? { blocks: 0, active_leads: 0 } })) };
  });

// ---------- GET ----------
export const getEmailFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const [{ data: flow, error: fErr }, { data: blocks, error: bErr }] = await Promise.all([
      context.supabase.from("email_flows").select("*").eq("id", data.id).maybeSingle(),
      context.supabase.from("email_flow_blocks").select("*").eq("flow_id", data.id).order("order_index", { ascending: true }),
    ]);
    if (fErr) throw new Error(fErr.message);
    if (bErr) throw new Error(bErr.message);
    return { flow, blocks: blocks ?? [] };
  });

// ---------- SAVE ----------
export const saveEmailFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: dbUuid().optional(),
      name: z.string().min(1).max(120),
      trigger_type: TriggerSchema,
      active: z.boolean(),
      daily_limit: z.number().int().min(1).max(10_000_000).optional().default(999999),
      cooldown_hours: z.number().int().min(0).max(8760),
      exit_conditions: ExitConditionsSchema,
      blocks: z.array(BlockInputSchema).min(1).max(60),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Valida: ativo so com >=1 send_email com template
    const hasSend = data.blocks.some((b) => b.block_type === "send_email" && b.template_ids.length > 0);
    if (data.active && !hasSend) {
      throw new Error("Para ativar o fluxo, é necessário pelo menos um bloco de envio com template selecionado.");
    }

    let flowId = data.id;
    const payload = {
      name: data.name,
      trigger_type: data.trigger_type,
      active: data.active,
      daily_limit: data.daily_limit,
      cooldown_hours: data.cooldown_hours,
      exit_conditions: data.exit_conditions as never,
    };
    if (flowId) {
      const { error } = await context.supabase.from("email_flows").update(payload).eq("id", flowId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await context.supabase.from("email_flows").insert(payload).select("id").single();
      if (error) throw new Error(error.message);
      flowId = created.id;
    }

    // Substitui blocos
    await context.supabase.from("email_flow_blocks").delete().eq("flow_id", flowId);
    const rows = data.blocks.map((b, i) => ({
      flow_id: flowId!,
      order_index: i,
      block_type: b.block_type,
      template_ids: b.template_ids,
      sender_id: b.sender_id ?? null,
      smtp_config_id: b.smtp_config_id ?? null,
      subject_override: b.subject_override ?? null,
      preheader_override: b.preheader_override ?? null,
      pre_delay_seconds: b.pre_delay_seconds,
      delay_seconds: b.delay_seconds,
      condition_type: b.condition_type ?? null,
      condition_value: b.condition_value ?? null,
      label: b.label ?? null,
      send_at_hour: b.send_at_hour ?? null,
      send_at_minute: b.send_at_minute ?? 0,
      skip_if_past: b.skip_if_past ?? false,
    }));
    if (rows.length > 0) {
      const { error } = await context.supabase.from("email_flow_blocks").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { id: flowId };
  });

// ---------- TOGGLE / DELETE / DUPLICATE ----------
export const toggleEmailFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const patch: { active: boolean; activated_at?: string } = { active: data.active };
    if (data.active) patch.activated_at = new Date().toISOString();
    const { error } = await context.supabase.from("email_flows").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteEmailFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("email_flows").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateEmailFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: dbUuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: flow } = await context.supabase.from("email_flows").select("*").eq("id", data.id).maybeSingle();
    if (!flow) throw new Error("Fluxo não encontrado");
    const { data: blocks } = await context.supabase.from("email_flow_blocks").select("*").eq("flow_id", data.id).order("order_index");
    const { data: created, error } = await context.supabase
      .from("email_flows")
      .insert({
        name: `${flow.name} (cópia)`,
        trigger_type: flow.trigger_type,
        active: false,
        daily_limit: flow.daily_limit,
        cooldown_hours: flow.cooldown_hours,
        exit_conditions: flow.exit_conditions,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if ((blocks ?? []).length > 0) {
      await context.supabase.from("email_flow_blocks").insert(
        (blocks ?? []).map((b, i) => ({
          flow_id: created.id,
          order_index: i,
          block_type: b.block_type,
          template_ids: b.template_ids,
          sender_id: b.sender_id,
          smtp_config_id: b.smtp_config_id,
          subject_override: b.subject_override,
          preheader_override: b.preheader_override,
          pre_delay_seconds: b.pre_delay_seconds,
          delay_seconds: b.delay_seconds,
          condition_type: b.condition_type,
          condition_value: b.condition_value,
          label: b.label,
          send_at_hour: b.send_at_hour,
          send_at_minute: b.send_at_minute,
          skip_if_past: b.skip_if_past,
        })),
      );
    }
    return { id: created.id };
  });

// ---------- HISTORY / LOGS ----------
export const listEmailFlowLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ flow_id: dbUuid().optional(), limit: z.number().int().min(1).max(200).default(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("email_flow_leads")
      .select("id, flow_id, player_id, email, status, current_block_index, next_run_at, entered_at, last_sent_at, last_template_id, exit_reason")
      .order("entered_at", { ascending: false })
      .limit(data.limit);
    if (data.flow_id) q = q.eq("flow_id", data.flow_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { leads: rows ?? [] };
  });

export const listEmailFlowLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ flow_id: dbUuid().optional(), limit: z.number().int().min(1).max(500).default(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("email_flow_logs")
      .select("id, flow_id, flow_lead_id, player_id, event, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.flow_id) q = q.eq("flow_id", data.flow_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { logs: rows ?? [] };
  });

// ---------- TRIGGER TEST ----------
export const triggerEmailFlowTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ flow_id: dbUuid(), player_id: dbUuid().optional(), email: z.string().email().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { data: flow } = await supabaseAdmin
      .from("email_flows")
      .select("id, active")
      .eq("id", data.flow_id)
      .maybeSingle();
    if (!flow) throw new Error("Fluxo não encontrado");

    let email = data.email ?? null;
    let player_id = data.player_id ?? null;
    if (player_id && !email) {
      const { data: p } = await supabaseAdmin.from("players").select("email").eq("id", player_id).maybeSingle();
      email = p?.email ?? null;
    }
    if (!email) throw new Error("Informe um player com email ou um email direto");

    const { data: inserted, error } = await supabaseAdmin
      .from("email_flow_leads")
      .insert({
        flow_id: data.flow_id,
        player_id,
        email,
        status: "running",
        current_block_index: 0,
        next_run_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !inserted) throw new Error(error?.message ?? "Falha ao injetar lead");

    await supabaseAdmin.from("email_flow_logs").insert({
      flow_id: data.flow_id,
      flow_lead_id: inserted.id,
      player_id,
      event: "enqueued_test",
      detail: { manual: true } as never,
    });

    const result = await runEmailFlowDispatcher({ onlyLeadId: inserted.id });
    return { flow_lead_id: inserted.id, dispatcher: result };
  });

// ---------- DISPATCH MANUAL ----------
export const runEmailFlowsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => runEmailFlowDispatcher({ limit: 30 }));