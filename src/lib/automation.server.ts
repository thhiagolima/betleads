// Motor de automação: detecta gatilhos, enfileira leads em fluxos, despacha
// blocos respeitando anti-ban, cooldown e condições de saída.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectTriggersForPlayer, type TriggerType } from "./triggers.server";
import { sendFlowBlock, type FlowBlock, type SessionRow } from "./whatsapp-send.server";
import type { PlayerLike } from "./player-rules";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { pickHighestPriority, priorityRank } from "./priorities";
import {
  getAntibanSettings,
  applyAntibanCaps,
  isWithinOperationalWindow,
  nextWindowStart,
  type AntibanSettings,
} from "./antiban.server";
import {
  loadActiveIntegrations,
  pickExternalTrigger,
  sendExternalTriggerEvent,
} from "./whatsapp-external.server";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  return d.length >= 8 ? d : null;
}

function randomBetween(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function getPlayerAggregates(playerId: string): Promise<Partial<PlayerLike>> {
  // Agregados leves para detectar gatilhos sem queries pesadas por player.
  // Para evaluate em massa otimizamos depois — aqui é OK por enquanto.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
  const [{ data: deps }, { data: sess }] = await Promise.all([
    supabaseAdmin
      .from("deposits")
      .select("valor, created_at, status")
      .eq("player_id", playerId)
      .gte("created_at", sixtyDaysAgo)
      .eq("status", "aprovado"),
    supabaseAdmin
      .from("sessions")
      .select("iniciado_em")
      .eq("player_id", playerId)
      .gte("iniciado_em", sixtyDaysAgo),
  ]);

  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const dep30 = (deps ?? [])
    .filter((d) => new Date(d.created_at).getTime() >= cutoff30)
    .reduce((a, d) => a + Number(d.valor), 0);
  const dep30_60 = (deps ?? [])
    .filter((d) => new Date(d.created_at).getTime() < cutoff30)
    .reduce((a, d) => a + Number(d.valor), 0);
  const qtd_logins_30d = (sess ?? []).filter(
    (s) => new Date(s.iniciado_em).getTime() >= cutoff30,
  ).length;
  const qtd_logins_30_60d = (sess ?? []).filter(
    (s) => new Date(s.iniciado_em).getTime() < cutoff30,
  ).length;

  // dias seguidos depositando (conta dias únicos consecutivos terminando hoje)
  const dayKeys = new Set(
    (deps ?? []).map((d) => new Date(d.created_at).toISOString().slice(0, 10)),
  );
  let seq = 0;
  for (let i = 0; i < 60; i++) {
    const k = new Date(now - i * 86400000).toISOString().slice(0, 10);
    if (dayKeys.has(k)) seq++;
    else if (i > 0) break;
  }

  const media =
    (deps ?? []).length > 0
      ? (deps ?? []).reduce((a, d) => a + Number(d.valor), 0) / (deps ?? []).length
      : 0;

  return {
    dep_30d: dep30,
    dep_30_60d: dep30_60,
    qtd_logins_30d,
    qtd_logins_30_60d,
    dias_seguidos_depositando: seq,
    media_deposito: media,
  };
}

async function pickBestSession(): Promise<{ id: string; name: string } | null> {
  const { data } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id, name, instance_name, status, messages_sent_today, daily_limit, is_active")
    .eq("status", "connected")
    .eq("is_active", true)
    .order("messages_sent_today", { ascending: true, nullsFirst: true });
  const candidate = (data ?? []).find(
    (s) => (s.messages_sent_today ?? 0) < (s.daily_limit ?? 999999),
  );
  return candidate ? { id: candidate.id, name: candidate.name } : null;
}

async function getOrAssignSession(phone: string, playerId: string | null) {
  const { data: existing } = await supabaseAdmin
    .from("lead_whatsapp_assignments")
    .select("id, session_id, status, previous_session_ids")
    .eq("phone_e164", phone)
    .maybeSingle();

  if (existing && existing.status === "active") {
    const { data: sess } = await supabaseAdmin
      .from("whatsapp_sessions")
      .select("id, name, instance_name, status, is_active")
      .eq("id", existing.session_id)
      .maybeSingle();
    if (sess && sess.status === "connected" && sess.is_active) {
      return sess as SessionRow;
    }
  }

  const best = await pickBestSession();
  if (!best) return null;
  const { data: bestFull } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id, name, instance_name, status")
    .eq("id", best.id)
    .single();

  if (existing) {
    const prev = Array.isArray(existing.previous_session_ids)
      ? (existing.previous_session_ids as string[])
      : [];
    if (!prev.includes(existing.session_id)) prev.push(existing.session_id);
    await supabaseAdmin
      .from("lead_whatsapp_assignments")
      .update({ session_id: best.id, previous_session_ids: prev, status: "active", player_id: playerId })
      .eq("id", existing.id);
  } else {
    await supabaseAdmin
      .from("lead_whatsapp_assignments")
      .insert({ phone_e164: phone, session_id: best.id, status: "active", player_id: playerId });
  }
  return bestFull as SessionRow;
}

// ---------------------------------------------------------------
// EVALUATE — identifica leads que entram em fluxos
// ---------------------------------------------------------------
export async function evaluateAllPlayers(opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 500;

  // Contas que terceirizaram o WhatsApp: o gatilho vai para o webhook externo
  // em vez de entrar nos fluxos internos.
  const externalIntegrations = await loadActiveIntegrations();

  // Fonte da verdade do motor: a tabela `flows` (o que o usuário enxerga/edita
  // na tela "Fluxos"). Cada flow tem seu próprio trigger_type — não dependemos
  // mais da tabela `rules` para vincular gatilho → fluxo.
  const { data: activeFlows } = await supabaseAdmin
    .from("flows")
    .select(
      "id, name, active, delay_min_seconds, delay_max_seconds, cooldown_hours, trigger_type, activated_at",
    )
    .eq("active", true)
    .not("trigger_type", "is", null);

  if ((!activeFlows || activeFlows.length === 0) && externalIntegrations.size === 0) {
    return { evaluated: 0, enqueued: 0, reason: "no-active-flows" };
  }

  // Players candidatos: ativos com telefone
  const { data: players } = await supabaseAdmin
    .from("players")
    .select(
      "id, tenant_id, nome, telefone, email, vip, total_depositado, total_sacado, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, ftd_em, created_at, last_cashback_paid_at, last_cashback_amount, player_external_id",
    )
    .eq("status", "ativo")
    .not("telefone", "is", null)
    .limit(limit);

  let enqueued = 0;
  let forwarded = 0;
  for (const p of players ?? []) {
    const phone = normalizePhone(p.telefone);
    if (!phone) continue;
    const aggregates = await getPlayerAggregates(p.id);
    const fullPlayer = { ...p, ...aggregates } as PlayerLike;
    const triggers = detectTriggersForPlayer(fullPlayer);
    if (triggers.length === 0) continue;

    // --- WhatsApp terceirizado ------------------------------------------
    const integration = externalIntegrations.get((p as any).tenant_id);
    if (integration) {
      const externalTrigger = pickExternalTrigger(triggers, integration);
      if (externalTrigger) {
        const res = await sendExternalTriggerEvent({
          integration,
          trigger: externalTrigger,
          lead: {
            id: p.id,
            player_external_id: (p as any).player_external_id ?? null,
            nome: p.nome,
            telefone: phone,
            email: (p as any).email ?? null,
            vip: p.vip,
            total_depositado: p.total_depositado,
            total_sacado: p.total_sacado,
            saldo_carteira: p.saldo_carteira,
            media_deposito: aggregates.media_deposito ?? 0,
            dep_30d: aggregates.dep_30d ?? 0,
            qtd_logins_30d: aggregates.qtd_logins_30d ?? 0,
            ultimo_login: p.ultimo_login,
            ultimo_deposito: (p as any).ultimo_deposito ?? null,
            ultimo_jogo: (p as any).ultimo_jogo ?? null,
            ftd_em: p.ftd_em,
            created_at: p.created_at,
          },
        });
        if (res.sent) forwarded++;
      }
      // Enquanto o WhatsApp estiver terceirizado, não enfileira internamente.
      if (integration.disable_internal) continue;
    }

    if (!activeFlows || activeFlows.length === 0) continue;

    // Prioridade: cada player só entra no fluxo do gatilho de MAIOR
    // prioridade que ele dispara. Antes, o loop enfileirava o mesmo player
    // em fluxos de gatilhos diferentes no mesmo tick — causa de duplas
    // mensagens de abertura no WhatsApp.
    const triggersWithFlow = triggers.filter((t) =>
      activeFlows.some((f) => f.trigger_type === t),
    );
    const chosen = pickHighestPriority(triggersWithFlow);
    if (!chosen) continue;
    const chosenRank = priorityRank(chosen);
    const lowerPriorityTriggers = new Set(
      (activeFlows
        .map((f) => f.trigger_type as TriggerType)
        .filter((t) => priorityRank(t) <= chosenRank && t !== chosen)),
    );

    // Guarda cross-trigger no próprio WhatsApp: se já existe flow_lead
    // ativo desse player em um fluxo de prioridade >= ao chosen, pula.
    if (lowerPriorityTriggers.size > 0) {
      const blockingFlowIds = activeFlows
        .filter((f) => lowerPriorityTriggers.has(f.trigger_type as TriggerType))
        .map((f) => f.id);
      if (blockingFlowIds.length > 0) {
        const { count: blockedCount } = await supabaseAdmin
          .from("flow_leads")
          .select("id", { head: true, count: "exact" })
          .eq("player_id", p.id)
          .in("flow_id", blockingFlowIds)
          .in("status", ["pending", "running"]);
        if ((blockedCount ?? 0) > 0) {
          await supabaseAdmin.from("flow_logs").insert({
            flow_id: null,
            player_id: p.id,
            event: "skipped_lower_priority",
            detail: { chosen, blocking_flow_ids: blockingFlowIds },
          });
          continue;
        }
      }
    }

    for (const flow of activeFlows) {
      if (flow.trigger_type !== chosen) continue;

      // Regra de "lead morto": cada fluxo é uma campanha sequencial; um player só
      // entra UMA VEZ por fluxo. Se já existe qualquer flow_lead (em andamento,
      // completado, exitado ou falho) para este (flow_id, player_id), nunca
      // re-inscreve — converteu = saiu via exit_conditions; não converteu = lead
      // perdido para esse fluxo.
      const { data: existing } = await supabaseAdmin
        .from("flow_leads")
        .select("id")
        .eq("flow_id", flow.id)
        .eq("player_id", p.id)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      // Grace period de 48h após ativação: para proteger o WhatsApp de uma
      // enxurrada inicial, só novos eventos (atividade posterior ao
      // activated_at) disparam nas primeiras 48h. Passado esse prazo, o
      // backlog entra normalmente, gotejado pelos limites do antiban.
      if (flow.activated_at) {
        const activatedAt = new Date(flow.activated_at).getTime();
        const graceExpiresAt = activatedAt + 48 * 60 * 60 * 1000;
        const activityCandidates = [
          p.ultimo_login,
          p.ultimo_jogo,
          p.ultimo_deposito,
          p.ftd_em,
          p.created_at,
        ]
          .map((v) => (v ? new Date(v as string).getTime() : 0))
          .filter((n) => Number.isFinite(n) && n > 0);
        const lastActivityAt = activityCandidates.length ? Math.max(...activityCandidates) : 0;
        const isNewEvent = lastActivityAt >= activatedAt;
        const withinGrace = Date.now() < graceExpiresAt;
        if (!isNewEvent && withinGrace) {
          await supabaseAdmin.from("flow_logs").insert({
            flow_id: flow.id,
            player_id: p.id,
            event: "skipped_grace_period",
            detail: {
              trigger: flow.trigger_type,
              activated_at: flow.activated_at,
              last_activity_at: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
              grace_expires_at: new Date(graceExpiresAt).toISOString(),
            },
          });
          continue;
        }
      }

      // Anexa flow_lead novo
      const offset = randomBetween(flow.delay_min_seconds, flow.delay_max_seconds);
      const nextRun = new Date(Date.now() + offset * 1000).toISOString();
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("flow_leads")
        .insert({
          flow_id: flow.id,
          player_id: p.id,
          phone_e164: phone,
          status: "pending",
          current_block_index: 0,
          next_run_at: nextRun,
        })
        .select("id")
        .maybeSingle();
      if (insErr) continue; // provavelmente unique violation, ignora

      await supabaseAdmin.from("lead_alerts").insert({
        player_id: p.id,
        trigger_type: flow.trigger_type,
        rule_id: null,
        flow_lead_id: inserted?.id ?? null,
        payload: { aggregates },
      });
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: inserted?.id ?? null,
        player_id: p.id,
        event: "enqueued",
        detail: { trigger: flow.trigger_type, next_run_at: nextRun },
      });
      enqueued++;
    }
  }

  return { evaluated: players?.length ?? 0, enqueued, forwarded };
}

// ---------------------------------------------------------------
// EXIT CONDITIONS
// ---------------------------------------------------------------
async function shouldExit(
  flowLead: { player_id: string | null; phone_e164: string; started_at: string },
  exit: any,
): Promise<string | null> {
  const since = flowLead.started_at;
  if (!flowLead.player_id) return null;

  if (exit?.login) {
    const { data: p } = await supabaseAdmin
      .from("players")
      .select("ultimo_login, ultimo_jogo, ultimo_deposito")
      .eq("id", flowLead.player_id)
      .maybeSingle();
    const lastAct = Math.max(
      p?.ultimo_login ? new Date(p.ultimo_login).getTime() : 0,
      (p as any)?.ultimo_jogo ? new Date((p as any).ultimo_jogo).getTime() : 0,
      (p as any)?.ultimo_deposito ? new Date((p as any).ultimo_deposito).getTime() : 0,
    );
    if (lastAct > new Date(since).getTime()) return "login";
  }
  if (exit?.deposit) {
    const { data: d } = await supabaseAdmin
      .from("deposits")
      .select("id")
      .eq("player_id", flowLead.player_id)
      .eq("status", "aprovado")
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (d) return "deposit";
  }
  if (exit?.first_deposit) {
    // FTD = primeiro depósito da vida do player. Sai do fluxo se ftd_em foi
    // registrado depois que o lead entrou no fluxo.
    const { data: p } = await supabaseAdmin
      .from("players")
      .select("ftd_em")
      .eq("id", flowLead.player_id)
      .maybeSingle();
    if (p?.ftd_em && p.ftd_em > since) return "first_deposit";
  }
  if (exit?.bet) {
    const { data: e } = await supabaseAdmin
      .from("events")
      .select("id")
      .eq("player_id", flowLead.player_id)
      .eq("tipo", "bet")
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (e) return "bet";
  }
  if (exit?.whatsapp_reply) {
    const { data: m } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("id, remote_jid")
      .ilike("remote_jid", `${flowLead.phone_e164}%`)
      .eq("from_me", false)
      .gte("message_timestamp", since)
      .limit(1)
      .maybeSingle();
    if (m) return "whatsapp_reply";
  }
  return null;
}

// ---------------------------------------------------------------
// DISPATCH — envia próximo bloco dos flow_leads prontos
// ---------------------------------------------------------------
export async function runDispatcher(opts: { limit?: number; bypassWindow?: boolean; onlyLeadId?: string } = {}) {
  const limit = opts.limit ?? 30;
  const nowIso = new Date().toISOString();
  const antiban = await getAntibanSettings();
  const now = new Date();

  // Janela operacional: fora dela, reagenda todos os leads prontos para o próximo
  // início da janela MAS sem mudar o status — mudar para "cooldown" impedia
  // que esses leads voltassem à fila quando a janela reabrisse (o dispatcher
  // só lia pending/running). Agora apenas empurramos o next_run_at.
  if (!opts.bypassWindow && !isWithinOperationalWindow(now, antiban)) {
    const nextStart = nextWindowStart(now, antiban).toISOString();
    await supabaseAdmin
      .from("flow_leads")
      .update({ next_run_at: nextStart })
      .in("status", ["pending", "running", "cooldown"])
      .lte("next_run_at", nowIso);
    return { processed: 0, sent: 0, skipped: "out-of-window" };
  }

  let dueQuery = supabaseAdmin
    .from("flow_leads")
    .select("id, flow_id, template_id, player_id, phone_e164, session_id, status, current_block_index, started_at, attempt_count")
    .in("status", ["pending", "running", "cooldown"])
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(limit);
  if (opts.onlyLeadId) {
    dueQuery = supabaseAdmin
      .from("flow_leads")
      .select("id, flow_id, template_id, player_id, phone_e164, session_id, status, current_block_index, started_at, attempt_count")
      .eq("id", opts.onlyLeadId)
      .limit(1);
  }
  const { data: due } = await dueQuery;

  if (!due || due.length === 0) return { processed: 0, sent: 0 };

  // Claim atômico: empurra o next_run_at dos leads que vamos processar para
  // 5 minutos no futuro ANTES de enviar. Isso evita que dois ticks
  // concorrentes (cron sobreposto ou tick demorado) leiam o mesmo lead como
  // "due" e disparem a mensagem duas vezes. Se algo der errado, os branches
  // de erro/sucesso já regravam o next_run_at com o valor correto.
  if (!opts.onlyLeadId) {
    const claimUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    await supabaseAdmin
      .from("flow_leads")
      .update({ next_run_at: claimUntil })
      .in(
        "id",
        due.map((d) => d.id),
      );
  }

  // Carrega fluxos, templates e blocos referenciados
  const flowIds = Array.from(new Set(due.map((d) => d.flow_id)));
  const [{ data: flows }, { data: templates }, { data: allBlocks }] = await Promise.all([
    supabaseAdmin
      .from("flows")
      .select("id, name, active, exit_conditions, daily_limit, hourly_limit, delay_min_seconds, delay_max_seconds, priority")
      .in("id", flowIds),
    supabaseAdmin
      .from("flow_templates")
      .select("id, flow_id, name, is_active, weight")
      .in("flow_id", flowIds),
    supabaseAdmin
      .from("flow_blocks")
      .select("id, flow_id, flow_template_id, order_index, block_type, content, caption, media_url, media_mimetype, media_filename, delay_seconds")
      .in("flow_id", flowIds)
      .order("order_index", { ascending: true }),
  ]);
  const flowMap = new Map((flows ?? []).map((f) => [f.id, f]));
  const templatesByFlow = new Map<string, Array<{ id: string; name: string; is_active: boolean; weight: number }>>();
  for (const t of templates ?? []) {
    const arr = templatesByFlow.get(t.flow_id) ?? [];
    arr.push(t);
    templatesByFlow.set(t.flow_id, arr);
  }
  const blocksByTemplate = new Map<string, FlowBlock[]>();
  for (const b of allBlocks ?? []) {
    if (!b.flow_template_id) continue;
    const arr = blocksByTemplate.get(b.flow_template_id) ?? [];
    arr.push(b as FlowBlock);
    blocksByTemplate.set(b.flow_template_id, arr);
  }

  function pickWeightedTemplate(flowId: string): { id: string; name: string } | null {
    const tpls = (templatesByFlow.get(flowId) ?? []).filter(
      (t) => t.is_active && (blocksByTemplate.get(t.id)?.length ?? 0) > 0,
    );
    if (tpls.length === 0) return null;
    if (!antiban.randomization_enabled) {
      // determinístico: o de maior peso (desempate por ordem)
      const sorted = [...tpls].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
      return { id: sorted[0].id, name: sorted[0].name };
    }
    const total = tpls.reduce((a, t) => a + Math.max(1, t.weight || 1), 0);
    let r = Math.random() * total;
    for (const t of tpls) {
      r -= Math.max(1, t.weight || 1);
      if (r <= 0) return { id: t.id, name: t.name };
    }
    return { id: tpls[tpls.length - 1].id, name: tpls[tpls.length - 1].name };
  }

  let sent = 0;
  for (const lead of due) {
    const flow = flowMap.get(lead.flow_id);
    if (!flow || !flow.active) {
      await supabaseAdmin.from("flow_leads").update({ status: "exited", exit_reason: "flow_inactive", completed_at: nowIso }).eq("id", lead.id);
      continue;
    }

    // Exit conditions ANTES de enviar
    const baseExit = (flow.exit_conditions ?? {}) as Record<string, boolean>;
    const exitCfg = antiban.smart_suppression_enabled
      ? baseExit
      : { ...baseExit, whatsapp_reply: false };
    const reason = await shouldExit(lead, exitCfg);
    if (reason) {
      await supabaseAdmin
        .from("flow_leads")
        .update({ status: "exited", exit_reason: reason, completed_at: nowIso })
        .eq("id", lead.id);
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: lead.id,
        player_id: lead.player_id,
        event: "exited",
        detail: { reason },
      });
      continue;
    }

    // Resolve template: usa o já travado no lead OU sorteia ponderado entre os ativos.
    let templateId = (lead as any).template_id as string | null | undefined;
    let templateName: string | null = null;
    if (!templateId) {
      const picked = pickWeightedTemplate(flow.id);
      if (picked) {
        templateId = picked.id;
        templateName = picked.name;
        await supabaseAdmin.from("flow_leads").update({ template_id: templateId }).eq("id", lead.id);
      }
    }
    const blocks = templateId ? (blocksByTemplate.get(templateId) ?? []) : [];
    if (blocks.length === 0) {
      await supabaseAdmin.from("flow_leads").update({ status: "completed", completed_at: nowIso }).eq("id", lead.id);
      continue;
    }
    const idx = lead.current_block_index;
    if (idx >= blocks.length) {
      await supabaseAdmin.from("flow_leads").update({ status: "completed", completed_at: nowIso }).eq("id", lead.id);
      continue;
    }
    const block = blocks[idx];

    // Resolve sessão
    const session = await getOrAssignSession(lead.phone_e164, lead.player_id);
    if (!session) {
      // Posterga 30 min
      await supabaseAdmin
        .from("flow_leads")
        .update({ next_run_at: new Date(Date.now() + 30 * 60_000).toISOString() })
        .eq("id", lead.id);
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: lead.id,
        player_id: lead.player_id,
        event: "skipped",
        detail: { reason: "no-connected-session" },
      });
      continue;
    }

    // Limite horário/diário da sessão
    const { data: sessFull } = await supabaseAdmin
      .from("whatsapp_sessions")
      .select("messages_sent_today, daily_limit, hourly_limit, created_at")
      .eq("id", session.id)
      .single();
    const caps = applyAntibanCaps(flow, sessFull ?? {}, antiban);
    if (sessFull && (sessFull.messages_sent_today ?? 0) >= caps.dailyLimit) {
      await supabaseAdmin
        .from("flow_leads")
        .update({ next_run_at: new Date(Date.now() + 60 * 60_000).toISOString() })
        .eq("id", lead.id);
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: lead.id,
        player_id: lead.player_id,
        event: "skipped",
        detail: { reason: "daily-limit", session: session.name, cap: caps.dailyLimit },
      });
      continue;
    }
    // Limite horário (rolling 1h) — usa flow_logs
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count: lastHour } = await supabaseAdmin
      .from("flow_logs")
      .select("*", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("event", "sent")
      .gte("created_at", oneHourAgo);
    if ((lastHour ?? 0) >= caps.hourlyLimit) {
      await supabaseAdmin
        .from("flow_leads")
        .update({ next_run_at: new Date(Date.now() + 15 * 60_000).toISOString() })
        .eq("id", lead.id);
      continue;
    }

    // ENVIA
    try {
      // Renderiza variáveis {primeiro_nome}, {saldo}, etc. usando dados do
      // player (se houver). Sem player, mantém tokens — evita mensagens com
      // espaços vazios enganosos.
      let blockToSend = block;
      if (lead.player_id) {
        const { data: player } = await supabaseAdmin
          .from("players")
          .select(
            "nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
          )
          .eq("id", lead.player_id)
          .maybeSingle();
        if (player) {
          const vars = buildPlayerVariables(player);
          blockToSend = {
            ...block,
            content: block.content ? renderTemplate(block.content, vars) : block.content,
            caption: block.caption ? renderTemplate(block.caption, vars) : block.caption,
          };
        }
      }
      const result = await sendFlowBlock(
        blockToSend,
        { phone_e164: lead.phone_e164, player_id: lead.player_id },
        session,
      );
      const isLast = idx + 1 >= blocks.length;
      const blockDelay = block.delay_seconds ?? 0;
      const flowDelay = randomBetween(caps.delayMin, caps.delayMax);
      const nextDelaySec = blockDelay > 0 ? blockDelay : flowDelay;
      const nextRun = new Date(Date.now() + nextDelaySec * 1000).toISOString();

      await supabaseAdmin
        .from("flow_leads")
        .update({
          current_block_index: idx + 1,
          status: isLast ? "completed" : "running",
          next_run_at: isLast ? nowIso : nextRun,
          completed_at: isLast ? nowIso : null,
          session_id: session.id,
          attempt_count: (lead.attempt_count ?? 0) + 1,
          last_error: null,
        })
        .eq("id", lead.id);

      if (!result.skipDispatch) {
        sent++;
        await supabaseAdmin
          .from("whatsapp_sessions")
          .update({ messages_sent_today: (sessFull?.messages_sent_today ?? 0) + 1 })
          .eq("id", session.id);
      }

      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: lead.id,
        player_id: lead.player_id,
        block_id: block.id,
        session_id: session.id,
        event: result.skipDispatch ? "dispatched" : "sent",
        detail: { block_type: block.block_type, message_id: result.messageId, template_id: templateId, template_name: templateName },
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await supabaseAdmin
        .from("flow_leads")
        .update({
          status: "failed",
          last_error: msg.slice(0, 500),
          attempt_count: (lead.attempt_count ?? 0) + 1,
          next_run_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        })
        .eq("id", lead.id);
      await supabaseAdmin.from("flow_logs").insert({
        flow_id: flow.id,
        flow_lead_id: lead.id,
        player_id: lead.player_id,
        block_id: block.id,
        session_id: session.id,
        event: "failed",
        detail: { error: msg.slice(0, 500) },
      });

      // Pausa automática: 3 falhas em 10 min na mesma sessão
      if (antiban.auto_pause_enabled) {
        const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
        const { count: failures } = await supabaseAdmin
          .from("flow_logs")
          .select("*", { count: "exact", head: true })
          .eq("session_id", session.id)
          .eq("event", "failed")
          .gte("created_at", tenMinAgo);
        if ((failures ?? 0) >= 3) {
          await supabaseAdmin
            .from("whatsapp_sessions")
            .update({ is_active: false })
            .eq("id", session.id);
        }
      }
    }
  }

  return { processed: due.length, sent };
}
