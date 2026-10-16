// Dispatcher dos fluxos de SMS. Avança uma etapa por execução, respeita
// delay_days, exit conditions e limite diário global.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { channelBudget } from "./rate-limit/channel-budget.server";
import { sleep } from "./rate-limit/pool";
import { renderSmsVariables, sendSmsInternal } from "./sms.functions";
import {
  reconcileStaleSubmittingLogs,
  sendSmsBatch,
  smsBulkEnabled,
  smsBulkTransport,
} from "./sms-bulk.server";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import { deferIfOutsideWindow } from "./send-window.server";
import { brtDayStart } from "./tz";
import {
  consumeBudget,
  countQueuePending,
  getRateState,
  parseRetryAfter,
  recordRun,
  registerThrottle,
} from "./dispatch-rate.server";
import {
  isInsufficientFunds,
  pauseChannelForInsufficientFunds,
} from "./dispatch-pause-insufficient.server";
import { pingHeartbeat, startJobRun, type JobRunHandle } from "./observability/job-monitor.server";
import { SMS_CAMPAIGN_RUN_BUDGET_MS, SMS_CAMPAIGN_TICK_SECONDS } from "./campaign-recipients";
import {
  findAcceptedDeliveryKeys,
  persistCampaignUnresolved,
  resolveCampaignRecipients,
  type CampaignDb,
} from "./campaign-recipients.server";
import {
  processSmsCampaignTick,
  type CampaignDispatchDeps,
  type ProviderGateDecision,
  type SmsCampaignRow,
} from "./sms-campaign-dispatch.server";
import {
  acquireSmsSendGate,
  breakerRetryAt,
  cachedSmsBreaker,
  readSmsBreaker,
  releaseSmsProbe,
  smsSuspendedMessage,
  type SmsSendGate,
} from "./sms-provider-breaker.server";
import { PROVIDER_ACCOUNT_DEFER_MS } from "./rate-limit/provider-errors.server";

const SMS_CAMPAIGN_JOB = "sms_campaign_dispatch";

/**
 * Converte (entered_at, day_offset, "HH:MM") em instante UTC,
 * tratando o HH:MM como horário fixo America/Sao_Paulo (UTC-3).
 * Usado pelo modelo CRM_EXPERT para agendar SMS em horário exato.
 */
function brtScheduledAt(enteredAtIso: string, dayOffset: number, hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  // entered_at em wall-clock BRT (deslocando -3h do UTC)
  const entered = new Date(enteredAtIso);
  const brt = new Date(entered.getTime() - 3 * 3_600_000);
  const y = brt.getUTCFullYear();
  const mo = brt.getUTCMonth();
  const d = brt.getUTCDate() + dayOffset;
  // HH:MM BRT == (HH+3):MM UTC do mesmo dia BRT
  return new Date(Date.UTC(y, mo, d, hh + 3, mm, 0, 0)).toISOString();
}

/** Concurrency pool simples — sem dependência nova. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        // não derruba o pool — registra e segue
        console.error("[sms-dispatcher] pool item failed", e);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

type Step = {
  id: string;
  flow_id: string;
  order_index: number;
  step_type: string;
  content: string | null;
  delay_days: number;
  delay_hours?: number | null;
  is_active: boolean;
  scheduled_time?: string | null;
  scheduled_day_offset?: number | null;
  track_links?: boolean | null;
};

function delayMs(step: Step): number {
  if (step.delay_hours != null) return Math.max(0, Number(step.delay_hours)) * 3600000;
  return Math.max(0, Number(step.delay_days)) * 86400000;
}

type Lead = {
  id: string;
  flow_id: string;
  player_id: string | null;
  phone_e164: string;
  current_step_index: number;
  attempts: number;
  entered_at: string;
  tenant_id: string;
};

type ExitConditions = {
  login?: boolean;
  deposit?: boolean;
  first_deposit?: boolean;
  voltou_jogar?: boolean;
};

async function shouldExit(
  exit: ExitConditions,
  playerId: string | null,
  enteredAt: string,
): Promise<string | null> {
  if (!playerId) return null;
  const { data: p } = await supabaseAdmin
    .from("players")
    .select("ultimo_login, ultimo_deposito, ftd_em, ultimo_jogo")
    .eq("id", playerId)
    .maybeSingle();
  if (!p) return null;
  const since = new Date(enteredAt).getTime();
  // "login" agora aceita qualquer atividade do player (login OU jogo OU depósito).
  // Sem isso, o fluxo continua enviando mesmo quando o lead voltou a jogar/depositar.
  const lastAct = Math.max(
    p.ultimo_login ? new Date(p.ultimo_login).getTime() : 0,
    p.ultimo_jogo ? new Date(p.ultimo_jogo).getTime() : 0,
    p.ultimo_deposito ? new Date(p.ultimo_deposito).getTime() : 0,
  );
  if (exit.login && lastAct > since) return "login";
  if (exit.deposit && p.ultimo_deposito && new Date(p.ultimo_deposito).getTime() > since)
    return "deposit";
  if (exit.first_deposit && p.ftd_em && new Date(p.ftd_em).getTime() > since)
    return "first_deposit";
  if (exit.voltou_jogar && p.ultimo_jogo && new Date(p.ultimo_jogo).getTime() > since)
    return "voltou_jogar";
  return null;
}

async function isPaused(): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("automation_settings")
    .select("paused, sms_paused")
    .limit(1)
    .maybeSingle();
  return !!(data?.paused || data?.sms_paused);
}

export async function runSmsDispatcher({ limit = 30 }: { limit?: number } = {}) {
  const startedAt = Date.now();
  const channel = "sms" as const;
  const queueBefore = await countQueuePending("sms_flow_leads");

  if (await isPaused()) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "paused",
      provider: "short-brasil",
    });
    return { processed: 0, paused: true };
  }
  const deferTo = await deferIfOutsideWindow();
  if (deferTo) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "outside_window",
      provider: "short-brasil",
    });
    return { processed: 0, deferred_until: deferTo };
  }

  // Cadência: NÃO consome budget ainda — só checa backoff.
  // O budget é consumido depois do planning, em cima do número real de SMS
  // que vão ser disparados (evita queimar minuto inteiro com leads em delay).
  const rate = await getRateState(channel);
  const inBackoff = !!(rate?.backoff_until && new Date(rate.backoff_until).getTime() > Date.now());
  if (inBackoff) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "rate_limited",
      target_rate: rate?.target_per_minute ?? null,
      provider: "short-brasil",
      last_provider_error: rate?.last_provider_error ?? null,
    });
    return { processed: 0, throttled: true };
  }
  // SMS provider circuit breaker (global): while the provider refuses the
  // account nothing is claimed, so no lead advances, fails or burns attempts.
  const breakerHolder = `sms-flow:${crypto.randomUUID()}`;
  const smsGate = await acquireSmsSendGate(breakerHolder);
  if (smsGate.mode === "open") {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "provider_unavailable",
      provider: "short-brasil",
      last_provider_error: smsSuspendedMessage(smsGate.snapshot),
    });
    return { processed: 0, providerUnavailable: true };
  }
  try {
    return await runSmsFlowBatch({ limit, startedAt, queueBefore, rate, smsGate });
  } finally {
    // Probe taken but no provider verdict (e.g. only delays were due): hand it back.
    if (smsGate.mode === "probe") await releaseSmsProbe(breakerHolder);
  }
}

async function runSmsFlowBatch({
  limit,
  startedAt,
  queueBefore,
  rate,
  smsGate,
}: {
  limit: number;
  startedAt: number;
  queueBefore: number;
  rate: Awaited<ReturnType<typeof getRateState>>;
  smsGate: SmsSendGate;
}) {
  const channel = "sms" as const;
  // Half-open: exactly one lead is claimed; its send is the probe.
  const effectiveLimit =
    smsGate.mode === "probe" ? 1 : Math.max(1, Math.min(limit, rate?.max_per_minute ?? 5000));

  // Claim atômico: reserva leads via FOR UPDATE SKIP LOCKED — seguro pra rodar
  // em paralelo (vários workers do cron) sem enviar SMS duplicado.
  const { data: leads, error: claimErr } = await supabaseAdmin.rpc("claim_sms_flow_leads", {
    p_limit: effectiveLimit,
  });
  if (claimErr) {
    console.error("[sms-dispatcher] claim falhou", claimErr);
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: `claim_error: ${claimErr.message.slice(0, 200)}`,
      provider: "short-brasil",
    });
    return { processed: 0, error: claimErr.message };
  }

  const all = (leads ?? []) as Lead[];
  if (all.length === 0) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      claimed: 0,
      stop_reason: "queue_empty",
      target_rate: rate?.target_per_minute ?? null,
      provider: "short-brasil",
    });
    return { processed: 0 };
  }

  // ============ FASE 1: preparar (leitura) ============
  // Carrega flows e steps únicos em batch, sem 1 query por lead.
  const flowIds = Array.from(new Set(all.map((l) => l.flow_id)));
  const playerIds = Array.from(
    new Set(all.map((l) => l.player_id).filter((v): v is string => !!v)),
  );

  const [{ data: flowsData }, { data: stepsData }, { data: playersData }] = await Promise.all([
    supabaseAdmin
      .from("sms_flows")
      .select(
        "id, is_active, exit_conditions, trigger_name, randomize_templates, daily_limit, cooldown_hours",
      )
      .in("id", flowIds),
    supabaseAdmin
      .from("sms_flow_steps")
      .select("*")
      .in("flow_id", flowIds)
      .order("order_index", { ascending: true }),
    playerIds.length > 0
      ? supabaseAdmin
          .from("players")
          .select(
            "id, nome, telefone, email, player_external_id, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco, ftd_em, last_cashback_paid_at, last_cashback_amount, last_cashback_sms_template_sent",
          )
          .in("id", playerIds)
      : Promise.resolve({ data: [] as Array<{ id: string }> } as {
          data: Array<Record<string, unknown>>;
        }),
  ]);

  const flows = new Map(
    (flowsData ?? []).map((f) => [f.id as string, f as Record<string, unknown>]),
  );
  const stepsByFlow = new Map<string, Step[]>();
  for (const s of (stepsData ?? []) as Step[]) {
    if (!stepsByFlow.has(s.flow_id)) stepsByFlow.set(s.flow_id, []);
    stepsByFlow.get(s.flow_id)!.push(s);
  }
  const players = new Map(
    (playersData ?? []).map((p) => [p.id as string, p as Record<string, unknown>]),
  );

  type Prepared = {
    lead: Lead;
    flow: Record<string, unknown>;
    step: Step;
    stepList: Step[];
    content: string;
    nextRunAt: string;
    finished: boolean;
    triggerName: string | null;
    stepIndex: number;
    stepLabel: string;
    /** Quando definido, após o envio o dispatcher atualiza
     *  players.last_cashback_sms_template_sent = rotateStepOrder. */
    rotateStepOrder?: number;
  };

  const toSend: Prepared[] = [];
  const exitedIds: { id: string; reason: string }[] = [];
  const delayUpdates: { id: string; nextIdx: number; nextRun: string }[] = [];
  const completedIds: string[] = [];

  for (const l of all) {
    const flow = flows.get(l.flow_id);
    if (!flow || !flow.is_active) {
      exitedIds.push({ id: l.id, reason: "flow_inactive" });
      continue;
    }
    const exit = (flow.exit_conditions as ExitConditions) ?? {};
    const p = l.player_id ? players.get(l.player_id) : null;
    if (p && (exit.login || exit.deposit || exit.first_deposit || exit.voltou_jogar)) {
      const since = new Date(l.entered_at).getTime();
      const pr = p as Record<string, string | null>;
      let reason: string | null = null;
      const lastActIn = Math.max(
        pr.ultimo_login ? new Date(pr.ultimo_login).getTime() : 0,
        pr.ultimo_jogo ? new Date(pr.ultimo_jogo).getTime() : 0,
        pr.ultimo_deposito ? new Date(pr.ultimo_deposito).getTime() : 0,
      );
      if (exit.login && lastActIn > since) reason = "login";
      else if (exit.deposit && pr.ultimo_deposito && new Date(pr.ultimo_deposito).getTime() > since)
        reason = "deposit";
      else if (exit.first_deposit && pr.ftd_em && new Date(pr.ftd_em).getTime() > since)
        reason = "first_deposit";
      else if (exit.voltou_jogar && pr.ultimo_jogo && new Date(pr.ultimo_jogo).getTime() > since)
        reason = "voltou_jogar";
      if (reason) {
        exitedIds.push({ id: l.id, reason });
        continue;
      }
    }

    const stepList = stepsByFlow.get(l.flow_id) ?? [];
    const isRotate = !!flow.randomize_templates;
    let step: Step | undefined;
    let rotateStepOrder: number | undefined;
    let forceFinished = false;
    if (isRotate) {
      // Modo rotação: ignora current_step_index e escolhe a próxima
      // mensagem do conjunto baseado no contador do player. Sempre
      // marca como finished (1 SMS por enrollment).
      const smsSteps = stepList.filter((s) => s.step_type === "sms" && s.is_active && s.content);
      if (smsSteps.length === 0) {
        completedIds.push(l.id);
        continue;
      }
      const lastOrder = Number(
        (p as Record<string, unknown> | null)?.last_cashback_sms_template_sent ?? -1,
      );
      const lastPos = smsSteps.findIndex((s) => s.order_index === lastOrder);
      const nextPos = (lastPos + 1) % smsSteps.length;
      step = smsSteps[nextPos];
      rotateStepOrder = step.order_index;
      forceFinished = true;
    } else {
      step = stepList[l.current_step_index];
    }
    if (!step) {
      completedIds.push(l.id);
      continue;
    }
    if (step.step_type === "delay") {
      delayUpdates.push({
        id: l.id,
        nextIdx: l.current_step_index + 1,
        nextRun: new Date(Date.now() + delayMs(step)).toISOString(),
      });
      continue;
    }
    if (step.step_type === "sms" && step.content) {
      let content = step.content;
      if (p) {
        const vars = buildPlayerVariables(p) as Record<string, string>;
        content = renderTemplate(content, vars);
      }
      const next = stepList[l.current_step_index + 1];
      const nextDelayMs = next && next.step_type === "delay" ? delayMs(next) : 0;
      // Agendamento fixo (CRM_EXPERT): se o próximo SMS tem horário definido,
      // ele manda. Senão cai no comportamento clássico de delay_days.
      let nextRunAt = new Date(Date.now() + nextDelayMs).toISOString();
      if (
        next &&
        next.step_type === "sms" &&
        next.scheduled_time &&
        typeof next.scheduled_day_offset === "number"
      ) {
        const sched = brtScheduledAt(l.entered_at, next.scheduled_day_offset, next.scheduled_time);
        if (sched) nextRunAt = sched;
      }
      // "Dia N" = 1 + soma dos delay_days dos steps anteriores
      let dayN = 1;
      for (let i = 0; i < l.current_step_index; i++) {
        const s = stepList[i];
        if (s && s.step_type === "delay") dayN += s.delay_days || 0;
      }
      // Quando o passo atual usa scheduled_day_offset, dayN = offset+1
      if (typeof step.scheduled_day_offset === "number") {
        dayN = step.scheduled_day_offset + 1;
      }
      toSend.push({
        lead: l,
        flow,
        step,
        stepList,
        content,
        nextRunAt,
        finished: forceFinished || l.current_step_index + 1 >= stepList.length,
        triggerName: (flow.trigger_name as string | null) ?? null,
        stepIndex: l.current_step_index,
        stepLabel: isRotate ? `Template #${(rotateStepOrder ?? 0) + 1}` : `Dia ${dayN}`,
        rotateStepOrder,
      });
    }
  }

  // ============ FASE 2: aplicar updates de saída/delay/completed ============
  await Promise.allSettled([
    ...exitedIds.map((e) =>
      supabaseAdmin
        .from("sms_flow_leads")
        .update({
          status: "exited",
          exit_reason: e.reason,
          updated_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
        })
        .eq("id", e.id),
    ),
    ...(completedIds.length > 0
      ? [
          supabaseAdmin
            .from("sms_flow_leads")
            .update({ status: "completed", locked_at: null, locked_by: null })
            .in("id", completedIds),
        ]
      : []),
    ...delayUpdates.map((d) =>
      supabaseAdmin
        .from("sms_flow_leads")
        .update({
          current_step_index: d.nextIdx,
          next_run_at: d.nextRun,
          locked_at: null,
          locked_by: null,
        })
        .eq("id", d.id),
    ),
  ]);

  if (toSend.length === 0) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      claimed: all.length,
      stop_reason: "nothing_to_send",
      target_rate: rate?.target_per_minute ?? null,
      provider: "short-brasil",
    });
    return { processed: 0 };
  }

  // Consome budget só agora (depois de saber quantos SMS realmente vão sair).
  // Se o teto do minuto não couber tudo, refileira o excedente sem perder.
  const allowed = [] as typeof toSend;
  for (const item of toSend) {
    const dailyLimit = Number(item.flow.daily_limit ?? 500);
    const cooldownHours = Number(item.flow.cooldown_hours ?? 24);
    const { data: latest } = await (item.lead.player_id && cooldownHours > 0
      ? supabaseAdmin
          .from("sms_send_logs")
          .select("created_at")
          .eq("tenant_id", item.lead.tenant_id)
          .eq("flow_id", item.lead.flow_id)
          .eq("player_id", item.lead.player_id)
          .eq("status", "sent")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }));
    const cooldownUntil = latest?.created_at
      ? new Date(new Date(latest.created_at).getTime() + cooldownHours * 3_600_000)
      : null;
    if (cooldownUntil && cooldownUntil.getTime() > Date.now()) {
      await supabaseAdmin
        .from("sms_flow_leads")
        .update({
          next_run_at: cooldownUntil.toISOString(),
          locked_at: null,
          locked_by: null,
        })
        .eq("id", item.lead.id);
      continue;
    }
    const { data: reserved, error: reserveError } = await supabaseAdmin.rpc(
      "reserve_sms_flow_daily_slot",
      {
        _tenant: item.lead.tenant_id,
        _flow: item.lead.flow_id,
        _daily_limit: dailyLimit,
      },
    );
    if (reserveError || !reserved) {
      await supabaseAdmin
        .from("sms_flow_leads")
        .update({
          next_run_at: new Date(
            brtDayStart(new Date(Date.now() + 86_400_000)).getTime(),
          ).toISOString(),
          locked_at: null,
          locked_by: null,
        })
        .eq("id", item.lead.id);
      continue;
    }
    allowed.push(item);
  }
  toSend.splice(0, toSend.length, ...allowed);
  if (toSend.length === 0) return { processed: 0, deferred: true };

  const budget = await consumeBudget(channel, toSend.length);
  if (budget === 0) {
    // Sem budget: devolve todos pra fila com um pequeno backoff.
    await Promise.allSettled(
      toSend.map((it) =>
        supabaseAdmin
          .from("sms_flow_leads")
          .update({
            next_run_at: new Date(Date.now() + 10_000).toISOString(),
            locked_at: null,
            locked_by: null,
          })
          .eq("id", it.lead.id),
      ),
    );
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      claimed: all.length,
      stop_reason: "throttled_by_minute_cap",
      target_rate: rate?.target_per_minute ?? null,
      provider: "short-brasil",
    });
    return { processed: 0, throttled: true };
  }
  const overflow = toSend.slice(budget);
  const sendNow = toSend.slice(0, budget);
  if (overflow.length > 0) {
    await Promise.allSettled(
      overflow.map((it) =>
        supabaseAdmin
          .from("sms_flow_leads")
          .update({
            next_run_at: new Date(Date.now() + 5_000).toISOString(),
            locked_at: null,
            locked_by: null,
          })
          .eq("id", it.lead.id),
      ),
    );
  }

  // ============ FASE 3: envia em paralelo (pool reduzido) ============
  // Pool de 10 = suficiente para a cadência <=70/min sem rajada que dispara
  // 429 na Short Brasil. Quando o provedor responde 429, registra throttle
  // global (backoff) e reagenda os pendentes do tick.
  let processed = 0;
  let errors = 0;
  let rescheduled = 0;
  let rateLimited = 0;
  let lastProviderError: string | null = null;
  let providerDown = false;
  const holdLead = (leadId: string, nextRunAt?: string) =>
    supabaseAdmin
      .from("sms_flow_leads")
      .update({
        ...(nextRunAt ? { next_run_at: nextRunAt } : {}),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", leadId);
  await runPool(sendNow, 10, async (item) => {
    if (providerDown) {
      // Breaker opened during this tick: give the lead back untouched.
      await holdLead(item.lead.id);
      rescheduled++;
      return;
    }
    const nowIso = new Date().toISOString();
    // Idempotência anti-duplicação: se já enviamos esse mesmo conteúdo
    // para esse mesmo telefone com sucesso nos últimos 30 minutos, não
    // dispara de novo — avança o lead como se tivesse enviado.
    const dedupeSince = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: recentDup } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id")
      .eq("tenant_id", item.lead.tenant_id)
      .eq("to_phone", item.lead.phone_e164)
      .eq("content", item.content)
      .eq("status", "sent")
      .gte("created_at", dedupeSince)
      .limit(1);
    if (recentDup && recentDup.length > 0) {
      const nextIdx = item.lead.current_step_index + 1;
      await supabaseAdmin
        .from("sms_flow_leads")
        .update({
          current_step_index: nextIdx,
          next_run_at: item.nextRunAt,
          last_sent_at: nowIso,
          locked_at: null,
          locked_by: null,
          status: item.finished ? "completed" : "pending",
        })
        .eq("id", item.lead.id);
      if (item.rotateStepOrder !== undefined && item.lead.player_id) {
        await supabaseAdmin
          .from("players")
          .update({ last_cashback_sms_template_sent: item.rotateStepOrder })
          .eq("id", item.lead.player_id);
      }
      processed++;
      return;
    }
    const r = await sendSmsInternal({
      to: item.lead.phone_e164,
      content: item.content,
      playerId: item.lead.player_id,
      flowId: item.lead.flow_id,
      triggerName: item.triggerName,
      stepIndex: item.stepIndex,
      stepLabel: item.stepLabel,
      flowLeadId: item.lead.id,
      tenantId: item.lead.tenant_id,
      linkTrackingEnabled: item.step.track_links !== false,
    });
    if (r.ok) {
      const nextIdx = item.lead.current_step_index + 1;
      await supabaseAdmin
        .from("sms_flow_leads")
        .update({
          current_step_index: nextIdx,
          next_run_at: item.nextRunAt,
          last_sent_at: nowIso,
          locked_at: null,
          locked_by: null,
          status: item.finished ? "completed" : "pending",
        })
        .eq("id", item.lead.id);
      if (item.rotateStepOrder !== undefined && item.lead.player_id) {
        await supabaseAdmin
          .from("players")
          .update({ last_cashback_sms_template_sent: item.rotateStepOrder })
          .eq("id", item.lead.player_id);
      }
      processed++;
    } else if ((r as { errorKind?: unknown }).errorKind === "provider_account") {
      // Account refused (101/505, 401/402/403): not the lead's fault. Same
      // step, attempts unchanged, back when the breaker allows a new try.
      providerDown = true;
      lastProviderError = `provider_account: ${(r as { error?: string }).error ?? ""}`.slice(
        0,
        800,
      );
      await holdLead(item.lead.id, breakerRetryAt(cachedSmsBreaker(), PROVIDER_ACCOUNT_DEFER_MS));
      rescheduled++;
    } else {
      const status = r.status ?? 0;
      const isAuthError = status === 401 || status === 403;
      const insufficient = isInsufficientFunds(status, (r as { body?: unknown }).body);
      const transient =
        status === 0 || status >= 500 || status === 429 || isAuthError || insufficient;
      const bodySnippet =
        typeof (r as { body?: unknown }).body === "string"
          ? String((r as { body?: unknown }).body)
          : JSON.stringify((r as { body?: unknown }).body ?? {}).slice(0, 400);
      lastProviderError = `status=${status} ${bodySnippet}`.slice(0, 800);

      // 429 / rate limit: registra throttle global para desacelerar próximos ticks.
      if (status === 429) {
        rateLimited++;
        const retryAfter = parseRetryAfter((r as { body?: unknown }).body);
        await registerThrottle("sms", retryAfter, lastProviderError);
      }

      // Auth error (token inválido/expirado): pausa o canal por 10 min e
      // mantém o lead na fila. NÃO incrementa attempts pra não acabar a fila.
      if (isAuthError) {
        await registerThrottle("sms", 600, `auth_error_${status}: ${lastProviderError}`);
      }

      // Sem saldo na Short Brasil: pausa o canal de SMS pra todos os tenants
      // e reagenda o lead. Sem isso, o motor queimaria toda a fila como "failed".
      if (insufficient) {
        await pauseChannelForInsufficientFunds("sms", lastProviderError);
        await registerThrottle("sms", 1800, `insufficient_funds: ${lastProviderError}`);
      }

      const MAX_ATTEMPTS = 5;
      if (transient && (isAuthError || insufficient || item.lead.attempts + 1 < MAX_ATTEMPTS)) {
        // Sem saldo: NÃO toca em next_run_at nem em attempts. O canal já foi
        // pausado em dispatch_pause_state — o claim ignora leads do canal
        // pausado. Quando a recarga acontecer e o canal for despausado, o lead
        // volta a ser elegível no MESMO horário original (sem burst no início
        // do dia). O rate cap absorve o backlog naturalmente.
        if (insufficient) {
          await supabaseAdmin
            .from("sms_flow_leads")
            .update({ locked_at: null, locked_by: null })
            .eq("id", item.lead.id);
        } else {
          const backoffMs = isAuthError ? 600_000 : status === 429 ? 60_000 : 30_000;
          await supabaseAdmin
            .from("sms_flow_leads")
            .update({
              attempts: status === 429 || isAuthError ? item.lead.attempts : item.lead.attempts + 1,
              next_run_at: new Date(Date.now() + backoffMs).toISOString(),
              locked_at: null,
              locked_by: null,
            })
            .eq("id", item.lead.id);
        }
        rescheduled++;
      } else {
        await supabaseAdmin
          .from("sms_flow_leads")
          .update({
            attempts: item.lead.attempts + 1,
            status: "failed",
            exit_reason: `send_failed_${status}`,
            locked_at: null,
            locked_by: null,
          })
          .eq("id", item.lead.id);
        errors++;
      }
    }
  });
  await recordRun(startedAt, {
    channel,
    queue_before: queueBefore,
    claimed: all.length,
    sent: processed,
    errors,
    rescheduled,
    rate_limited: rateLimited,
    target_rate: rate?.target_per_minute ?? null,
    actual_rate: processed,
    stop_reason: providerDown
      ? "provider_unavailable"
      : rateLimited > 0
        ? "provider_rate_limited"
        : "ok",
    provider: "short-brasil",
    last_provider_error: lastProviderError,
  });
  return {
    processed,
    errors,
    rescheduled,
    rate_limited: rateLimited,
    providerUnavailable: providerDown,
  };
}

// ============================================================
// Dispatcher de CAMPANHAS de SMS agendadas (envio em massa programado).
// Reserva campanhas com scheduled_at <= now via claim_due_sms_campaigns e
// processa cada uma com processSmsCampaignTick (sms-campaign-dispatch.server):
// destinatários sem cadastro são pulados e reportados (ENV-06), a cota por
// tick segue o ritmo configurado na cadência real do cron (ENV-07) e o cursor
// só avança depois do envio registrado. Fora da janela de envio, não roda.
// ============================================================

/**
 * ENV-07/ENV-04 — ponto único do rate limit das campanhas de SMS.
 *
 * Retorna quantos envios (0..want) esta campanha pode fazer agora:
 * 1. budget por canal/tenant (`channel_rate_limits`, token bucket no banco,
 *    padrão SMS 15/s global e 5/s por tenant, burst 15). Espera no máximo
 *    CAMPAIGN_BUDGET_MAX_WAIT_MS acumulando tokens e devolve o que conseguiu:
 *    uma concessão parcial NÃO encerra o tick — processSmsCampaignTick envia o
 *    concedido e volta a pedir até o prazo da execução (45 s) ou a cota, então
 *    o próprio loop dita o ritmo (~5/s sustentado por tenant ≈ 225–240 por
 *    execução).
 * 2. teto global legado (`dispatch_rate_state`), que mantém o backoff após
 *    429 do provedor.
 * Se o limitador novo ainda não existir no banco (migration pendente), cai no
 * comportamento anterior em vez de bloquear todas as campanhas.
 */
const CAMPAIGN_BUDGET_MAX_WAIT_MS = 1_500;

export async function acquireCampaignSendBudget(tenantId: string, want: number): Promise<number> {
  if (want <= 0) return 0;
  const deadline = Date.now() + CAMPAIGN_BUDGET_MAX_WAIT_MS;
  let granted = 0;
  while (granted < want) {
    const grant = await channelBudget.consume(tenantId, "sms", want - granted);
    if (grant.limitedBy === "error") {
      // Limitador indisponível (ex.: migration ainda não aplicada).
      return granted + (await consumeBudget("sms", want - granted));
    }
    granted += grant.granted;
    if (granted >= want) break;
    const waitMs = Math.max(200, grant.retryAfterMs || 1000);
    if (Date.now() + waitMs > deadline) break;
    await sleep(waitMs);
  }
  if (granted <= 0) return 0;
  return Math.min(granted, await consumeBudget("sms", granted));
}

const campaignDb = supabaseAdmin as unknown as CampaignDb;

function campaignDeps(): CampaignDispatchDeps {
  return {
    now: () => Date.now(),
    resolveRecipients: (tenantId, inputs) =>
      resolveCampaignRecipients(campaignDb, tenantId, inputs),
    async updateCampaign(campaign, patch) {
      let query = campaignDb.from("sms_campaigns").update(patch).eq("id", campaign.id);
      // Só grava enquanto este worker detém o lock da campanha.
      if (campaign.locked_by) query = query.eq("locked_by", campaign.locked_by);
      const { data, error } = await query.select("id");
      if (error) {
        console.error("[sms-campaigns] falha ao atualizar campanha", {
          campaignId: campaign.id,
          error: error.message,
        });
        return false;
      }
      return Array.isArray(data) && data.length > 0;
    },
    async persistUnresolved(campaignId, unresolved) {
      await persistCampaignUnresolved(campaignDb, campaignId, unresolved);
    },
    acquireSendBudget: acquireCampaignSendBudget,
    findAcceptedDeliveryKeys: (keys) => findAcceptedDeliveryKeys(campaignDb, keys),
    async loadPlayerVariables(playerIds) {
      const vars = new Map<string, Record<string, string>>();
      for (let i = 0; i < playerIds.length; i += 300) {
        const { data: players } = await supabaseAdmin
          .from("players")
          .select(
            "id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
          )
          .in("id", playerIds.slice(i, i + 300));
        (players ?? []).forEach((p) => vars.set(p.id, buildPlayerVariables(p)));
      }
      return vars;
    },
    async send({ campaign, target, deliveryKey, variables }) {
      const r = await sendSmsInternal({
        to: target.phone,
        content: campaign.content,
        playerId: target.playerId,
        triggerName: `campanha:${campaign.name}:${campaign.route}`,
        variables,
        tenantId: campaign.tenant_id,
        linkTrackingEnabled: campaign.track_links !== false,
        linkTrackingOrigin: { sourceType: "campaign", sourceId: campaign.id },
        deliveryKey,
      });
      const providerAccount =
        !r.ok && (r as { errorKind?: unknown }).errorKind === "provider_account";
      return {
        ok: r.ok,
        alreadySent: "alreadySent" in r && r.alreadySent === true,
        // Account refused (101/505...): nothing sent, credit refunded; the tick
        // stops before this recipient and resends it later (same key).
        retryable: providerAccount,
        providerAccount,
        error: r.ok ? undefined : (r as { error?: string }).error,
      };
    },
    // ENV-10: one Short Brasil bulk request per batch (personalised text and
    // tracked links per recipient). Off unless SMS_BULK_ENABLED=true (QA B1);
    // the Bearer API keeps the per-recipient path.
    ...(smsBulkEnabled() && smsBulkTransport() === "short-brasil-bulk"
      ? {
          async sendBatch({ campaign, items }) {
            const { outcomes } = await sendSmsBatch(
              items.map((it) => ({
                tenantId: campaign.tenant_id,
                to: it.target.phone,
                content: renderSmsVariables(campaign.content, it.variables),
                deliveryKey: it.deliveryKey,
                playerId: it.target.playerId,
                triggerName: `campanha:${campaign.name}:${campaign.route}`,
                linkTrackingEnabled: campaign.track_links !== false,
                linkTrackingOrigin: { sourceType: "campaign" as const, sourceId: campaign.id },
              })),
            );
            // 101/505 (no balance/auth) are reported to the SMS provider
            // breaker by sendSmsBatch; no extra 30-min throttle here, so the
            // half-open probe can resume sends right after a recharge.
            return outcomes.map((o) => ({
              ok: o.ok,
              alreadySent: o.status === "already_sent",
              pendingConfirmation: o.status === "pending_confirmation",
              retryable: o.retryable,
              providerAccount: o.errorKind === "provider_account",
              error: o.ok && o.status !== "pending_confirmation" ? undefined : o.error,
            }));
          },
        }
      : {}),
  };
}

/** QA I2: reconcile stale bulk write-ahead rows at most every 5 min per process. */
const BULK_RECONCILE_EVERY_MS = 5 * 60_000;
let lastBulkReconcileAt = 0;

async function maybeReconcileBulkSubmissions() {
  if (!smsBulkEnabled() || Date.now() - lastBulkReconcileAt < BULK_RECONCILE_EVERY_MS) return;
  lastBulkReconcileAt = Date.now();
  try {
    await reconcileStaleSubmittingLogs();
  } catch (error) {
    console.error("[sms-campaigns] reconciliação de envios em lote falhou", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runScheduledSmsCampaigns({ limit = 20 }: { limit?: number } = {}) {
  await maybeReconcileBulkSubmissions();
  // Fora da janela → deixa pra próximo tick (idem outros canais).
  const deferTo = await deferIfOutsideWindow();
  if (deferTo) {
    // Idle ticks only prove liveness; they do not write dispatcher_runs rows.
    void pingHeartbeat(SMS_CAMPAIGN_JOB, true);
    return { processed: 0, deferred_until: deferTo };
  }

  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("claim_due_sms_campaigns", {
    p_limit: limit,
  });
  if (claimErr) {
    console.error("[sms-campaigns] claim falhou", claimErr);
    const failedRun = await startJobRun(SMS_CAMPAIGN_JOB, { channel: "sms", kind: "campaign" });
    await failedRun.fail(new Error(`claim_due_sms_campaigns: ${claimErr.message}`), {
      provider: "short-brasil",
    });
    return { processed: 0, error: claimErr.message };
  }
  const campaigns = (claimed ?? []) as unknown as SmsCampaignRow[];
  if (campaigns.length === 0) {
    void pingHeartbeat(SMS_CAMPAIGN_JOB, true);
    return { processed: 0 };
  }

  const run = await startJobRun(SMS_CAMPAIGN_JOB, {
    channel: "sms",
    kind: "campaign",
    provider: "short-brasil",
  });
  run.progress({ queue_before: campaigns.length, claimed: campaigns.length });
  try {
    const result = await dispatchClaimedSmsCampaigns(campaigns, run);
    await run.finish({
      queue_before: campaigns.length,
      claimed: campaigns.length,
      sent: result.sent,
      errors: result.failed,
      stop_reason: result.failed > 0 ? "errors" : result.stop_reason,
    });
    return result;
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

async function dispatchClaimedSmsCampaigns(campaigns: SmsCampaignRow[], run: JobRunHandle) {
  // Um único orçamento de tempo por execução (cron 1×/min), compartilhado pelas
  // campanhas reservadas; as que não couberem só têm o lock liberado.
  const deadline = Date.now() + SMS_CAMPAIGN_RUN_BUDGET_MS;
  const breakerHolder = `sms-campaign:${crypto.randomUUID()}`;
  const gate = createCampaignProviderGate(breakerHolder);
  const deps = { ...campaignDeps(), providerGate: gate.next };
  let totalSent = 0;
  let totalFailed = 0;
  let totalDeduplicated = 0;
  let stopReason = "ok";
  for (const c of campaigns) {
    if (Date.now() >= deadline) {
      stopReason = "deadline";
      await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
      continue;
    }
    try {
      const r = await processSmsCampaignTick(c, deps, {
        deadline,
        tickSeconds: SMS_CAMPAIGN_TICK_SECONDS,
      });
      totalSent += r.sent;
      totalFailed += r.failed;
      totalDeduplicated += r.deduplicated;
      if (
        r.stopReason === "deadline" ||
        r.stopReason === "budget" ||
        r.stopReason === "provider_unavailable"
      )
        stopReason = r.stopReason;
    } catch (error) {
      console.error("[sms-campaigns] falha ao processar campanha", {
        campaignId: c.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await deps.updateCampaign(c, {
        status: "enviando",
        last_error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        locked_at: null,
        locked_by: null,
      });
    }
    run.progress({ sent: totalSent, errors: totalFailed });
  }

  await gate.finish();
  return {
    processed: campaigns.length,
    sent: totalSent,
    failed: totalFailed,
    deduplicated: totalDeduplicated,
    stop_reason: stopReason,
  };
}

/**
 * Campaign view of the SMS provider breaker for one dispatcher run. The first
 * call asks the breaker (may get the half-open probe: ONE send); later calls
 * use the cached state (refreshed every few seconds), so a run that sees the
 * breaker open stops each campaign before its next batch without moving the
 * cursor.
 */
export function createCampaignProviderGate(holder: string) {
  let decision: SmsSendGate | null = null;
  let probeGiven = false;
  let heldProbe = false;
  return {
    async next(): Promise<ProviderGateDecision> {
      if (!decision) {
        decision = await acquireSmsSendGate(holder);
      } else {
        const snapshot = await readSmsBreaker();
        if (snapshot.state === "closed") decision = { mode: "closed" };
        else if (decision.mode === "closed" || probeGiven) decision = { mode: "open", snapshot };
      }
      if (decision.mode === "closed") return { mode: "closed" };
      if (decision.mode === "probe" && !probeGiven) {
        probeGiven = true;
        heldProbe = true;
        return { mode: "probe" };
      }
      const snapshot = decision.mode === "open" ? decision.snapshot : cachedSmsBreaker();
      return { mode: "open", message: smsSuspendedMessage(snapshot) };
    },
    async finish() {
      // No-op unless the breaker is still half-open with this holder (no verdict).
      if (heldProbe) await releaseSmsProbe(holder);
    },
  };
}
