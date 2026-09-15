// Engine sequencial dos Fluxos de Ligação (server-only).
// - enrollPlayerInFlow: matricula um player no fluxo (cria call_flow_progress)
// - tickFlows: processa todos os progressos prontos (next_run_at <= now)
// - advanceProgress: executa o bloco atual (call dispara ligação; delay agenda)
// - handleCallCompletion: callback do provedor → SMS condicional → próximo bloco
// - checkPlayerExitConditions: sai do fluxo em tempo real (login/deposit/etc.)

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  callElevenLabs,
  computeAudioHash,
  DEFAULT_VOICE_SETTINGS,
  defaultVoiceId,
  renderCallScript,
  uploadAudioToStorage,
  type LeadLike,
  type VoiceSettings,
} from "./calls.server";
import {
  callBusinessCodeVoice,
  normalizeE164BR,
} from "./businesscode-voice.server";
import { sendSmsInternal } from "./sms.functions";
import { buildPlayerVariables } from "./template-vars.server";
import { deferIfOutsideWindow } from "./send-window.server";

type Json = Record<string, unknown>;

async function logEvent(
  progressId: string | null,
  flowId: string,
  playerId: string | null,
  blockIndex: number | null,
  eventType: string,
  detail: Json = {},
) {
  try {
    await supabaseAdmin.from("call_flow_history").insert({
      progress_id: progressId,
      flow_id: flowId,
      player_id: playerId,
      block_index: blockIndex,
      event_type: eventType,
      detail: detail as any,
    });
  } catch (e) {
    console.error("[call-flow] falha ao registrar history", e);
  }
}

/** Matricula um player num fluxo. Idempotente: ignora se já está ativo. */
export async function enrollPlayerInFlow(
  flowId: string,
  playerId: string,
): Promise<{ ok: boolean; progressId?: string; skipped?: string }> {
  const { data: flow } = await supabaseAdmin
    .from("call_flows")
    .select("id, is_active")
    .eq("id", flowId)
    .maybeSingle();
  if (!flow || !flow.is_active) return { ok: false, skipped: "flow_inactive" };

  const { data: existing } = await supabaseAdmin
    .from("call_flow_progress")
    .select("id, status")
    .eq("flow_id", flowId)
    .eq("player_id", playerId)
    .in("status", ["active", "waiting"])
    .maybeSingle();
  if (existing) return { ok: true, progressId: existing.id, skipped: "already_enrolled" };

  const { data: player } = await supabaseAdmin
    .from("players")
    .select("id, telefone")
    .eq("id", playerId)
    .maybeSingle();

  const { data: inserted, error } = await supabaseAdmin
    .from("call_flow_progress")
    .insert({
      flow_id: flowId,
      player_id: playerId,
      phone_e164: player?.telefone ?? null,
      current_block_index: 0,
      attempts_on_block: 0,
      status: "active",
      next_run_at: new Date().toISOString(),
    } as any)
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await logEvent(inserted.id, flowId, playerId, 0, "enrolled");
  return { ok: true, progressId: inserted.id };
}

/** Cancela / encerra um progresso. */
export async function cancelProgress(progressId: string, reason: string) {
  const { data: prog } = await supabaseAdmin
    .from("call_flow_progress")
    .select("id, flow_id, player_id, current_block_index")
    .eq("id", progressId)
    .maybeSingle();
  if (!prog) return;
  await supabaseAdmin
    .from("call_flow_progress")
    .update({ status: "cancelled", exit_reason: reason } as any)
    .eq("id", progressId);
  await logEvent(
    prog.id,
    prog.flow_id,
    prog.player_id,
    prog.current_block_index,
    "cancelled",
    { reason },
  );
}

/** Verifica condições de saída em tempo real para um player. Chamado dos
 *  webhooks (login/deposit/bet) — sai do fluxo se a condição for atendida. */
export async function checkPlayerExitConditions(
  playerId: string,
  event: "login" | "deposit" | "first_deposit" | "bet" | "play",
  payload?: { deposit_amount?: number },
) {
  const { data: rows } = await supabaseAdmin
    .from("call_flow_progress")
    .select("id, flow_id, current_block_index, call_flows!inner(exit_conditions)")
    .eq("player_id", playerId)
    .in("status", ["active", "waiting"]);
  for (const r of rows ?? []) {
    const cond = ((r as any).call_flows?.exit_conditions ?? {}) as Json;
    let trigger = false;
    if (event === "login" && cond.login) trigger = true;
    if (event === "deposit" && cond.deposit) trigger = true;
    if (event === "first_deposit" && cond.first_deposit) trigger = true;
    if ((event === "bet" || event === "play") && cond.voltou_jogar) trigger = true;
    if (
      event === "deposit" &&
      typeof cond.deposit_amount_gte === "number" &&
      (payload?.deposit_amount ?? 0) >= (cond.deposit_amount_gte as number)
    )
      trigger = true;
    if (trigger) {
      await supabaseAdmin
        .from("call_flow_progress")
        .update({ status: "exited", exit_reason: event } as any)
        .eq("id", r.id);
      await logEvent(r.id, r.flow_id, playerId, r.current_block_index, "exited", {
        reason: event,
        ...payload,
      });
    }
  }
}

/** Carrega blocos do fluxo ordenados. */
async function loadBlocks(flowId: string) {
  const { data } = await supabaseAdmin
    .from("call_flow_blocks")
    .select("*, call_flow_block_sms(*)")
    .eq("flow_id", flowId)
    .order("order_index", { ascending: true });
  return data ?? [];
}

/** Dispara a ligação de um bloco call e atualiza o progresso. */
async function executeCallBlock(
  progress: any,
  block: any,
  player: any,
): Promise<void> {
  // 1. resolve roteiro + voz
  let scriptContent = "";
  let scriptId: string | null = block.script_id ?? null;
  let provider = "elevenlabs";
  let voiceId = block.voice_id || defaultVoiceId();
  let voiceSettings: VoiceSettings = DEFAULT_VOICE_SETTINGS;

  if (scriptId) {
    const { data: s } = await supabaseAdmin
      .from("call_scripts")
      .select("content, default_voice_id, provider, voice_settings")
      .eq("id", scriptId)
      .maybeSingle();
    if (s) {
      scriptContent = (s.content as string) ?? "";
      provider = (s.provider as string) || provider;
      if (!block.voice_id && s.default_voice_id) voiceId = s.default_voice_id as string;
      voiceSettings =
        (s.voice_settings as unknown as VoiceSettings) ?? DEFAULT_VOICE_SETTINGS;
    }
  }
  if (!scriptContent) {
    await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "call_skipped", {
      reason: "no_script",
    });
    await scheduleNext(progress, block);
    return;
  }

  const leadLike: LeadLike = {
    id: player?.id,
    nome: player?.nome,
    telefone: player?.telefone,
    saldo_carteira: player?.saldo_carteira,
    ultimo_login: player?.ultimo_login,
    ultimo_jogo: player?.ultimo_jogo,
    ultimo_deposito: player?.ultimo_deposito,
    total_depositado: player?.total_depositado,
    status: player?.status,
    expert: player?.expert,
    vip: player?.vip,
    risco: player?.risco,
  };
  const renderedText = renderCallScript(scriptContent, leadLike);
  const hash = computeAudioHash({
    rendered_text: renderedText,
    voice_id: voiceId,
    provider,
    voice_settings: voiceSettings,
  });

  // 2. áudio (cache)
  let audioUrl: string | null = null;
  let audioPath: string | null = null;
  const { data: cached } = await supabaseAdmin
    .from("call_audio_generations")
    .select("audio_url, audio_path")
    .eq("audio_hash", hash)
    .eq("generation_status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cached?.audio_url) {
    audioUrl = cached.audio_url;
    audioPath = cached.audio_path;
  } else {
    try {
      const buf = await callElevenLabs({ text: renderedText, voiceId, voiceSettings });
      const up = await uploadAudioToStorage(buf, hash);
      audioUrl = up.signedUrl;
      audioPath = up.path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "audio_error", { error: msg });
      // tenta de novo no próximo tick (1 min)
      await supabaseAdmin
        .from("call_flow_progress")
        .update({ next_run_at: new Date(Date.now() + 60_000).toISOString() } as any)
        .eq("id", progress.id);
      return;
    }
  }
  await supabaseAdmin.from("call_audio_generations").insert({
    lead_id: progress.player_id,
    script_id: scriptId,
    provider,
    voice_id: voiceId,
    original_text: scriptContent,
    rendered_text: renderedText,
    audio_url: audioUrl,
    audio_path: audioPath,
    audio_hash: hash,
    generation_status: "ready",
    voice_settings: voiceSettings as any,
  } as any);

  // 3. telefone
  const rawPhone = progress.phone_e164 || player?.telefone || "";
  if (!rawPhone || !audioUrl) {
    await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "call_skipped", { reason: "no_phone_or_audio" });
    await scheduleNext(progress, block);
    return;
  }
  let to: string;
  try {
    to = normalizeE164BR(rawPhone);
  } catch (e) {
    await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "call_skipped", {
      reason: "invalid_phone",
      error: e instanceof Error ? e.message : String(e),
    });
    await scheduleNext(progress, block);
    return;
  }

  // 4. dispara provedor
  const result = await callBusinessCodeVoice(to, audioUrl);
  const isAuthError = result.status === 401 || result.status === 403;
  if (isAuthError) {
    console.warn(
      `[call-flow] auth_error ${result.status} — mantendo lead na fila, retry em 10min`,
    );
  }

  // 5. registra histórico (linka com progress via provider_call_id)
  await supabaseAdmin.from("call_history").insert({
    lead_id: progress.player_id,
    script_id: scriptId,
    audio_url: audioUrl,
    status: result.ok ? ("pending" as any) : isAuthError ? ("pending" as any) : ("failed" as any),
    provider: "businesscode",
    provider_call_id: result.idempotencyKey || null,
    provider_response: (result.body ?? {}) as any,
    provider_status_code: result.status,
    to_phone: to,
    error_message: result.ok ? null : JSON.stringify(result.body).slice(0, 1000),
    rendered_text: renderedText,
  } as any);

  // 6. atualiza progress (aguardando callback do provedor)
  // Em auth error mantém o progress ATIVO e reagenda em 10min — nada some.
  await supabaseAdmin
    .from("call_flow_progress")
    .update({
      status: isAuthError ? "active" : "waiting",
      last_call_at: new Date().toISOString(),
      attempts_on_block: isAuthError
        ? progress.attempts_on_block ?? 0
        : (progress.attempts_on_block ?? 0) + 1,
      // se não chegar callback em 10min, o tick avança mesmo assim
      next_run_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      last_call_result: result.ok
        ? "dispatched"
        : isAuthError
          ? "auth_error_retry"
          : "dispatch_failed",
    } as any)
    .eq("id", progress.id);

  await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "call_dispatched", {
    ok: result.ok,
    provider_call_id: result.idempotencyKey,
    to,
  });
}

/** Agenda o próximo bloco (ou conclui o fluxo) após um bloco call/delay. */
async function scheduleNext(progress: any, currentBlock: any) {
  const blocks = await loadBlocks(progress.flow_id);
  const nextIdx = (progress.current_block_index ?? 0) + 1;
  const delaySec =
    currentBlock?.block_type === "delay"
      ? currentBlock.delay_seconds ?? 0
      : currentBlock?.delay_after_seconds ?? 0;

  if (nextIdx >= blocks.length) {
    await supabaseAdmin
      .from("call_flow_progress")
      .update({ status: "completed", exit_reason: "finished" } as any)
      .eq("id", progress.id);
    await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "completed");
    return;
  }
  await supabaseAdmin
    .from("call_flow_progress")
    .update({
      current_block_index: nextIdx,
      attempts_on_block: 0,
      status: "active",
      next_run_at: new Date(Date.now() + delaySec * 1000).toISOString(),
    } as any)
    .eq("id", progress.id);
  await logEvent(progress.id, progress.flow_id, progress.player_id, nextIdx, "advanced", {
    delay_seconds: delaySec,
  });
}

/** Carrega um player completo para variáveis. */
async function loadPlayer(playerId: string | null) {
  if (!playerId) return null;
  const { data } = await supabaseAdmin
    .from("players")
    .select(
      "id, nome, telefone, email, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, status, expert, vip, risco",
    )
    .eq("id", playerId)
    .maybeSingle();
  return data;
}

/** Avança um progress (executa o bloco corrente). */
export async function advanceProgress(progressId: string) {
  const { data: progress } = await supabaseAdmin
    .from("call_flow_progress")
    .select("*")
    .eq("id", progressId)
    .maybeSingle();
  if (!progress) return;
  if (progress.status !== "active") return;

  const blocks = await loadBlocks(progress.flow_id);
  const block = blocks[progress.current_block_index ?? 0];
  if (!block) {
    await supabaseAdmin
      .from("call_flow_progress")
      .update({ status: "completed", exit_reason: "no_block" } as any)
      .eq("id", progress.id);
    return;
  }

  if (block.block_type === "delay") {
    await scheduleNext(progress, block);
    return;
  }

  // Janela de envio: bloquear ligação fora do horário permitido.
  if (block.block_type === "call") {
    const defer = await deferIfOutsideWindow();
    if (defer) {
      await supabaseAdmin
        .from("call_flow_progress")
        .update({ next_run_at: defer, status: "active" } as any)
        .eq("id", progress.id);
      await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "deferred_quiet_hours", {
        next_run_at: defer,
      });
      return;
    }
  }

  const player = await loadPlayer(progress.player_id);
  await executeCallBlock(progress, block, player);
}

/** Tick: processa todos os progressos prontos. Chamado pelo cron. */
export async function tickFlows(limit = 50): Promise<{ processed: number }> {
  // Respeita pause global e pause por canal (call_paused). Itens já em
  // call_queue/call_flow_progress ficam parados; retomam quando despausar.
  const { data: pauseRow } = await supabaseAdmin
    .from("automation_settings")
    .select("paused, call_paused")
    .limit(1)
    .maybeSingle();
  if (pauseRow?.paused || pauseRow?.call_paused) {
    return { processed: 0 };
  }
  const nowIso = new Date().toISOString();
  // Claim atômico: reserva linhas ativas via FOR UPDATE SKIP LOCKED — permite
  // que múltiplos workers do cron rodem em paralelo sem disparar a mesma
  // ligação duas vezes.
  const { data: ready, error: claimErr } = await supabaseAdmin.rpc(
    "claim_call_flow_progress",
    { p_limit: limit },
  );
  if (claimErr) {
    console.error("[call-flow tick] claim falhou", claimErr);
    return { processed: 0 };
  }
  // Sem antiban para ligação — paraleliza em batches para usar capacidade
  // máxima da BusinessCode Voice. Falha de um item não derruba batch.
  const BATCH_SIZE = 100;
  let processed = 0;
  const readyList = ready ?? [];
  for (let i = 0; i < readyList.length; i += BATCH_SIZE) {
    const batch = readyList.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        try {
          await advanceProgress(row.id);
          return 1;
        } catch (e) {
          console.error("[call-flow tick] erro em", row.id, e);
          return 0;
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") processed += r.value;
    }
  }

  // Também processa "waiting" expirados (sem callback após 10min) — avança como no_answer
  const { data: stuck } = await supabaseAdmin
    .from("call_flow_progress")
    .select("id")
    .eq("status", "waiting")
    .lte("next_run_at", nowIso)
    .limit(limit);
  const stuckList = stuck ?? [];
  for (let i = 0; i < stuckList.length; i += BATCH_SIZE) {
    const batch = stuckList.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        try {
          await handleCallCompletion({
            progressId: row.id,
            status: "no_answer",
            durationSeconds: 0,
          });
          return 1;
        } catch (e) {
          console.error("[call-flow tick] erro stuck", row.id, e);
          return 0;
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") processed += r.value;
    }
  }

  // Fallback de polling: se o webhook da BusinessCode não chegar, consulta o
  // status do dispatch e dispara handleCallCompletion manualmente.
  try {
    const polled = await pollPendingCalls(limit);
    processed += polled;
  } catch (e) {
    console.error("[call-flow tick] erro polling", e);
  }

  return { processed };
}

/**
 * Consulta na BusinessCode o status de ligações que estão como `pending` em
 * `call_history` há mais de 90s. Quando o dispatch já tem status final,
 * atualiza o histórico e chama handleCallCompletion (que dispara SMS
 * condicional do bloco e avança o progresso do fluxo).
 */
export async function pollPendingCalls(limit = 50): Promise<number> {
  const cutoffIso = new Date(Date.now() - 90_000).toISOString();
  const { data: pendings } = await supabaseAdmin
    .from("call_history")
    .select("id, provider_call_id, provider_response, created_at")
    .eq("status", "pending")
    .lte("created_at", cutoffIso)
    .gte("created_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  if (!pendings || pendings.length === 0) return 0;
  console.info("[call-flow polling] pendings", { count: pendings.length });

  const rawToken = process.env.BUSINESSCODE_SMS_TOKEN || "";
  const token = rawToken
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^Authorization\s*:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
  if (!token) {
    console.warn("[call-flow polling] BUSINESSCODE_SMS_TOKEN ausente");
    return 0;
  }

  let advanced = 0;
  for (const row of pendings) {
    const pr = (row.provider_response ?? {}) as {
      dispatch_id?: number | string;
      _links?: { status?: string };
    };
    const dispatchId = pr.dispatch_id;
    const statusUrlRaw = pr._links?.status;
    const url = statusUrlRaw
      ? statusUrlRaw.replace(/^http:\/\//i, "https://")
      : dispatchId
        ? `https://dash.businesscode.com.br/api/v1/messaging/dispatches/${dispatchId}`
        : null;
    if (!url) continue;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { snippet: text.slice(0, 200) };
      }
      if (!res.ok) {
        console.warn("[call-flow polling] status HTTP", res.status, "para", row.id);
        continue;
      }

      // A BusinessCode mantém `status` genérico (queued/sent/delivered) e
      // expõe o resultado real da ligação em `voice_status`. Sem ler isso,
      // ligações atendidas ficam para sempre como "queued" no nosso lado.
      const d = body?.data ?? body;
      const voiceStatus: string | undefined =
        d?.voice_status ?? body?.voice_status;
      const baseStatus: string | undefined =
        d?.status ?? body?.status ?? body?.dispatch?.status;
      const providerStatus: string | undefined = voiceStatus ?? baseStatus;
      const duration: number =
        Number(
          d?.call_duration_seconds ??
            d?.duration_seconds ??
            body?.duration_seconds ??
            body?.duration ??
            0,
        ) || 0;

      // Mapeia status da BusinessCode para nosso vocabulário
      const finalMap: Record<string, string> = {
        answered: "answered",
        completed: "completed",
        delivered: "delivered",
        not_answered: "not_answered",
        no_answer: "not_answered",
        busy: "busy",
        failed: "failed",
        undelivered: "undelivered",
      };
      const mapped = providerStatus ? finalMap[providerStatus] : null;
      if (!mapped) {
        console.info("[call-flow polling] status não-final", {
          id: row.id,
          voice_status: voiceStatus ?? null,
          status: baseStatus ?? null,
        });
        continue;
      }
      console.info("[call-flow polling] status final detectado", {
        id: row.id,
        voice_status: voiceStatus ?? null,
        status: baseStatus ?? null,
        duration,
      });

      // Atualiza call_history como o webhook faria
      const newHistoryStatus = ["answered", "completed", "delivered"].includes(mapped)
        ? "completed"
        : "failed";
      await supabaseAdmin
        .from("call_history")
        .update({
          status: newHistoryStatus as any,
          duration_seconds: duration || null,
          provider_status_code: res.status,
          provider_response: { ...pr, polled: body } as any,
        } as any)
        .eq("id", row.id);

      if (row.provider_call_id) {
        await handleCallCompletion({
          providerCallId: row.provider_call_id,
          status: mapped,
          durationSeconds: duration,
        });
        advanced += 1;
      }
    } catch (e) {
      console.error("[call-flow polling] erro consulta", row.id, e);
    }
  }
  return advanced;
}

/** Mapeia status do provedor para a condição lógica de SMS. */
function smsCondMatches(
  cond: string,
  status: string,
  duration: number,
  threshold: number | null,
): boolean {
  if (cond === "always") return true;
  const answered = ["answered", "completed", "delivered"].includes(status);
  const notAnswered = ["not_answered", "busy", "failed", "undelivered", "no_answer"].includes(
    status,
  );
  switch (cond) {
    case "answered":
      return answered;
    case "not_answered":
      return notAnswered;
    case "listened_gte":
      return answered && duration >= (threshold ?? 0);
    case "listened_lt":
      return answered && duration < (threshold ?? 0);
    case "hangup_before":
      return answered && duration < (threshold ?? 0);
    case "voicemail":
      return status === "voicemail";
    case "busy":
      return status === "busy";
    case "failed":
      return status === "failed" || status === "undelivered";
    case "no_answer":
      return status === "not_answered" || status === "no_answer";
    default:
      return false;
  }
}

/** Processa o resultado de uma ligação (callback do provedor ou timeout). */
export async function handleCallCompletion(args: {
  progressId?: string;
  providerCallId?: string;
  status: string;
  durationSeconds?: number;
}) {
  // Resolve progress
  let progressId = args.progressId ?? null;
  if (!progressId && args.providerCallId) {
    // Localiza pelo último call_history com esse provider_call_id e seu player/flow
    const { data: hist } = await supabaseAdmin
      .from("call_history")
      .select("lead_id, created_at")
      .eq("provider_call_id", args.providerCallId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (hist?.lead_id) {
      const { data: prog } = await supabaseAdmin
        .from("call_flow_progress")
        .select("id")
        .eq("player_id", hist.lead_id)
        .eq("status", "waiting")
        .order("last_call_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      progressId = prog?.id ?? null;
    }
  }
  if (!progressId) return { ok: false, reason: "no_progress" };

  const { data: progress } = await supabaseAdmin
    .from("call_flow_progress")
    .select("*")
    .eq("id", progressId)
    .maybeSingle();
  if (!progress) return { ok: false, reason: "progress_gone" };

  const blocks = await loadBlocks(progress.flow_id);
  const block = blocks[progress.current_block_index ?? 0];
  if (!block) return { ok: false, reason: "no_block" };

  const duration = args.durationSeconds ?? 0;

  // Atualiza último resultado
  await supabaseAdmin
    .from("call_flow_progress")
    .update({
      last_call_result: args.status,
      last_call_duration: duration,
    } as any)
    .eq("id", progress.id);

  await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "call_result", {
    status: args.status,
    duration,
  });

  // Dispara SMS condicionais
  const smsList = ((block as any).call_flow_block_sms ?? []) as any[];
  if (smsList.length > 0) {
    const deferSms = await deferIfOutsideWindow();
    const player = await loadPlayer(progress.player_id);
    const phone = progress.phone_e164 || player?.telefone || "";
    if (phone && player) {
      const vars = {
        ...buildPlayerVariables(player),
        duracao_chamada: String(duration),
        resultado_ligacao: args.status,
        tentativas_ligacao: String(progress.attempts_on_block ?? 0),
        data_ultima_ligacao: new Date().toLocaleDateString("pt-BR"),
        atendeu: ["answered", "completed", "delivered"].includes(args.status) ? "sim" : "não",
      };
      for (const sms of smsList.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
        if (!sms.template) continue;
        if (!smsCondMatches(sms.condition, args.status, duration, sms.threshold_seconds)) continue;
        if (deferSms) {
          await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "sms_deferred_quiet_hours", {
            condition: sms.condition,
            next_allowed_at: deferSms,
          });
          continue;
        }
        try {
          await sendSmsInternal({
            to: phone,
            content: sms.template as string,
            playerId: progress.player_id,
            flowId: progress.flow_id,
            triggerName: `call_flow:${progress.flow_id}:block:${progress.current_block_index}`,
            variables: vars,
          });
          await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "sms_sent", {
            condition: sms.condition,
          });
        } catch (e) {
          console.error("[call-flow] sms fail", e);
        }
      }
    }
  }

  // Retentativa? (call_block.max_attempts > 1 e não atendeu)
  const isCall = block.block_type === "call";
  const notAnswered = ["not_answered", "busy", "failed", "undelivered", "no_answer"].includes(
    args.status,
  );
  if (
    isCall &&
    notAnswered &&
    (progress.attempts_on_block ?? 0) < (block.max_attempts ?? 1)
  ) {
    await supabaseAdmin
      .from("call_flow_progress")
      .update({
        status: "active",
        next_run_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      } as any)
      .eq("id", progress.id);
    await logEvent(progress.id, progress.flow_id, progress.player_id, progress.current_block_index, "retry_scheduled", {
      attempt: progress.attempts_on_block,
    });
    return { ok: true };
  }

  // Avança para o próximo
  await scheduleNext(progress, block);
  return { ok: true };
}