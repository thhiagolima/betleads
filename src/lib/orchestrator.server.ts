// Orquestrador unificado: detecta o estado de cada lead, escolhe o gatilho de
// maior prioridade e enfileira em SMS/Email/Ligação respeitando regras de
// segurança (prioridade cross-channel, cooldown, limite diário, contato válido,
// duplicidade, exit conditions). Modo "simulate" não escreve nada.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectTriggersForPlayer, type TriggerType } from "./triggers.server";
import type { PlayerLike } from "./player-rules";
import { PRIORITY_ORDER, priorityRank, pickHighestPriority } from "./priorities";
import { TRIGGER_NAMES } from "./triggers";

type Mode = "simulate" | "execute";
type Channel = "sms" | "email" | "call" | "whatsapp";

interface ChannelFlow {
  channel: Channel;
  flow_id: string;
  trigger: TriggerType;
}

interface Totals {
  analyzed: number;
  eligible: number;
  enqueued: number;
  skipped: number;
  by_trigger: Record<string, number>;
  by_channel: Record<Channel, number>;
  blocked_reasons: Record<string, number>;
}

function emptyTotals(): Totals {
  return {
    analyzed: 0,
    eligible: 0,
    enqueued: 0,
    skipped: 0,
    by_trigger: {},
    by_channel: { sms: 0, email: 0, call: 0, whatsapp: 0 },
    blocked_reasons: {},
  };
}

function inc(map: Record<string, number>, key: string, n = 1) {
  map[key] = (map[key] ?? 0) + n;
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  return d.length >= 10 ? d : null;
}

function isEmail(v: string | null | undefined): v is string {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// Agregados em lote: faz 2 queries (deposits + sessions) cobrindo TODOS os
// player_ids do lote e agrega em memória. Reduz de ~2N queries para 2 queries
// por lote (era a causa dos runs zumbis travados em "running").
async function getPlayerAggregatesBatch(
  playerIds: string[],
): Promise<Map<string, Partial<PlayerLike>>> {
  const out = new Map<string, Partial<PlayerLike>>();
  if (!playerIds.length) return out;
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
  const [{ data: deps }, { data: sess }] = await Promise.all([
    supabaseAdmin
      .from("deposits")
      .select("player_id, valor, created_at, status")
      .in("player_id", playerIds)
      .gte("created_at", sixtyDaysAgo)
      .eq("status", "aprovado"),
    supabaseAdmin
      .from("sessions")
      .select("player_id, iniciado_em")
      .in("player_id", playerIds)
      .gte("iniciado_em", sixtyDaysAgo),
  ]);
  const depsByPlayer = new Map<string, Array<{ valor: number; created_at: string }>>();
  for (const d of deps ?? []) {
    if (!d.player_id) continue;
    const arr = depsByPlayer.get(d.player_id) ?? [];
    arr.push({ valor: Number(d.valor), created_at: d.created_at });
    depsByPlayer.set(d.player_id, arr);
  }
  const sessByPlayer = new Map<string, string[]>();
  for (const s of sess ?? []) {
    if (!s.player_id) continue;
    const arr = sessByPlayer.get(s.player_id) ?? [];
    arr.push(s.iniciado_em);
    sessByPlayer.set(s.player_id, arr);
  }
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  for (const id of playerIds) {
    const pdeps = depsByPlayer.get(id) ?? [];
    const psess = sessByPlayer.get(id) ?? [];
    const dep30 = pdeps.filter((d) => new Date(d.created_at).getTime() >= cutoff30).reduce((a, d) => a + d.valor, 0);
    const dep30_60 = pdeps.filter((d) => new Date(d.created_at).getTime() < cutoff30).reduce((a, d) => a + d.valor, 0);
    const qtd_logins_30d = psess.filter((s) => new Date(s).getTime() >= cutoff30).length;
    const qtd_logins_30_60d = psess.filter((s) => new Date(s).getTime() < cutoff30).length;
    const dayKeys = new Set(pdeps.map((d) => new Date(d.created_at).toISOString().slice(0, 10)));
    let seq = 0;
    for (let i = 0; i < 60; i++) {
      const k = new Date(now - i * 86400000).toISOString().slice(0, 10);
      if (dayKeys.has(k)) seq++;
      else if (i > 0) break;
    }
    const media = pdeps.length > 0 ? pdeps.reduce((a, d) => a + d.valor, 0) / pdeps.length : 0;
    out.set(id, {
      dep_30d: dep30,
      dep_30_60d: dep30_60,
      qtd_logins_30d,
      qtd_logins_30_60d,
      dias_seguidos_depositando: seq,
      media_deposito: media,
    });
  }
  return out;
}

async function loadActiveFlows(tenantId: string): Promise<ChannelFlow[]> {
  const out: ChannelFlow[] = [];
  const [wa, sms, email, calls] = await Promise.all([
    supabaseAdmin.from("flows").select("id, trigger_type").eq("active", true).eq("tenant_id", tenantId).not("trigger_type", "is", null),
    supabaseAdmin.from("sms_flows").select("id, trigger_name").eq("is_active", true).eq("tenant_id", tenantId).not("trigger_name", "is", null),
    supabaseAdmin.from("email_flows").select("id, trigger_type").eq("active", true).eq("tenant_id", tenantId),
    supabaseAdmin.from("call_flows").select("id, trigger_name").eq("is_active", true).eq("tenant_id", tenantId).not("trigger_name", "is", null),
  ]);
  for (const f of wa.data ?? []) out.push({ channel: "whatsapp", flow_id: f.id, trigger: f.trigger_type as TriggerType });
  for (const f of sms.data ?? []) out.push({ channel: "sms", flow_id: f.id, trigger: f.trigger_name as TriggerType });
  for (const f of email.data ?? []) out.push({ channel: "email", flow_id: f.id, trigger: f.trigger_type as unknown as TriggerType });
  for (const f of calls.data ?? []) out.push({ channel: "call", flow_id: f.id, trigger: f.trigger_name as TriggerType });
  return out;
}

async function countSentToday(channel: Channel): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  if (channel === "sms") {
    const { count } = await supabaseAdmin
      .from("sms_flow_leads")
      .select("id", { count: "exact", head: true })
      .gte("entered_at", iso);
    return count ?? 0;
  }
  if (channel === "email") {
    const { count } = await supabaseAdmin
      .from("email_flow_leads")
      .select("id", { count: "exact", head: true })
      .gte("entered_at", iso);
    return count ?? 0;
  }
  if (channel === "call") {
    const { count } = await supabaseAdmin
      .from("call_flow_progress")
      .select("id", { count: "exact", head: true })
      .gte("started_at", iso);
    return count ?? 0;
  }
  const { count } = await supabaseAdmin
    .from("flow_leads")
    .select("id", { count: "exact", head: true })
    .gte("started_at", iso);
  return count ?? 0;
}

/** Verifica se o player já está em algum fluxo (qualquer canal) cujo gatilho
 * tem prioridade igual ou maior que `chosen`. */
async function hasHigherOrEqualPriorityActive(
  playerId: string,
  chosen: TriggerType,
  flowsByChannel: ChannelFlow[],
  tenantId: string,
): Promise<boolean> {
  const rank = priorityRank(chosen);
  // Fluxos cuja prioridade é <= chosen (ou seja, maior ou igual prioridade)
  const blockingByChannel: Record<Channel, string[]> = { sms: [], email: [], call: [], whatsapp: [] };
  for (const f of flowsByChannel) {
    if (priorityRank(f.trigger) <= rank && f.trigger !== chosen) {
      blockingByChannel[f.channel].push(f.flow_id);
    }
  }
  if (blockingByChannel.sms.length) {
    const r = await supabaseAdmin
      .from("sms_flow_leads")
      .select("id", { head: true, count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", blockingByChannel.sms)
      .in("status", ["pending", "running"]);
    if ((r.count ?? 0) > 0) return true;
  }
  if (blockingByChannel.email.length) {
    const r = await supabaseAdmin
      .from("email_flow_leads")
      .select("id", { head: true, count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", blockingByChannel.email)
      .in("status", ["pending", "running"]);
    if ((r.count ?? 0) > 0) return true;
  }
  if (blockingByChannel.call.length) {
    const r = await supabaseAdmin
      .from("call_flow_progress")
      .select("id", { head: true, count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", blockingByChannel.call)
      .eq("status", "active");
    if ((r.count ?? 0) > 0) return true;
  }
  if (blockingByChannel.whatsapp.length) {
    const r = await supabaseAdmin
      .from("flow_leads")
      .select("id", { head: true, count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", blockingByChannel.whatsapp)
      .in("status", ["pending", "running"]);
    if ((r.count ?? 0) > 0) return true;
  }
  return false;
}

async function alreadyEnrolled(channel: Channel, flowId: string, playerId: string, tenantId: string): Promise<boolean> {
  return await _alreadyEnrolledImpl(channel, flowId, playerId, tenantId);
}

/**
 * Pré-carrega, em apenas 4 queries (uma por canal), todas as inscrições ATIVAS
 * dos players do chunk. Substitui as ~8N queries que `hasHigherOrEqualPriorityActive`
 * + `alreadyEnrolled` faziam por player. Esse era o gargalo que estourava o
 * timeout do Worker em tenants com muitos players.
 *
 * Retorna um Map: player_id -> Set<`${channel}:${flow_id}`>
 */
async function loadActiveEnrollmentsBatch(
  playerIds: string[],
  tenantId: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!playerIds.length) return out;
  const add = (pid: string, key: string) => {
    const s = out.get(pid) ?? new Set<string>();
    s.add(key);
    out.set(pid, s);
  };
  const [sms, email, call, wa] = await Promise.all([
    supabaseAdmin
      .from("sms_flow_leads")
      .select("player_id, flow_id")
      .eq("tenant_id", tenantId)
      .in("player_id", playerIds)
      .in("status", ["pending", "running"]),
    supabaseAdmin
      .from("email_flow_leads")
      .select("player_id, flow_id")
      .eq("tenant_id", tenantId)
      .in("player_id", playerIds)
      .in("status", ["pending", "running"]),
    supabaseAdmin
      .from("call_flow_progress")
      .select("player_id, flow_id")
      .eq("tenant_id", tenantId)
      .in("player_id", playerIds)
      .eq("status", "active"),
    supabaseAdmin
      .from("flow_leads")
      .select("player_id, flow_id")
      .eq("tenant_id", tenantId)
      .in("player_id", playerIds)
      .in("status", ["pending", "running"]),
  ]);
  for (const r of sms.data ?? []) if (r.player_id && r.flow_id) add(r.player_id, `sms:${r.flow_id}`);
  for (const r of email.data ?? []) if (r.player_id && r.flow_id) add(r.player_id, `email:${r.flow_id}`);
  for (const r of call.data ?? []) if (r.player_id && r.flow_id) add(r.player_id, `call:${r.flow_id}`);
  for (const r of wa.data ?? []) if (r.player_id && r.flow_id) add(r.player_id, `whatsapp:${r.flow_id}`);
  return out;
}

/** Remove (marca exited/cancelled) inscrições ATIVAS do player em fluxos cuja
 *  prioridade é MENOR que `chosen`. Garante regra de prioridade exclusiva:
 *  um lead nunca permanece em fila de gatilho menor quando subiu pra maior. */
async function demoteLowerPriorityActive(
  playerId: string,
  chosen: TriggerType,
  flowsByChannel: ChannelFlow[],
  tenantId: string,
): Promise<number> {
  const rank = priorityRank(chosen);
  const lower: Record<Channel, string[]> = { sms: [], email: [], call: [], whatsapp: [] };
  for (const f of flowsByChannel) {
    if (priorityRank(f.trigger) > rank) lower[f.channel].push(f.flow_id);
  }
  const reason = `priority_upgrade:${chosen}`;
  const nowIso = new Date().toISOString();
  let demoted = 0;

  if (lower.sms.length) {
    const r = await supabaseAdmin
      .from("sms_flow_leads")
      .update({ status: "exited", exit_reason: reason, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", lower.sms)
      .in("status", ["pending", "running"])
      .select("id");
    demoted += r.data?.length ?? 0;
  }
  if (lower.email.length) {
    const r = await supabaseAdmin
      .from("email_flow_leads")
      .update({ status: "exited", exit_reason: reason, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", lower.email)
      .in("status", ["pending", "running"])
      .select("id");
    demoted += r.data?.length ?? 0;
  }
  if (lower.call.length) {
    const r = await supabaseAdmin
      .from("call_flow_progress")
      .update({ status: "cancelled", exit_reason: reason, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", lower.call)
      .eq("status", "active")
      .select("id");
    demoted += r.data?.length ?? 0;
  }
  if (lower.whatsapp.length) {
    const r = await supabaseAdmin
      .from("flow_leads")
      .update({ status: "exited", exit_reason: reason })
      .eq("tenant_id", tenantId)
      .eq("player_id", playerId)
      .in("flow_id", lower.whatsapp)
      .in("status", ["pending", "running"])
      .select("id");
    demoted += r.data?.length ?? 0;
  }
  return demoted;
}

async function _alreadyEnrolledImpl(channel: Channel, flowId: string, playerId: string, tenantId: string): Promise<boolean> {
  const table =
    channel === "sms"
      ? "sms_flow_leads"
      : channel === "email"
        ? "email_flow_leads"
        : channel === "call"
          ? "call_flow_progress"
          : "flow_leads";
  // Bloqueia apenas se há inscrição AINDA EM ANDAMENTO. Quando o fluxo
  // anterior já terminou (done/failed/exited), o lead pode re-entrar se
  // ainda bate no segmento.
  const activeStatuses: ("active" | "pending" | "running")[] =
    channel === "call" ? ["active"] : ["pending", "running"];
  const { count } = await supabaseAdmin
    .from(table)
    .select("id", { head: true, count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("flow_id", flowId)
    .eq("player_id", playerId)
    .in("status", activeStatuses);
  return (count ?? 0) > 0;
}

async function enroll(
  channel: Channel,
  flowId: string,
  player: { id: string; nome: string; telefone: string | null; email: string | null },
  phone: string | null,
  email: string | null,
  trigger: TriggerType,
  tenantId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (channel === "sms" && phone) {
      const { error } = await supabaseAdmin.from("sms_flow_leads").insert({
        tenant_id: tenantId,
        flow_id: flowId,
        player_id: player.id,
        phone_e164: phone,
        status: "pending",
        current_step_index: 0,
        next_run_at: new Date().toISOString(),
      });
      if (error) return { ok: false, error: error.message };
    } else if (channel === "email" && email) {
      const { error } = await supabaseAdmin.from("email_flow_leads").insert({
        tenant_id: tenantId,
        flow_id: flowId,
        player_id: player.id,
        email,
        status: "pending",
        current_block_index: 0,
        next_run_at: new Date().toISOString(),
      });
      if (error) return { ok: false, error: error.message };
    } else if (channel === "call" && phone) {
      const { error } = await supabaseAdmin.from("call_flow_progress").insert({
        tenant_id: tenantId,
        flow_id: flowId,
        player_id: player.id,
        phone_e164: phone,
        status: "active",
        current_block_index: 0,
        next_run_at: new Date().toISOString(),
      });
      if (error) return { ok: false, error: error.message };
    } else if (channel === "whatsapp" && phone) {
      const { data: inserted, error } = await supabaseAdmin
        .from("flow_leads")
        .insert({
          tenant_id: tenantId,
          flow_id: flowId,
          player_id: player.id,
          phone_e164: phone,
          status: "pending",
          current_block_index: 0,
          next_run_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flowId,
        flow_lead_id: inserted?.id ?? null,
        player_id: player.id,
        event: "enqueued",
        detail: { trigger, via: "orchestrator" },
      });
    } else {
      return { ok: false, error: "missing_contact" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface OrchestrateOptions {
  mode: Mode;
  limit?: number;
  tenantId: string;
}

export interface OrchestrateResult {
  run_id: string | null;
  totals: Totals;
  duration_ms: number;
}

export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const startedAt = Date.now();
  const { mode, tenantId } = opts;
  if (!tenantId) throw new Error("orchestrate: tenantId is required");
  // CRM EXPERT: a única entrada permitida é o gatilho `lead_cadastrado`,
  // que é enfileirado diretamente no webhook de cadastro. O orquestrador
  // por segmentos/alertas (sem login, cashback, VIP, etc.) NÃO roda nesses
  // tenants para evitar entradas automáticas indesejadas.
  {
    const { data: tenantRow } = await supabaseAdmin
      .from("tenants")
      .select("crm_model")
      .eq("id", tenantId)
      .maybeSingle();
    if ((tenantRow?.crm_model as string | null) === "CRM_EXPERT") {
      return { run_id: null, totals: emptyTotals(), duration_ms: 0 };
    }
  }
  // Cada tick processa no máximo CHUNK_SIZE players a partir de um cursor.
  // Chunk pequeno (40) garante que mesmo com queries lentas o ciclo termina
  // bem antes do hard-timeout do Worker (10min). O cursor avança a cada tick.
  const CHUNK_SIZE = opts.limit ?? 40;
  // Hard deadline interno (60s) — fecha o chunk muito antes do Worker matar.
  // Cron roda a cada 5min por tenant, então a base inteira é varrida em poucas horas
  // mesmo com chunk pequeno, sem nunca deixar run zumbi pra trás.
  const DEADLINE_MS = 60_000;
  const totals = emptyTotals();

  // Pause check (apenas em execute)
  if (mode === "execute") {
    const { data: settings } = await supabaseAdmin
      .from("automation_settings")
      .select("paused")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (settings?.paused) {
      return { run_id: null, totals, duration_ms: Date.now() - startedAt };
    }
  }

  // Cleanup de runs zumbis: só marca como erro runs `running` há mais de 12 min.
  // O Worker tem hard-limit de ~10min, então 12min garante que nunca matamos
  // por engano um run que ainda está rodando legitimamente.
  const zombieCutoff = new Date(Date.now() - 12 * 60_000).toISOString();
  await supabaseAdmin
    .from("activation_runs")
    .update({ status: "error", error: "timed_out", finished_at: new Date().toISOString() })
    .eq("status", "running")
    .eq("tenant_id", tenantId)
    .lt("started_at", zombieCutoff);

  // Lock anti-overlap (apenas em execute): se já há um run `running` dentro
  // da janela de tolerância (12 min), pula este tick.
  if (mode === "execute") {
    const { count: runningCount } = await supabaseAdmin
      .from("activation_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running")
      .eq("mode", "execute")
      .eq("tenant_id", tenantId)
      .gte("started_at", zombieCutoff);
    if ((runningCount ?? 0) > 0) {
      return { run_id: null, totals, duration_ms: Date.now() - startedAt };
    }
  }

  // Recupera o cursor (último player_id processado) do run anterior bem-sucedido.
  // Cursor é guardado em activation_runs.totals.cursor_after_id (jsonb).
  let cursorAfterId: string | null = null;
  if (mode === "execute") {
    const { data: lastDone } = await supabaseAdmin
      .from("activation_runs")
      .select("totals")
      .eq("mode", "execute")
      .eq("status", "done")
      .eq("tenant_id", tenantId)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const raw = (lastDone?.totals as Record<string, unknown> | null) ?? null;
    const c = raw?.["cursor_after_id"];
    if (typeof c === "string" && c.length > 0) cursorAfterId = c;
  }

  // Cria run row (mesmo em simulate)
  const { data: run } = await supabaseAdmin
    .from("activation_runs")
    .insert({ mode, status: "running", totals: totals as unknown as never, tenant_id: tenantId })
    .select("id")
    .maybeSingle();
  const runId = run?.id ?? null;

  try {
    const flows = await loadActiveFlows(tenantId);
    // Filtra fluxos de canais pausados individualmente (sms_paused, email_paused, ...).
    // Não pausa a orquestração inteira: só impede que canais pausados ganhem novos enrollments.
    const { data: chPause } = await supabaseAdmin
      .from("automation_settings")
      .select("sms_paused, email_paused, call_paused, whatsapp_paused")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    const pausedChannels = new Set<Channel>();
    if (chPause?.sms_paused) pausedChannels.add("sms");
    if (chPause?.email_paused) pausedChannels.add("email");
    if (chPause?.call_paused) pausedChannels.add("call");
    if (chPause?.whatsapp_paused) pausedChannels.add("whatsapp");
    const filteredFlows = flows.filter((f) => !pausedChannels.has(f.channel));
    if (!flows.length) {
      if (runId) {
        await supabaseAdmin
          .from("activation_runs")
          .update({ status: "done", totals: totals as unknown as never, finished_at: new Date().toISOString() })
          .eq("id", runId);
      }
      return { run_id: runId, totals, duration_ms: Date.now() - startedAt };
    }

    // Pega um chunk de até CHUNK_SIZE players, ordenado por id, começando
    // após o cursor salvo no run anterior. Se cursor é null, recomeça do zero.
    let query = supabaseAdmin
      .from("players")
      .select(
        "id, nome, telefone, email, status, vip, total_depositado, total_sacado, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, ftd_em, created_at, last_cashback_paid_at, last_cashback_amount, player_external_id",
      )
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .limit(CHUNK_SIZE);
    if (cursorAfterId) query = query.gt("id", cursorAfterId);
    const { data: players } = await query;

    let lastProcessedId: string | null = null;
    let deadlineHit = false;
    if (players && players.length > 0) {
      // Se a busca de agregados já estourou o deadline, fecha o run vazio
      // (cursor não avança) — assim o próximo tick tenta de novo sem zumbis.
      const playerIds = players.map((p) => p.id);
      const [aggregatesByPlayer, enrollmentsByPlayer] = await Promise.all([
        getPlayerAggregatesBatch(playerIds),
        loadActiveEnrollmentsBatch(playerIds, tenantId),
      ]);
      if (Date.now() - startedAt > DEADLINE_MS) {
        deadlineHit = true;
      }
      // Processa player-a-player respeitando o deadline interno.
      for (const p of players) {
        if (deadlineHit) break;
        if (Date.now() - startedAt > DEADLINE_MS) {
          deadlineHit = true;
          break;
        }
        await processPlayers([p], aggregatesByPlayer, enrollmentsByPlayer, filteredFlows, mode, totals, tenantId);
        lastProcessedId = p.id;
      }
    }

    // Decide novo cursor:
    // - se acabou a base nesta passagem (players < chunk e não bateu deadline) → reseta
    // - senão, salva o último id processado pra continuar no próximo tick
    const wrappedAround =
      !deadlineHit && (!players || players.length < CHUNK_SIZE);
    const nextCursor = wrappedAround ? null : lastProcessedId;
    (totals as unknown as Record<string, unknown>)["cursor_after_id"] = nextCursor;
    (totals as unknown as Record<string, unknown>)["chunk_size"] = CHUNK_SIZE;
    (totals as unknown as Record<string, unknown>)["wrapped"] = wrappedAround;

    if (runId) {
      await supabaseAdmin
        .from("activation_runs")
        .update({ status: "done", totals: totals as unknown as never, finished_at: new Date().toISOString() })
        .eq("id", runId);
    }
    return { run_id: runId, totals, duration_ms: Date.now() - startedAt };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await supabaseAdmin
        .from("activation_runs")
        .update({ status: "error", totals: totals as unknown as never, error: msg, finished_at: new Date().toISOString() })
        .eq("id", runId);
    }
    throw e;
  }
}

type PlayerRow = {
  id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  [k: string]: unknown;
};

async function processPlayers(
  players: PlayerRow[],
  aggregatesByPlayer: Map<string, Partial<PlayerLike>>,
  enrollmentsByPlayer: Map<string, Set<string>>,
  flows: ChannelFlow[],
  mode: Mode,
  totals: Totals,
  tenantId: string,
): Promise<void> {
  for (const p of players) {
    totals.analyzed++;
    const aggregates = aggregatesByPlayer.get(p.id) ?? {};
    const fullPlayer = { ...p, ...aggregates } as PlayerLike;
      const triggers = detectTriggersForPlayer(fullPlayer);
      if (!triggers.length) {
        inc(totals.blocked_reasons, "no_trigger");
        totals.skipped++;
        continue;
      }
      // Encontra o gatilho de maior prioridade que TEM fluxo ativo em algum canal
      const triggersWithFlow = triggers.filter((t) => flows.some((f) => f.trigger === t));
      const chosen = pickHighestPriority(triggersWithFlow);
      if (!chosen) {
        inc(totals.blocked_reasons, "no_active_flow_for_state");
        totals.skipped++;
        continue;
      }
      inc(totals.by_trigger, chosen);

      // Cross-channel: já está em fluxo de prioridade >=? (consulta em memória)
      const activeKeys = enrollmentsByPlayer.get(p.id) ?? new Set<string>();
      const chosenRank = priorityRank(chosen);
      const blocked = flows.some(
        (f) =>
          priorityRank(f.trigger) <= chosenRank &&
          f.trigger !== chosen &&
          activeKeys.has(`${f.channel}:${f.flow_id}`),
      );
      if (blocked) {
        inc(totals.blocked_reasons, "higher_priority_active");
        totals.skipped++;
        continue;
      }

      // Prioridade exclusiva: remove inscrições ativas em fluxos de prioridade
      // menor (cross-channel). Só faz em modo execute.
      if (mode === "execute") {
        const hasLowerActive = flows.some(
          (f) => priorityRank(f.trigger) > chosenRank && activeKeys.has(`${f.channel}:${f.flow_id}`),
        );
        if (hasLowerActive) {
          const demoted = await demoteLowerPriorityActive(p.id, chosen, flows, tenantId);
          if (demoted > 0) inc(totals.blocked_reasons, "demoted_from_lower_priority", demoted);
        }
      }

      const phone = normalizePhone(p.telefone);
      const email = isEmail(p.email) ? p.email : null;
      const flowsForChosen = flows.filter((f) => f.trigger === chosen);
      let anyEnqueued = false;

      for (const f of flowsForChosen) {
        // Contato válido
        if ((f.channel === "sms" || f.channel === "call" || f.channel === "whatsapp") && !phone) {
          inc(totals.blocked_reasons, "missing_phone");
          continue;
        }
        if (f.channel === "email" && !email) {
          inc(totals.blocked_reasons, "missing_email");
          continue;
        }
        // Já inscrito nesse fluxo? (consulta em memória)
        if (activeKeys.has(`${f.channel}:${f.flow_id}`)) {
          inc(totals.blocked_reasons, "already_enrolled");
          continue;
        }

        if (mode === "simulate") {
          inc(totals.by_channel, f.channel);
          totals.eligible++;
          anyEnqueued = true;
          continue;
        }

        const r = await enroll(
          f.channel,
          f.flow_id,
          { id: p.id, nome: p.nome, telefone: p.telefone, email: p.email },
          phone,
          email,
          chosen,
          tenantId,
        );
        if (r.ok) {
          inc(totals.by_channel, f.channel);
          totals.enqueued++;
          totals.eligible++;
          anyEnqueued = true;
          // Marca como inscrito no cache local para evitar dupla inscrição
          // dentro do mesmo chunk (improvável, mas safe).
          activeKeys.add(`${f.channel}:${f.flow_id}`);
          enrollmentsByPlayer.set(p.id, activeKeys);
        } else {
          inc(totals.blocked_reasons, `enroll_error_${f.channel}`);
        }
      }
      if (!anyEnqueued && mode === "simulate") {
        // já contado em blocked_reasons; nada a fazer
      }
  }
}

/** Resumo dos rótulos de gatilho para a UI. */
export const TRIGGER_LABELS = TRIGGER_NAMES;
export const PRIORITY_LIST = PRIORITY_ORDER;