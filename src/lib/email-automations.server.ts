// Dispatcher dos fluxos de automacao de email.
// Pega leads com next_run_at <= now() e executa o bloco atual.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callBusinessCodeEmail, resolveSender } from "./email-send.server";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { deferIfOutsideWindow } from "./send-window.server";
import {
  consumeBudget,
  countQueuePending,
  getRateState,
  parseRetryAfter,
  recordRun,
  registerThrottle,
} from "./dispatch-rate.server";

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        console.error("[email-flow dispatcher] pool item failed", e);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

type Block = {
  id: string;
  flow_id: string;
  order_index: number;
  block_type: string;
  template_ids: string[] | null;
  sender_id: string | null;
  smtp_config_id: string | null;
  subject_override: string | null;
  preheader_override: string | null;
  pre_delay_seconds: number;
  delay_seconds: number;
  condition_type: string | null;
  condition_value: string | null;
  label: string | null;
  tenant_id: string;
  send_at_hour: number | null;
  send_at_minute: number | null;
  skip_if_past: boolean | null;
};

type Lead = {
  id: string;
  flow_id: string;
  player_id: string | null;
  email: string;
  status: string;
  current_block_index: number;
  last_template_id: string | null;
  attempts: number;
  tenant_id: string;
};

async function logEvent(
  flow_id: string,
  flow_lead_id: string | null,
  player_id: string | null,
  event: string,
  detail: Record<string, unknown> = {},
) {
  await supabaseAdmin.from("email_flow_logs").insert({
    flow_id,
    flow_lead_id,
    player_id,
    event,
    detail: detail as never,
  });
}

/** Checa se alguma condicao de saida esta satisfeita pelo player. */
async function shouldExit(
  exitConditions: Record<string, boolean>,
  player_id: string | null,
  entered_at: string,
): Promise<string | null> {
  if (!player_id) return null;
  const { data: p } = await supabaseAdmin
    .from("players")
    .select("ultimo_login, ultimo_jogo, ultimo_deposito, ftd_em, total_depositado, status")
    .eq("id", player_id)
    .maybeSingle();
  if (!p) return null;
  const since = new Date(entered_at).getTime();
  // "login" = qualquer atividade (login, jogo OU depósito).
  const lastAct = Math.max(
    p.ultimo_login ? new Date(p.ultimo_login).getTime() : 0,
    (p as any).ultimo_jogo ? new Date((p as any).ultimo_jogo).getTime() : 0,
    p.ultimo_deposito ? new Date(p.ultimo_deposito).getTime() : 0,
  );
  if (exitConditions.login && lastAct > since) return "login";
  if (exitConditions.deposit && p.ultimo_deposito && new Date(p.ultimo_deposito).getTime() > since)
    return "deposit";
  if (exitConditions.first_deposit && p.ftd_em && new Date(p.ftd_em).getTime() > since)
    return "first_deposit";
  // "bet" (UI antigo) e "voltou_jogar" são sinônimos — sai se voltou a jogar depois de entrar.
  if (
    (exitConditions.bet || exitConditions.voltou_jogar) &&
    (p as any).ultimo_jogo &&
    new Date((p as any).ultimo_jogo).getTime() > since
  )
    return "voltou_jogar";
  return null;
}

async function getBlocks(flow_id: string): Promise<Block[]> {
  const { data } = await supabaseAdmin
    .from("email_flow_blocks")
    .select("*")
    .eq("flow_id", flow_id)
    .order("order_index", { ascending: true });
  return (data ?? []) as Block[];
}

/** Escolhe um template do bloco evitando o ultimo enviado se houver alternativa. */
function pickTemplate(template_ids: string[], last_template_id: string | null): string | null {
  if (!template_ids || template_ids.length === 0) return null;
  if (template_ids.length === 1) return template_ids[0];
  const candidates = template_ids.filter((t) => t !== last_template_id);
  const pool = candidates.length > 0 ? candidates : template_ids;
  return pool[Math.floor(Math.random() * pool.length)];
}

type SendPlan = {
  lead: Lead;
  blocks: Block[];
  blockIdx: number;
  tplId: string;
  subject: string;
  html: string;
  sender: { fromEmail: string; fromName: string | null; replyTo: string | null };
};

/** "Dia N" para email: 1 + soma de pre_delay_seconds+delay_seconds dos blocks anteriores, em dias. */
function computeEmailStepLabel(blocks: Block[], idx: number): string {
  let secs = 0;
  for (let i = 0; i < idx; i++) {
    const b = blocks[i];
    if (!b) continue;
    secs += (b.pre_delay_seconds || 0) + (b.delay_seconds || 0);
  }
  const dayN = 1 + Math.floor(secs / 86400);
  return `Dia ${dayN}`;
}

/**
 * Calcula o instante BRT (America/Sao_Paulo, UTC-3 fixo) correspondente a um
 * hour:minute em uma data base. Retorna o instante UTC.
 */
function brtSlotForDay(base: Date, hour: number, minute: number): Date {
  const BRT_OFFSET_MIN = -180; // BRT = UTC-3
  const shifted = new Date(base.getTime() + BRT_OFFSET_MIN * 60_000);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      hour + 3, // BRT hour -> UTC hour
      minute,
      0,
      0,
    ),
  );
}

/**
 * Para um bloco com send_at_hour definido (horário BRT fixo), decide quando
 * deve rodar:
 *  - { skip: true }  → o bloco deve ser pulado (slot de hoje já passou e
 *    skip_if_past=true).
 *  - { runAt }       → instante (UTC) em que o bloco deve rodar.
 * Para blocos sem send_at_hour, retorna runAt=now (comportamento atual).
 */
function computeBlockSchedule(
  block: Block,
  now: Date = new Date(),
): { runAt: Date; skip: boolean } {
  const h = block.send_at_hour;
  if (h == null) return { runAt: now, skip: false };
  const m = block.send_at_minute ?? 0;
  const today = brtSlotForDay(now, h, m);
  if (today.getTime() > now.getTime()) return { runAt: today, skip: false };
  if (block.skip_if_past) return { runAt: now, skip: true };
  const tomorrow = new Date(today.getTime() + 86400_000);
  return { runAt: tomorrow, skip: false };
}

/** Executa um lead ate atingir um bloco que precisa de espera ou termina.
 *  Se chegar num send_email, retorna o plano de envio (sem chamar BC) pra
 *  o caller agrupar e despachar em lote via /messaging/dispatches. */
async function planLead(lead: Lead): Promise<SendPlan | null> {
  const { data: flow } = await supabaseAdmin
    .from("email_flows")
    .select("id, active, exit_conditions, daily_limit")
    .eq("id", lead.flow_id)
    .maybeSingle();
  if (!flow || !flow.active) {
    await supabaseAdmin.from("email_flow_leads").update({ status: "exited", exit_reason: "flow_inactive" }).eq("id", lead.id);
    return null;
  }

  const exitConditions = (flow.exit_conditions ?? {}) as Record<string, boolean>;
  const blocks = await getBlocks(lead.flow_id);

  let idx = lead.current_block_index;
  let lastTemplateId = lead.last_template_id;

  // proteção: limite de iteracoes por tick
  for (let safety = 0; safety < 20; safety++) {
    if (idx >= blocks.length) {
      await supabaseAdmin
        .from("email_flow_leads")
        .update({ status: "completed", current_block_index: idx, exit_reason: "completed", locked_at: null, locked_by: null })
        .eq("id", lead.id);
      await logEvent(lead.flow_id, lead.id, lead.player_id, "completed", {});
      return null;
    }
    const block = blocks[idx];

    // checa condicoes de saida em tempo real
    const { data: leadRow } = await supabaseAdmin
      .from("email_flow_leads")
      .select("entered_at")
      .eq("id", lead.id)
      .maybeSingle();
    const reason = await shouldExit(exitConditions, lead.player_id, leadRow?.entered_at ?? new Date().toISOString());
    if (reason) {
      await supabaseAdmin
        .from("email_flow_leads")
        .update({ status: "exited", exit_reason: reason, locked_at: null, locked_by: null })
        .eq("id", lead.id);
      await logEvent(lead.flow_id, lead.id, lead.player_id, "exited", { reason });
      return null;
    }

    if (block.block_type === "start") {
      idx++;
      continue;
    }
    if (block.block_type === "end" || block.block_type === "remove") {
      await supabaseAdmin
        .from("email_flow_leads")
        .update({ status: "completed", current_block_index: idx, exit_reason: block.block_type, locked_at: null, locked_by: null })
        .eq("id", lead.id);
      await logEvent(lead.flow_id, lead.id, lead.player_id, "completed", { block: block.block_type });
      return null;
    }
    if (block.block_type === "delay") {
      const next = new Date(Date.now() + Math.max(0, block.delay_seconds) * 1000).toISOString();
      await supabaseAdmin
        .from("email_flow_leads")
        .update({ status: "running", current_block_index: idx + 1, next_run_at: next, locked_at: null, locked_by: null })
        .eq("id", lead.id);
      return null;
    }
    if (block.block_type === "tag" || block.block_type === "condition") {
      // sem ramificacao no MVP; loga e segue
      await logEvent(lead.flow_id, lead.id, lead.player_id, block.block_type, { label: block.label });
      idx++;
      continue;
    }
    if (block.block_type === "send_email") {
      // Agendamento por horário fixo BRT (send_at_hour/send_at_minute).
      // Se o slot de hoje já passou e skip_if_past=true → pula o bloco.
      // Se ainda não chegou no slot → reagenda e libera o lock.
      if (block.send_at_hour != null) {
        const sched = computeBlockSchedule(block);
        if (sched.skip) {
          await logEvent(lead.flow_id, lead.id, lead.player_id, "skipped_past_window", {
            block_index: idx,
            send_at_hour: block.send_at_hour,
            send_at_minute: block.send_at_minute ?? 0,
          });
          // avança para o próximo bloco SEM disparar
          await supabaseAdmin
            .from("email_flow_leads")
            .update({ status: "running", current_block_index: idx + 1, next_run_at: new Date().toISOString(), locked_at: null, locked_by: null })
            .eq("id", lead.id);
          return null;
        }
        if (sched.runAt.getTime() > Date.now() + 30_000) {
          await supabaseAdmin
            .from("email_flow_leads")
            .update({ status: "running", next_run_at: sched.runAt.toISOString(), locked_at: null, locked_by: null })
            .eq("id", lead.id);
          return null;
        }
      }
      // Janela de envio: fora dela, reagenda sem marcar falha.
      const defer = await deferIfOutsideWindow();
      if (defer) {
        await supabaseAdmin
          .from("email_flow_leads")
          .update({ status: "running", next_run_at: defer, locked_at: null, locked_by: null })
          .eq("id", lead.id);
        await logEvent(lead.flow_id, lead.id, lead.player_id, "deferred_quiet_hours", {
          next_run_at: defer,
        });
        return null;
      }
      const tplId = pickTemplate(block.template_ids ?? [], lastTemplateId);
      if (!tplId) {
        await logEvent(lead.flow_id, lead.id, lead.player_id, "failed", {
          reason: "no_template_in_block",
          block_index: idx,
        });
        await supabaseAdmin
          .from("email_flow_leads")
          .update({ status: "failed", exit_reason: "no_template_in_block", locked_at: null, locked_by: null })
          .eq("id", lead.id);
        return null;
      }
      const { data: tpl } = await supabaseAdmin
        .from("email_templates")
        .select("subject, body_html, preheader")
        .eq("id", tplId)
        .maybeSingle();
      if (!tpl) {
        await logEvent(lead.flow_id, lead.id, lead.player_id, "failed", { reason: "template_missing", tplId });
        await supabaseAdmin
          .from("email_flow_leads")
          .update({ status: "failed", exit_reason: "template_missing", locked_at: null, locked_by: null })
          .eq("id", lead.id);
        return null;
      }
      const sender = await resolveSender(block.smtp_config_id, block.tenant_id);
      if (!sender) {
        await logEvent(lead.flow_id, lead.id, lead.player_id, "failed", { reason: "no_sender" });
        await supabaseAdmin
          .from("email_flow_leads")
          .update({ status: "failed", exit_reason: "no_sender", locked_at: null, locked_by: null })
          .eq("id", lead.id);
        return null;
      }

      // variaveis do player
      let vars: Record<string, string> = { email: lead.email };
      if (lead.player_id) {
        const { data: p } = await supabaseAdmin.from("players").select("*").eq("id", lead.player_id).maybeSingle();
        if (p) vars = buildPlayerVariables(p) as Record<string, string>;
      }
      const subject = renderTemplate(block.subject_override || tpl.subject || "", vars);
      const html = renderTemplate(tpl.body_html || "", vars);

      // Retorna o plano de envio. O caller agrupa por (subject+html+from)
      // e despacha em lote. Toda a lógica pós-envio é aplicada lá.
      return { lead, blocks, blockIdx: idx, tplId, subject, html, sender };
    }
    // unknown -> skip
    idx++;
  }
  // Loop terminou (todos os blocos eram start/tag/condition sem despachar):
  // libera o lock para o próximo tick não ter que esperar o "recover".
  await supabaseAdmin
    .from("email_flow_leads")
    .update({ locked_at: null, locked_by: null })
    .eq("id", lead.id);
  return null;
}

/** Aplica updates pós-envio bem-sucedido para um lead. */
async function applySendSuccess(plan: SendPlan, dispatchId: string | null) {
  const { lead, blocks, blockIdx, tplId } = plan;
  const isLast =
    blockIdx === blocks.length - 1 || blocks.slice(blockIdx + 1).every((b) => b.block_type === "end");
  const nextIdx = blockIdx + 1;
  const nextBlock = blocks[nextIdx];
  let next_run_at = new Date().toISOString();
  if (nextBlock) {
    if (nextBlock.block_type === "delay") {
      next_run_at = new Date(Date.now() + Math.max(0, nextBlock.delay_seconds) * 1000).toISOString();
    } else if (nextBlock.block_type === "send_email" && nextBlock.send_at_hour != null) {
      const sched = computeBlockSchedule(nextBlock);
      // se skip, runner do próximo tick pula o bloco; agenda ASAP
      next_run_at = sched.skip ? new Date().toISOString() : sched.runAt.toISOString();
    }
  }
  await supabaseAdmin
    .from("email_flow_leads")
    .update({
      status: isLast ? "completed" : "running",
      current_block_index: nextBlock && nextBlock.block_type === "delay" ? nextIdx + 1 : nextIdx,
      last_template_id: tplId,
      last_sent_at: new Date().toISOString(),
      attempts: lead.attempts + 1,
      next_run_at,
      exit_reason: isLast ? "completed" : null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", lead.id);
}

/** Aplica updates pós-falha (temporária reagenda com backoff, permanente marca failed). */
async function applySendFailure(
  plan: SendPlan,
  status: number,
  temporary: boolean,
  insufficient: boolean = false,
) {
  const { lead } = plan;
  const MAX_TEMP_ATTEMPTS = 5;
  const isAuthError = status === 401 || status === 403;
  // Sem saldo: NÃO toca em next_run_at nem em attempts. O canal já foi pausado
  // em dispatch_pause_state — quando despausar, o lead volta com o agendamento
  // ORIGINAL preservado, evitando burst concentrado de envios.
  if (insufficient) {
    await supabaseAdmin
      .from("email_flow_leads")
      .update({ status: "running", locked_at: null, locked_by: null })
      .eq("id", lead.id);
    return;
  }
  if (temporary && (isAuthError || lead.attempts + 1 < MAX_TEMP_ATTEMPTS)) {
    // Auth error: backoff fixo de 10 min e NÃO incrementa attempts (não estoura MAX).
    const backoffMs = isAuthError
      ? 600_000
      : Math.min(15 * 60_000, 60_000 * Math.pow(2, lead.attempts));
    await supabaseAdmin
      .from("email_flow_leads")
      .update({
        status: "running",
        attempts: isAuthError ? lead.attempts : lead.attempts + 1,
        next_run_at: new Date(Date.now() + backoffMs).toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", lead.id);
    return;
  }
  await supabaseAdmin
    .from("email_flow_leads")
    .update({
      status: "failed",
      attempts: lead.attempts + 1,
      exit_reason: `send_failed_${status}`,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", lead.id);
}

export async function runEmailFlowDispatcher({ limit = 30, onlyLeadId }: { limit?: number; onlyLeadId?: string } = {}) {
  const startedAt = Date.now();
  const channel = "email" as const;
  const queueBefore = onlyLeadId ? 0 : await countQueuePending("email_flow_leads");

  // Respeita pause global e pause por canal (email_paused).
  if (!onlyLeadId) {
    const { data: settings } = await supabaseAdmin
      .from("automation_settings")
      .select("paused, email_paused")
      .limit(1)
      .maybeSingle();
    if (settings?.paused || settings?.email_paused) {
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        stop_reason: "paused",
        provider: "businesscode-email",
      });
      return { processed: 0, ids: [] as string[], paused: true };
    }
  }

  // Janela de envio (fora dela: não claim, só registra)
  if (!onlyLeadId) {
    const defer = await deferIfOutsideWindow();
    if (defer) {
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        stop_reason: "outside_window",
        provider: "businesscode-email",
      });
      return { processed: 0, ids: [] as string[], deferred_until: defer };
    }
  }

  // Cadência: só checa backoff. Budget é consumido depois do planning,
  // em cima do número real de e-mails que vão sair (evita queimar minuto
  // inteiro com leads que estão em delay/exit/tag).
  let rateState = null as Awaited<ReturnType<typeof getRateState>>;
  if (!onlyLeadId) {
    rateState = await getRateState(channel);
    const inBackoff =
      !!(rateState?.backoff_until && new Date(rateState.backoff_until).getTime() > Date.now());
    if (inBackoff) {
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        stop_reason: "rate_limited",
        target_rate: rateState?.target_per_minute ?? null,
        provider: "businesscode-email",
        last_provider_error: rateState?.last_provider_error ?? null,
      });
      return { processed: 0, ids: [] as string[], throttled: true };
    }
    limit = Math.max(1, Math.min(limit, rateState?.max_per_minute ?? 100));
  }

  let leads: Lead[] | null;
  if (onlyLeadId) {
    const { data, error } = await supabaseAdmin
      .from("email_flow_leads")
      .select("*")
      .eq("id", onlyLeadId)
      .limit(1);
    if (error) throw new Error(error.message);
    leads = (data ?? []) as Lead[];
  } else {
    // Claim atômico: reserva via FOR UPDATE SKIP LOCKED — seguro pra
    // execução paralela do cron sem duplicar envio.
    const { data, error } = await supabaseAdmin.rpc("claim_email_flow_leads", {
      p_limit: limit,
    });
    if (error) {
      console.error("[email-flow dispatcher] claim falhou", error);
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        stop_reason: `claim_error: ${error.message.slice(0, 200)}`,
        provider: "businesscode-email",
      });
      return { processed: 0, ids: [] as string[], error: error.message };
    }
    leads = (data ?? []) as Lead[];
  }
  const all = (leads ?? []) as Lead[];
  if (all.length === 0) {
    if (!onlyLeadId) {
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        claimed: 0,
        stop_reason: "queue_empty",
        target_rate: rateState?.target_per_minute ?? null,
        provider: "businesscode-email",
      });
    }
    return { processed: 0, ids: [] as string[] };
  }

  // FASE 1: planeja cada lead (state machine). Quem chega num send_email
  // retorna SendPlan; quem é delay/exit/etc já gravou seu update.
  const planResults = await Promise.allSettled(
    all.map(async (l) => {
      try {
        return await planLead(l);
      } catch (e) {
        console.error("[email-flow dispatcher] plan erro", l.id, e);
        await logEvent(l.flow_id, l.id, l.player_id, "failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    }),
  );
  const plans: SendPlan[] = [];
  for (const r of planResults) {
    if (r.status === "fulfilled" && r.value) plans.push(r.value);
  }
  if (plans.length === 0) {
    if (!onlyLeadId) {
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        claimed: all.length,
        stop_reason: "nothing_to_send",
        target_rate: rateState?.target_per_minute ?? null,
        provider: "businesscode-email",
      });
    }
    return { processed: 0, ids: [] as string[] };
  }

  // Consome budget apenas com o número real de envios planejados.
  let toSendPlans = plans;
  if (!onlyLeadId) {
    const budget = await consumeBudget(channel, plans.length);
    if (budget === 0) {
      await Promise.allSettled(
        plans.map((p) =>
          supabaseAdmin
            .from("email_flow_leads")
            .update({
              next_run_at: new Date(Date.now() + 10_000).toISOString(),
              locked_at: null,
              locked_by: null,
            })
            .eq("id", p.lead.id),
        ),
      );
      await recordRun(startedAt, {
        channel,
        queue_before: queueBefore,
        claimed: all.length,
        stop_reason: "throttled_by_minute_cap",
        target_rate: rateState?.target_per_minute ?? null,
        provider: "businesscode-email",
      });
      return { processed: 0, ids: [] as string[], throttled: true };
    }
    const overflow = plans.slice(budget);
    toSendPlans = plans.slice(0, budget);
    if (overflow.length > 0) {
      await Promise.allSettled(
        overflow.map((p) =>
          supabaseAdmin
            .from("email_flow_leads")
            .update({
              next_run_at: new Date(Date.now() + 5_000).toISOString(),
              locked_at: null,
              locked_by: null,
            })
            .eq("id", p.lead.id),
        ),
      );
    }
  }

  // FASE 2: envia em paralelo (pool de 50) via endpoint unitário.
  // Pool reduzido para 10 para respeitar limite real do SMTP/provedor e evitar
  // rajadas. 429/erros temporários disparam backoff global.
  const processed: string[] = [];
  let errorsCount = 0;
  let rescheduled = 0;
  let rateLimited = 0;
  let lastProviderError: string | null = null;
  await runPool(toSendPlans, 10, async (plan) => {
    const nowIso = new Date().toISOString();
    // Idempotência anti-duplicação: se já enviamos esse subject para esse
    // email com sucesso nos últimos 30 minutos, NÃO chama o provedor de
    // novo — só avança o lead. Protege contra o caso de mesmo email estar
    // inscrito em vários fluxos ou em múltiplas instâncias do mesmo fluxo.
    const dedupeSince = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: recentDup } = await supabaseAdmin
      .from("email_send_logs")
      .select("id")
      .eq("to_email", plan.lead.email)
      .eq("subject", plan.subject)
      .eq("status", "sent")
      .gte("created_at", dedupeSince)
      .limit(1);
    if (recentDup && recentDup.length > 0) {
      await logEvent(plan.lead.flow_id, plan.lead.id, plan.lead.player_id, "skipped_duplicate", {
        template_id: plan.tplId,
        subject: plan.subject,
        reason: "same_subject_sent_recently",
      });
      await applySendSuccess(plan, null);
      processed.push(plan.lead.id);
      return;
    }
    const result = await callBusinessCodeEmail({
      to: plan.lead.email,
      from: plan.sender.fromEmail,
      fromName: plan.sender.fromName,
      replyTo: plan.sender.replyTo,
      subject: plan.subject,
      html: plan.html,
    });
    const isTemporary = !result.ok && result.temporary === true;

    await supabaseAdmin.from("email_send_logs").insert({
      to_email: plan.lead.email,
      subject: plan.subject,
      status: result.ok ? "sent" : isTemporary ? "pending" : "error",
      error: result.ok ? null : JSON.stringify(result.body).slice(0, 800),
      sent_at: result.ok ? nowIso : null,
      player_id: plan.lead.player_id,
      flow_id: plan.lead.flow_id,
      flow_lead_id: plan.lead.id,
      block_index: plan.blockIdx,
      step_label: computeEmailStepLabel(plan.blocks, plan.blockIdx),
      tenant_id: plan.lead.tenant_id,
      provider_response: {
        status: result.status,
        body: result.body,
        idempotency_key: result.idempotencyKey,
        flow_id: plan.lead.flow_id,
        flow_lead_id: plan.lead.id,
        template_id: plan.tplId,
        source: "email_flow_dispatcher",
      } as never,
    });

    await logEvent(
      plan.lead.flow_id,
      plan.lead.id,
      plan.lead.player_id,
      result.ok ? "sent" : "failed",
      { template_id: plan.tplId, status: result.status, temporary: isTemporary },
    );

    if (result.ok) {
      await applySendSuccess(plan, null);
      processed.push(plan.lead.id);
    } else {
      // 429 ou rate-limit: registra throttle global pra desacelerar próximos ticks.
      const bodyStr = JSON.stringify(result.body ?? {}).slice(0, 400);
      lastProviderError = `status=${result.status} ${bodyStr}`.slice(0, 800);
      const { isInsufficientFunds, pauseChannelForInsufficientFunds } = await import(
        "./dispatch-pause-insufficient.server"
      );
      const insufficient = isInsufficientFunds(result.status, result.body);
      if (result.status === 429 || /rate.?limit|throttle|too many/i.test(bodyStr)) {
        rateLimited++;
        const retryAfter = parseRetryAfter(result.body);
        await registerThrottle("email", retryAfter, lastProviderError);
      }
      if (result.status === 401 || result.status === 403) {
        await registerThrottle("email", 600, `auth_error_${result.status}: ${lastProviderError}`);
      }
      if (insufficient) {
        await pauseChannelForInsufficientFunds("email", lastProviderError);
        await registerThrottle("email", 1800, `insufficient_funds: ${lastProviderError}`);
      }
      const treatAsTemporary = isTemporary || insufficient;
      if (treatAsTemporary || result.status === 429) rescheduled++;
      else errorsCount++;
      await applySendFailure(plan, result.status, treatAsTemporary, insufficient);
    }
  });

  if (!onlyLeadId) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      claimed: all.length,
      sent: processed.length,
      errors: errorsCount,
      rescheduled,
      rate_limited: rateLimited,
      target_rate: rateState?.target_per_minute ?? null,
      actual_rate: processed.length,
      stop_reason: rateLimited > 0 ? "provider_rate_limited" : "ok",
      provider: "businesscode-email",
      last_provider_error: lastProviderError,
    });
  }

  return { processed: processed.length, ids: processed };
}