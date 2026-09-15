// Dispatcher dos fluxos de SMS. Avança uma etapa por execução, respeita
// delay_days, exit conditions e limite diário global.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendSmsInternal } from "./sms.functions";
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
import {
  isInsufficientFunds,
  pauseChannelForInsufficientFunds,
} from "./dispatch-pause-insufficient.server";

/**
 * Converte (entered_at, day_offset, "HH:MM") em instante UTC,
 * tratando o HH:MM como horário fixo America/Sao_Paulo (UTC-3).
 * Usado pelo modelo CRM_EXPERT para agendar SMS em horário exato.
 */
function brtScheduledAt(
  enteredAtIso: string,
  dayOffset: number,
  hhmm: string,
): string | null {
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
  is_active: boolean;
  scheduled_time?: string | null;
  scheduled_day_offset?: number | null;
};

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
  if (exit.deposit && p.ultimo_deposito && new Date(p.ultimo_deposito).getTime() > since) return "deposit";
  if (exit.first_deposit && p.ftd_em && new Date(p.ftd_em).getTime() > since) return "first_deposit";
  if (exit.voltou_jogar && p.ultimo_jogo && new Date(p.ultimo_jogo).getTime() > since) return "voltou_jogar";
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
      provider: "businesscode",
    });
    return { processed: 0, paused: true };
  }
  const deferTo = await deferIfOutsideWindow();
  if (deferTo) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "outside_window",
      provider: "businesscode",
    });
    return { processed: 0, deferred_until: deferTo };
  }

  // Cadência: NÃO consome budget ainda — só checa backoff.
  // O budget é consumido depois do planning, em cima do número real de SMS
  // que vão ser disparados (evita queimar minuto inteiro com leads em delay).
  const rate = await getRateState(channel);
  const inBackoff =
    !!(rate?.backoff_until && new Date(rate.backoff_until).getTime() > Date.now());
  if (inBackoff) {
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: "rate_limited",
      target_rate: rate?.target_per_minute ?? null,
      provider: "businesscode",
      last_provider_error: rate?.last_provider_error ?? null,
    });
    return { processed: 0, throttled: true };
  }
  const effectiveLimit = Math.max(1, Math.min(limit, rate?.max_per_minute ?? 5000));

  // Claim atômico: reserva leads via FOR UPDATE SKIP LOCKED — seguro pra rodar
  // em paralelo (vários workers do cron) sem enviar SMS duplicado.
  const { data: leads, error: claimErr } = await supabaseAdmin.rpc(
    "claim_sms_flow_leads",
    { p_limit: effectiveLimit },
  );
  if (claimErr) {
    console.error("[sms-dispatcher] claim falhou", claimErr);
    await recordRun(startedAt, {
      channel,
      queue_before: queueBefore,
      stop_reason: `claim_error: ${claimErr.message.slice(0, 200)}`,
      provider: "businesscode",
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
      provider: "businesscode",
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
      .select("id, is_active, exit_conditions, trigger_name, randomize_templates")
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
      : Promise.resolve({ data: [] as Array<{ id: string }> } as { data: Array<Record<string, unknown>> }),
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
      else if (exit.deposit && pr.ultimo_deposito && new Date(pr.ultimo_deposito).getTime() > since) reason = "deposit";
      else if (exit.first_deposit && pr.ftd_em && new Date(pr.ftd_em).getTime() > since) reason = "first_deposit";
      else if (exit.voltou_jogar && pr.ultimo_jogo && new Date(pr.ultimo_jogo).getTime() > since) reason = "voltou_jogar";
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
      const smsSteps = stepList.filter(
        (s) => s.step_type === "sms" && s.is_active && s.content,
      );
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
        nextRun: new Date(Date.now() + (step.delay_days || 0) * 86400000).toISOString(),
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
      const nextDelayDays = next && next.step_type === "delay" ? next.delay_days || 0 : 0;
      // Agendamento fixo (CRM_EXPERT): se o próximo SMS tem horário definido,
      // ele manda. Senão cai no comportamento clássico de delay_days.
      let nextRunAt = new Date(Date.now() + nextDelayDays * 86400000).toISOString();
      if (
        next &&
        next.step_type === "sms" &&
        next.scheduled_time &&
        typeof next.scheduled_day_offset === "number"
      ) {
        const sched = brtScheduledAt(
          l.entered_at,
          next.scheduled_day_offset,
          next.scheduled_time,
        );
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
        stepList,
        content,
        nextRunAt,
        finished: forceFinished || l.current_step_index + 1 >= stepList.length,
        triggerName: (flow.trigger_name as string | null) ?? null,
        stepIndex: l.current_step_index,
        stepLabel: isRotate
          ? `Template #${(rotateStepOrder ?? 0) + 1}`
          : `Dia ${dayN}`,
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
    ...completedIds.length > 0
      ? [
          supabaseAdmin
            .from("sms_flow_leads")
            .update({ status: "completed", locked_at: null, locked_by: null })
            .in("id", completedIds),
        ]
      : [],
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
      provider: "businesscode",
    });
    return { processed: 0 };
  }

  // Consome budget só agora (depois de saber quantos SMS realmente vão sair).
  // Se o teto do minuto não couber tudo, refileira o excedente sem perder.
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
      provider: "businesscode",
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
  // 429 na BusinessCode. Quando o provedor responde 429, registra throttle
  // global (backoff) e reagenda os pendentes do tick.
  let processed = 0;
  let errors = 0;
  let rescheduled = 0;
  let rateLimited = 0;
  let lastProviderError: string | null = null;
  await runPool(sendNow, 10, async (item) => {
    const nowIso = new Date().toISOString();
    // Idempotência anti-duplicação: se já enviamos esse mesmo conteúdo
    // para esse mesmo telefone com sucesso nos últimos 30 minutos, não
    // dispara de novo — avança o lead como se tivesse enviado.
    const dedupeSince = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: recentDup } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id")
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

      // Sem saldo na BusinessCode: pausa o canal de SMS pra todos os tenants
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
          const backoffMs = isAuthError
            ? 600_000
            : status === 429
              ? 60_000
              : 30_000;
          await supabaseAdmin
            .from("sms_flow_leads")
            .update({
              attempts:
                status === 429 || isAuthError
                  ? item.lead.attempts
                  : item.lead.attempts + 1,
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
    stop_reason: rateLimited > 0 ? "provider_rate_limited" : "ok",
    provider: "businesscode",
    last_provider_error: lastProviderError,
  });
  return { processed, errors, rescheduled, rate_limited: rateLimited };
}

// ============================================================
// Dispatcher de CAMPANHAS de SMS agendadas (envio em massa programado).
// Reserva campanhas com scheduled_at <= now via claim_due_sms_campaigns,
// envia cada destinatário reutilizando sendSmsInternal, e atualiza
// contadores/status. Respeita janela de envio; se fora da janela, apenas
// não roda nesse tick (as campanhas ficam agendadas para o próximo tick
// dentro da janela).
// ============================================================

type CampaignRow = {
  id: string;
  tenant_id: string;
  name: string;
  content: string;
  route: string;
  recipients: unknown;
  total_count: number;
  sent_count: number;
  failed_count: number;
  scheduled_at: string;
  sent_cursor: number;
  last_error: string | null;
  rate_per_minute: number | null;
};

type CampaignTarget = { phone: string; playerId?: string | null };

function parseCampaignTargets(raw: unknown): CampaignTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignTarget[] = [];
  for (const r of raw) {
    if (r && typeof r === "object" && typeof (r as { phone?: unknown }).phone === "string") {
      const phone = (r as { phone: string }).phone;
      const pid = (r as { playerId?: unknown }).playerId;
      out.push({
        phone,
        playerId: typeof pid === "string" ? pid : null,
      });
    }
  }
  return out;
}

export async function runScheduledSmsCampaigns({
  limit = 20,
}: { limit?: number } = {}) {
  // Fora da janela → deixa pra próximo tick (idem outros canais).
  const deferTo = await deferIfOutsideWindow();
  if (deferTo) return { processed: 0, deferred_until: deferTo };

  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
    "claim_due_sms_campaigns",
    { p_limit: limit },
  );
  if (claimErr) {
    console.error("[sms-campaigns] claim falhou", claimErr);
    return { processed: 0, error: claimErr.message };
  }
  const campaigns = (claimed ?? []) as CampaignRow[];
  if (campaigns.length === 0) return { processed: 0 };

  const { sendSmsInternal } = await import("./sms.functions");

  // O worker é chamado ~12x por minuto (a cada 5s). O lote de cada rodada é
  // derivado do ritmo escolhido na campanha (`rate_per_minute`), com um teto
  // por rodada para não estourar o tempo de execução do worker.
  const ROUNDS_PER_MINUTE = 12;
  const MAX_PER_ROUND = 700;
  const MIN_PER_ROUND = 50;
  const DEFAULT_RATE = 1000;

  function concurrencyForRate(rate: number): number {
    if (rate >= 4000) return 80;
    if (rate >= 2500) return 60;
    if (rate >= 1000) return 25;
    if (rate >= 300) return 10;
    return 5;
  }

  // Janela de deduplicação: se o mesmo telefone já recebeu o MESMO conteúdo
  // com sucesso nas últimas 6h, pula. Última linha de defesa contra
  // duplicações causadas por worker abortado antes de gravar o cursor.
  const DEDUPE_WINDOW_MS = 6 * 3600_000;

  let totalSent = 0;
  let totalFailed = 0;
  for (const c of campaigns) {
    const allTargets = parseCampaignTargets(c.recipients);
    if (allTargets.length === 0) {
      await supabaseAdmin
        .from("sms_campaigns")
        .update({
          status: "falhou",
          last_error: "Sem destinatários",
          locked_at: null,
          locked_by: null,
        })
        .eq("id", c.id);
      continue;
    }

    // Retoma de onde parou no último tick (0 se primeira execução).
    const cursor = Math.max(0, c.sent_cursor ?? 0);
    const remaining = allTargets.length - cursor;
    if (remaining <= 0) {
      // Já foi tudo enviado; só finaliza.
      await supabaseAdmin
        .from("sms_campaigns")
        .update({
          status: (c.failed_count ?? 0) > 0 && (c.sent_count ?? 0) === 0 ? "falhou" : "enviado",
          locked_at: null,
          locked_by: null,
        })
        .eq("id", c.id);
      continue;
    }
    const rate = Math.max(1, c.rate_per_minute ?? DEFAULT_RATE);
    const perRound = Math.min(
      MAX_PER_ROUND,
      Math.max(MIN_PER_ROUND, Math.ceil(rate / ROUNDS_PER_MINUTE)),
    );
    // Teto global do canal (token bucket por minuto). Se não houver budget,
    // libera o lock e tenta na próxima rodada.
    const budget = await consumeBudget("sms", Math.min(perRound, remaining));
    if (budget <= 0) {
      await supabaseAdmin
        .from("sms_campaigns")
        .update({ status: "enviando", locked_at: null, locked_by: null })
        .eq("id", c.id);
      continue;
    }
    const chunkSize = Math.min(budget, remaining);
    const targets = allTargets.slice(cursor, cursor + chunkSize);

    // RESERVA OTIMISTA: avança o cursor ANTES de enviar. Se o worker morrer no
    // meio do chunk, o próximo tick pula esses telefones — pior caso perde
    // envios (reagendáveis), nunca duplica (irreversível/caro).
    // Renova locked_at para segurar o lock durante o envio.
    const reservedCursor = cursor + targets.length;
    await supabaseAdmin
      .from("sms_campaigns")
      .update({
        sent_cursor: reservedCursor,
        locked_at: new Date().toISOString(),
      })
      .eq("id", c.id);

    // Carrega variáveis dos players em uma única query.
    const playerIds = Array.from(
      new Set(
        targets
          .map((t) => t.playerId)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    );
    const varsByPlayer = new Map<string, Record<string, string>>();
    if (playerIds.length > 0) {
      const { data: players } = await supabaseAdmin
        .from("players")
        .select(
          "id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
        )
        .in("id", playerIds);
      (players ?? []).forEach((p) => {
        varsByPlayer.set(p.id, buildPlayerVariables(p));
      });
    }

    let sent = 0;
    let failed = 0;
    let lastError: string | null = null;
    const trigger = `campanha:${c.name}:${c.route}`;
    const concurrency = concurrencyForRate(rate);
    const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    // Dedup em UMA query por chunk (antes era 1 query por SMS, o que limitava
    // muito o ritmo em lotes grandes).
    const dedupedPhones = new Set<string>();
    {
      const phones = Array.from(new Set(targets.map((t) => t.phone)));
      for (let i = 0; i < phones.length; i += 500) {
        const slice = phones.slice(i, i + 500);
        const { data: dups } = await supabaseAdmin
          .from("sms_send_logs")
          .select("to_phone")
          .eq("tenant_id", c.tenant_id)
          .eq("content", c.content)
          .eq("status", "sent")
          .gte("created_at", dedupeSince)
          .in("to_phone", slice);
        (dups ?? []).forEach((d) => {
          if (d.to_phone) dedupedPhones.add(d.to_phone);
        });
      }
    }
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (t) => {
          const variables = t.playerId ? varsByPlayer.get(t.playerId) ?? null : null;
          try {
            // Dedup por (tenant, telefone, conteúdo) nas últimas 6h.
            if (dedupedPhones.has(t.phone)) {
              return { ok: true as const, deduped: true };
            }
            const r = await sendSmsInternal({
              to: t.phone,
              content: c.content,
              playerId: t.playerId ?? null,
              triggerName: trigger,
              variables,
              tenantId: c.tenant_id,
            });
            return r;
          } catch (e) {
            return {
              ok: false as const,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }),
      );
      for (const r of results) {
        if (r.ok) sent++;
        else {
          failed++;
          const err = (r as { error?: string }).error;
          if (err) lastError = err;
        }
      }
    }

    totalSent += sent;
    totalFailed += failed;

    const newSent = (c.sent_count ?? 0) + sent;
    const newFailed = (c.failed_count ?? 0) + failed;
    const isDone = reservedCursor >= allTargets.length;
    const finalStatus = isDone
      ? (newSent === 0 ? "falhou" : "enviado")
      : "enviando";
    await supabaseAdmin
      .from("sms_campaigns")
      .update({
        status: finalStatus,
        sent_count: newSent,
        failed_count: newFailed,
        last_error: lastError ?? c.last_error ?? null,
        // Libera lock para o próximo tick continuar (quando não terminou).
        locked_at: null,
        locked_by: null,
      })
      .eq("id", c.id);
  }

  return {
    processed: campaigns.length,
    sent: totalSent,
    failed: totalFailed,
  };
}