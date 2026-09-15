// Server functions (RPC) para administrar regras, fluxos, blocos e histórico.
import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runDispatcher, evaluateAllPlayers } from "@/lib/automation.server";

const PrioritySchema = z.enum(["critico", "alto", "medio", "baixo"]);
const TriggerSchema = z.enum([
  "recuperacao_vip",
  "vip_esfriando",
  "receita_em_queda",
  "lead_quente_esfriando",
  "quase_vip",
  "alto_potencial",
  "reativacao_em_curso",
  "dinheiro_parado",
  "engajado_sem_converter",
  "frequencia_caindo",
  "cadastrados_sem_deposito",
  "sem_login_7_14",
  "sem_login_15_24",
  "sem_login_25_34",
  "sem_login_35_44",
  "sem_login_45_59",
  "sem_login_60_mais",
]);
const BlockTypeSchema = z.enum(["text", "image", "video", "audio", "document", "delay"]);

// ============================================================
// RULES
// ============================================================
export const listRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("rules")
      .select("id, trigger_type, name, meaning, priority, flow_id, active, last_run_at, last_match_count")
      .order("priority", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { rules: data ?? [] };
  });

export const updateRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid(),
        active: z.boolean().optional(),
        flow_id: dbUuid().nullable().optional(),
        priority: PrioritySchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: { active?: boolean; flow_id?: string | null; priority?: "critico" | "alto" | "medio" | "baixo" } = {};
    if (data.active !== undefined) patch.active = data.active;
    if (data.flow_id !== undefined) patch.flow_id = data.flow_id;
    if (data.priority !== undefined) patch.priority = data.priority;
    const { error } = await context.supabase.from("rules").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// FLOWS
// ============================================================
export const listFlows = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("flows")
      .select(
        "id, name, trigger_type, priority, active, delay_min_seconds, delay_max_seconds, cooldown_hours, daily_limit, hourly_limit, exit_conditions, stats, updated_at, activated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { flows: data ?? [] };
  });

export const getFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const [{ data: flow, error: fErr }, { data: templates, error: tErr }, { data: blocks, error: bErr }] = await Promise.all([
      context.supabase.from("flows").select("*").eq("id", data.id).maybeSingle(),
      context.supabase
        .from("flow_templates")
        .select("*")
        .eq("flow_id", data.id)
        .order("created_at", { ascending: true }),
      context.supabase
        .from("flow_blocks")
        .select("*")
        .eq("flow_id", data.id)
        .order("order_index", { ascending: true }),
    ]);
    if (fErr) throw new Error(fErr.message);
    if (tErr) throw new Error(tErr.message);
    if (bErr) throw new Error(bErr.message);
    const tplList = (templates ?? []).map((t) => ({
      ...t,
      blocks: (blocks ?? [])
        .filter((b) => b.flow_template_id === t.id)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)),
    }));
    return { flow, templates: tplList };
  });

const BlockInputSchema = z.object({
  id: dbUuid().optional(),
  block_type: BlockTypeSchema,
  content: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  media_mimetype: z.string().nullable().optional(),
  media_filename: z.string().nullable().optional(),
  delay_seconds: z.number().int().min(0).max(86400).default(0),
});

const TemplateInputSchema = z.object({
  id: dbUuid().optional(),
  name: z.string().min(1).max(120),
  is_active: z.boolean(),
  weight: z.number().int().min(1).max(100),
  blocks: z.array(BlockInputSchema).min(1).max(20),
});

export const saveFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid().optional(),
        name: z.string().min(1).max(120),
        trigger_type: TriggerSchema,
        priority: PrioritySchema,
        active: z.boolean(),
        delay_min_seconds: z.number().int().min(0).max(86400),
        delay_max_seconds: z.number().int().min(0).max(86400),
        cooldown_hours: z.number().int().min(0).max(720),
        daily_limit: z.number().int().min(1).max(10000),
        hourly_limit: z.number().int().min(1).max(1000),
        exit_conditions: z.object({
          login: z.boolean(),
          deposit: z.boolean(),
          first_deposit: z.boolean().default(false),
          bet: z.boolean(),
          whatsapp_reply: z.boolean(),
          human_takeover: z.boolean(),
        }),
        templates: z.array(TemplateInputSchema).min(1).max(20),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let flowId = data.id;
    if (flowId) {
      const { error } = await context.supabase
        .from("flows")
        .update({
          name: data.name,
          trigger_type: data.trigger_type,
          priority: data.priority,
          active: data.active,
          delay_min_seconds: data.delay_min_seconds,
          delay_max_seconds: data.delay_max_seconds,
          cooldown_hours: data.cooldown_hours,
          daily_limit: data.daily_limit,
          hourly_limit: data.hourly_limit,
          exit_conditions: data.exit_conditions,
        })
        .eq("id", flowId);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await context.supabase
        .from("flows")
        .insert({
          name: data.name,
          trigger_type: data.trigger_type,
          priority: data.priority,
          active: data.active,
          delay_min_seconds: data.delay_min_seconds,
          delay_max_seconds: data.delay_max_seconds,
          cooldown_hours: data.cooldown_hours,
          daily_limit: data.daily_limit,
          hourly_limit: data.hourly_limit,
          exit_conditions: data.exit_conditions,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      flowId = created.id;
    }

    // Substitui templates + blocos. Mais simples: apaga tudo e recria.
    await context.supabase.from("flow_blocks").delete().eq("flow_id", flowId);
    await context.supabase.from("flow_templates").delete().eq("flow_id", flowId);

    // Pré-gera IDs no servidor para mapear blocos sem round-trip extra.
    const templatesWithIds = data.templates.map((tpl) => ({
      ...tpl,
      _newId: crypto.randomUUID(),
    }));

    const templateRows = templatesWithIds.map((tpl) => ({
      id: tpl._newId,
      flow_id: flowId,
      name: tpl.name,
      is_active: tpl.is_active,
      weight: tpl.weight,
    }));

    const { error: tErr } = await context.supabase
      .from("flow_templates")
      .insert(templateRows);
    if (tErr) throw new Error(tErr.message);

    const blockRows = templatesWithIds.flatMap((tpl) =>
      tpl.blocks.map((b, i) => ({
        flow_id: flowId,
        flow_template_id: tpl._newId,
        order_index: i,
        block_type: b.block_type,
        content: b.content ?? null,
        caption: b.caption ?? null,
        media_url: b.media_url ?? null,
        media_mimetype: b.media_mimetype ?? null,
        media_filename: b.media_filename ?? null,
        delay_seconds: b.delay_seconds ?? 0,
      })),
    );

    if (blockRows.length > 0) {
      const { error: bErr } = await context.supabase
        .from("flow_blocks")
        .insert(blockRows);
      if (bErr) throw new Error(bErr.message);
    }

    return { id: flowId };
  });

export const deleteFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("flows").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid(), active: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("flows")
      .update({ active: data.active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: flow } = await context.supabase
      .from("flows")
      .select("*")
      .eq("id", data.id)
      .single();
    if (!flow) throw new Error("Fluxo não encontrado");
    const { data: tpls } = await context.supabase
      .from("flow_templates")
      .select("*")
      .eq("flow_id", data.id);
    const { data: blocks } = await context.supabase
      .from("flow_blocks")
      .select("*")
      .eq("flow_id", data.id)
      .order("order_index", { ascending: true });
    const { data: created, error } = await context.supabase
      .from("flows")
      .insert({
        name: `${flow.name} (cópia)`,
        trigger_type: flow.trigger_type,
        priority: flow.priority,
        active: false,
        delay_min_seconds: flow.delay_min_seconds,
        delay_max_seconds: flow.delay_max_seconds,
        cooldown_hours: flow.cooldown_hours,
        daily_limit: flow.daily_limit,
        hourly_limit: flow.hourly_limit,
        exit_conditions: flow.exit_conditions,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    for (const tpl of tpls ?? []) {
      const { data: newTpl } = await context.supabase
        .from("flow_templates")
        .insert({
          flow_id: created.id,
          name: tpl.name,
          is_active: tpl.is_active,
          weight: tpl.weight,
        })
        .select("id")
        .single();
      if (!newTpl) continue;
      const tplBlocks = (blocks ?? [])
        .filter((b) => b.flow_template_id === tpl.id)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
      if (tplBlocks.length > 0) {
        await context.supabase.from("flow_blocks").insert(
          tplBlocks.map((b, i) => ({
            flow_id: created.id,
            flow_template_id: newTpl.id,
            order_index: i,
            block_type: b.block_type,
            content: b.content,
            caption: b.caption,
            media_url: b.media_url,
            media_mimetype: b.media_mimetype,
            media_filename: b.media_filename,
            delay_seconds: b.delay_seconds,
          })),
        );
      }
    }
    return { id: created.id };
  });

// ============================================================
// HISTÓRICO / TESTE
// ============================================================
export const listFlowHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        flow_id: dbUuid().optional(),
        trigger_type: TriggerSchema.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("flow_logs")
      .select("id, event, detail, created_at, flow_id, flow_lead_id, player_id")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.flow_id) q = q.eq("flow_id", data.flow_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { logs: rows ?? [] };
  });

export const testRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ trigger_type: TriggerSchema }).parse(input))
  .handler(async ({ data, context }) => {
    // Conta quantos players ativos casam com o gatilho — usa lead_alerts recentes como proxy rápido.
    const { count } = await context.supabase
      .from("lead_alerts")
      .select("*", { count: "exact", head: true })
      .eq("trigger_type", data.trigger_type)
      .gte("fired_at", new Date(Date.now() - 7 * 86400000).toISOString());
    return { matches_last_7d: count ?? 0 };
  });

// ============================================================
// DISPARAR TESTE — injeta um flow_lead e roda o dispatcher na hora
// ============================================================
export const triggerFlowTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        flow_id: dbUuid(),
        player_id: dbUuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // 1. Valida fluxo
    const { data: flow } = await supabaseAdmin
      .from("flows")
      .select("id, name, active")
      .eq("id", data.flow_id)
      .maybeSingle();
    if (!flow) throw new Error("Fluxo não encontrado");
    if (!flow.active) throw new Error("Fluxo está pausado — ative antes de testar");

    // 2. Valida template ativo com blocos
    const { data: tpls } = await supabaseAdmin
      .from("flow_templates")
      .select("id, is_active")
      .eq("flow_id", data.flow_id)
      .eq("is_active", true);
    if (!tpls || tpls.length === 0) throw new Error("Fluxo não tem nenhum template ativo");
    const tplIds = tpls.map((t) => t.id);
    const { count: blockCount } = await supabaseAdmin
      .from("flow_blocks")
      .select("id", { count: "exact", head: true })
      .in("flow_template_id", tplIds);
    if (!blockCount || blockCount === 0) throw new Error("Nenhum template do fluxo tem blocos");

    // 3. Valida player
    const { data: player } = await supabaseAdmin
      .from("players")
      .select("id, nome, telefone")
      .eq("id", data.player_id)
      .maybeSingle();
    if (!player) throw new Error("Player não encontrado");
    const digits = (player.telefone ?? "").replace(/\D/g, "");
    if (digits.length < 8) throw new Error("Player não tem telefone válido");

    // 4. Dedupe
    const { data: existing } = await supabaseAdmin
      .from("flow_leads")
      .select("id, status")
      .eq("flow_id", data.flow_id)
      .eq("player_id", data.player_id)
      .limit(1)
      .maybeSingle();
    if (existing) {
      throw new Error(
        `Esse player já entrou neste fluxo (status: ${existing.status}). Cada player só entra uma vez por fluxo.`,
      );
    }

    // 5. Garante sessão WhatsApp conectada
    const { data: connected } = await supabaseAdmin
      .from("whatsapp_sessions")
      .select("id")
      .eq("status", "connected")
      .eq("is_active", true)
      .limit(1);
    if (!connected || connected.length === 0) {
      throw new Error("Nenhuma sessão WhatsApp conectada — conecte uma sessão antes de testar");
    }

    // 6. Insere flow_lead pronto pra agora
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("flow_leads")
      .insert({
        flow_id: data.flow_id,
        player_id: data.player_id,
        phone_e164: digits,
        status: "pending",
        current_block_index: 0,
        next_run_at: nowIso,
      })
      .select("id")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message ?? "Falha ao criar flow_lead");

    await supabaseAdmin.from("flow_logs").insert({
      flow_id: data.flow_id,
      flow_lead_id: inserted.id,
      player_id: data.player_id,
      event: "enqueued_test",
      detail: { manual: true, next_run_at: nowIso },
    });

    // 7. Roda dispatcher só pra esse lead, ignorando janela operacional
    const result = await runDispatcher({
      limit: 1,
      bypassWindow: true,
      onlyLeadId: inserted.id,
    });

    return {
      flow_lead_id: inserted.id,
      dispatcher: result,
      to: digits,
    };
  });

// ============================================================
// EXECUTAR EVALUATE/DISPATCH MANUALMENTE (botão no banner)
// ============================================================
export const runEvaluateAndDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const evalRes = await evaluateAllPlayers({ limit: 500 });
    const dispRes = await runDispatcher({ limit: 30, bypassWindow: true });
    return { evaluate: evalRes, dispatch: dispRes };
  });

// ============================================================
// MEDIA UPLOAD (assinado) — usado pelo editor de blocos
// ============================================================
export const createMediaUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ filename: z.string().min(1).max(200), mimetype: z.string().min(1).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const safe = data.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `flows/${Date.now()}-${safe}`;
    const { data: signed, error } = await context.supabase.storage
      .from("whatsapp-media")
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { path, token: signed.token, signedUrl: signed.signedUrl };
  });

// ============================================================
// ANTI-BAN (teto global do dispatcher)
// ============================================================
const TimeStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Formato HH:MM");

const AntibanInputSchema = z.object({
  delay_min_seconds: z.number().int().min(0).max(86400),
  delay_max_seconds: z.number().int().min(0).max(86400),
  hourly_limit: z.number().int().min(1).max(1000),
  daily_limit: z.number().int().min(1).max(10000),
  cooldown_hours: z.number().int().min(0).max(720),
  window_start: TimeStr,
  window_end: TimeStr,
  randomization_enabled: z.boolean(),
  smart_suppression_enabled: z.boolean(),
  auto_pause_enabled: z.boolean(),
  warmup_enabled: z.boolean(),
  warmup_initial_daily: z.number().int().min(1).max(10000),
  warmup_days: z.number().int().min(1).max(60),
});

export const getAntibanSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("antiban_settings")
      .select(
        "id, delay_min_seconds, delay_max_seconds, hourly_limit, daily_limit, cooldown_hours, window_start, window_end, randomization_enabled, smart_suppression_enabled, auto_pause_enabled, warmup_enabled, warmup_initial_daily, warmup_days, updated_at",
      )
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { settings: data };
  });

export const saveAntibanSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => AntibanInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    // Garante linha singleton: tenta update, se nenhuma linha alterada faz insert.
    const { data: existing } = await context.supabase
      .from("antiban_settings")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (existing) {
      const { error } = await context.supabase
        .from("antiban_settings")
        .update(data)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("antiban_settings")
        .insert({ ...data, singleton: true });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });
