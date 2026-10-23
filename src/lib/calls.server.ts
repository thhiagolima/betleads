// Helpers server-only do módulo Ligações IA.
// Renderização de variáveis, hash de cache, integração com ElevenLabs e upload de áudio.
// NUNCA importar este arquivo a partir de código client.

import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { evaluateVoiceContactPolicy } from "./consent.server";
import { logCallHistoryInsertError } from "./voice-history-log";
import { callInfobipVoice, normalizeE164BR } from "./infobip-voice.server";
import { assertTenantNotDemoForSend, listDemoTenantIds } from "./tenant-access.server";
import { isDemoBlockedError } from "./demo-tenant";

// ============================================================
// Tipos
// ============================================================
export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.5,
  speed: 1.0,
  use_speaker_boost: true,
};

export interface LeadLike {
  id?: string | null;
  nome?: string | null;
  telefone?: string | null;
  email?: string | null;
  saldo_carteira?: number | null;
  ultimo_login?: string | null;
  ultimo_jogo?: string | null;
  ultimo_deposito?: string | null;
  total_depositado?: number | null;
  status?: string | null;
  expert?: string | null;
  vip?: boolean | null;
  risco?: string | null;
}

// Dados fake para preview manual quando não há lead selecionado.
export const FAKE_LEAD: LeadLike = {
  id: null,
  nome: "Pedro Silva",
  telefone: "+5511999990000",
  saldo_carteira: 73.5,
  ultimo_login: new Date(Date.now() - 8 * 86400000).toISOString(),
  ultimo_jogo: new Date(Date.now() - 12 * 86400000).toISOString(),
  ultimo_deposito: new Date(Date.now() - 21 * 86400000).toISOString(),
  total_depositado: 1200,
  status: "ativo",
  expert: "Equipe BETLEADS",
  vip: false,
  risco: "baixo",
};

// ============================================================
// Formatadores
// ============================================================
function brl(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value));
}

function firstName(full: string | null | undefined): string {
  if (!full) return "amigo";
  return full.trim().split(/\s+/)[0] ?? "amigo";
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function safe(value: string | number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

// ============================================================
// Renderização de variáveis
// ============================================================
export function buildVariables(lead: LeadLike): Record<string, string> {
  const dl = daysSince(lead.ultimo_login);
  const dj = daysSince(lead.ultimo_jogo);
  const dd = daysSince(lead.ultimo_deposito);

  return {
    primeiro_nome: firstName(lead.nome),
    nome: safe(lead.nome, "amigo"),
    telefone: safe(lead.telefone, ""),
    saldo: brl(lead.saldo_carteira ?? 0),
    ultimo_login: lead.ultimo_login
      ? new Date(lead.ultimo_login).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_login: dl == null ? "alguns dias" : String(dl),
    ultimo_jogo: lead.ultimo_jogo
      ? new Date(lead.ultimo_jogo).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_jogar: dj == null ? "alguns dias" : String(dj),
    ultimo_deposito: lead.ultimo_deposito
      ? new Date(lead.ultimo_deposito).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_depositar: dd == null ? "alguns dias" : String(dd),
    total_depositado: brl(lead.total_depositado ?? 0),
    categoria: lead.vip ? "VIP" : safe(lead.risco, "regular"),
    status_lead: safe(lead.status, "ativo"),
    nome_expert: safe(lead.expert, "Equipe BETLEADS"),
    link_deposito: "https://betleads.app/depositar",
  };
}

export function renderCallScript(scriptContent: string, lead: LeadLike): string {
  const vars = buildVariables(lead);
  return scriptContent.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const v = vars[key];
    return v ?? "";
  });
}

// ============================================================
// Hash de cache
// ============================================================
export function computeAudioHash(input: {
  rendered_text: string;
  voice_id: string;
  provider: string;
  voice_settings: VoiceSettings;
}): string {
  const normalized = JSON.stringify({
    t: input.rendered_text,
    v: input.voice_id,
    p: input.provider,
    s: input.voice_settings,
  });
  return createHash("sha256").update(normalized).digest("hex");
}

// ============================================================
// ElevenLabs
// ============================================================
function requireElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY não está configurada");
  }
  return key;
}

export function defaultVoiceId(): string {
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
}

export function defaultModelId(): string {
  return process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
}

/**
 * Text-to-speech through ElevenLabs. Throws DemoTenantBlockedError
 * (DEMO_SEND_BLOCKED) for a demo/unknown/missing tenant before the request.
 */
export async function callElevenLabs(params: {
  tenantId: string;
  text: string;
  voiceId: string;
  voiceSettings: VoiceSettings;
}): Promise<ArrayBuffer> {
  const apiKey = requireElevenLabsKey();
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${params.voiceId}?output_format=mp3_44100_128`;
  await assertTenantNotDemoForSend(params.tenantId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: params.text,
      model_id: defaultModelId(),
      voice_settings: {
        stability: params.voiceSettings.stability,
        similarity_boost: params.voiceSettings.similarity_boost,
        style: params.voiceSettings.style,
        use_speaker_boost: params.voiceSettings.use_speaker_boost,
        speed: params.voiceSettings.speed,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs falhou (${res.status}): ${errText || res.statusText}`);
  }
  return res.arrayBuffer();
}

// ============================================================
// Upload no storage
// ============================================================
export async function uploadAudioToStorage(
  audioBuffer: ArrayBuffer,
  hash: string,
): Promise<{ path: string; signedUrl: string }> {
  const path = `generated/${hash}.mp3`;
  const { error: upErr } = await supabaseAdmin.storage
    .from("call-audios")
    .upload(path, new Uint8Array(audioBuffer), {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (upErr) throw new Error(`Falha ao salvar áudio: ${upErr.message}`);

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from("call-audios")
    .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 dias
  if (signErr || !signed) {
    throw new Error(`Falha ao gerar URL do áudio: ${signErr?.message ?? "desconhecido"}`);
  }
  return { path, signedUrl: signed.signedUrl };
}

// ============================================================
// Montagem de payload para provedor de telefonia
// ============================================================
export function buildProviderPayload(
  template: Record<string, unknown>,
  data: {
    phone: string;
    audio_url: string;
    lead_name: string;
    call_queue_id: string;
    callback_url: string;
  },
): Record<string, unknown> {
  const replace = (val: unknown): unknown => {
    if (typeof val === "string") {
      return val
        .replace(/\{telefone\}/g, data.phone)
        .replace(/\{audio_url\}/g, data.audio_url)
        .replace(/\{nome\}/g, data.lead_name)
        .replace(/\{call_queue_id\}/g, data.call_queue_id)
        .replace(/\{callback_url\}/g, data.callback_url);
    }
    if (Array.isArray(val)) return val.map(replace);
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = replace(v);
      }
      return out;
    }
    return val;
  };
  return replace(template) as Record<string, unknown>;
}

function positiveSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return value != null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Duration of a queued call's generated audio (call_queue.audio_generation_id),
 * used as the reservation's maxSeconds. Null when unknown; never throws (the
 * env default is a safe cap).
 */
export async function audioGenerationSeconds(
  client: unknown,
  tenantId: string,
  audioGenerationId: string,
): Promise<number | null> {
  try {
    const { data } = await (client as typeof supabaseAdmin)
      .from("call_audio_generations")
      .select("duration_seconds")
      .eq("id", audioGenerationId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return positiveSeconds(data?.duration_seconds);
  } catch {
    return null;
  }
}

/** Copy shown when the house's wallet refuses a call's reservation. */
export const VOICE_INSUFFICIENT_BALANCE_MESSAGE = "Saldo insuficiente";

export type VoiceDispatchOutcome = "ok" | "insufficient_balance" | "transient" | "failed";

/**
 * How a queued call's dispatch result is handled. The wallet refusal
 * (`errorKind: "insufficient_balance"`, status 0) is checked BEFORE the
 * transient rule: status 0 alone means "no provider response" and re-queues
 * the item in 5 minutes, which for a house without balance would repeat
 * forever. Only the explicit errorKind means the house's wallet; a provider
 * 402 without it keeps its old (final) classification.
 */
export function classifyVoiceDispatchResult(result: {
  ok: boolean;
  status: number;
  body: unknown;
  errorKind?: string | null;
}): VoiceDispatchOutcome {
  if (result.ok) return "ok";
  if (result.errorKind === "insufficient_balance") return "insufficient_balance";
  const body = (result.body ?? {}) as { non_json?: boolean };
  if (
    result.status === 0 ||
    result.status === 429 ||
    (result.status >= 500 && result.status < 600) ||
    body?.non_json === true
  )
    return "transient";
  return "failed";
}

/**
 * Dispatches due items created by voice campaigns. Call flows use their own
 * sequential runner; this worker covers the regular call_queue, including
 * scheduled campaigns that previously stayed at audio_ready indefinitely.
 */
export async function runVoiceQueueDispatcher(limit = 200, callQueueId?: string) {
  const now = new Date().toISOString();
  let query = supabaseAdmin
    .from("call_queue")
    .select(
      "id,tenant_id,lead_id,script_id,voice_asset_id,audio_generation_id,phone_number,audio_url,status,scheduled_at",
    )
    .eq("status", "audio_ready")
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true });
  if (callQueueId) query = query.eq("id", callQueueId);
  // Demo tenants' queue items are never picked up.
  const demoTenantIds = await listDemoTenantIds();
  if (demoTenantIds.length > 0) {
    query = query.not("tenant_id", "in", `(${demoTenantIds.join(",")})`);
  }
  const { data: queue, error } = await query.limit(limit);
  if (error) throw new Error(error.message);

  let dispatched = 0;
  let deferred = 0;
  let failed = 0;
  let insufficientBalance = 0;
  for (const item of queue ?? []) {
    try {
      let phone = item.phone_number ?? "";
      let player: LeadLike | null = null;
      if (item.lead_id) {
        const { data } = await supabaseAdmin
          .from("players")
          .select("*")
          .eq("id", item.lead_id)
          .eq("tenant_id", item.tenant_id)
          .maybeSingle();
        player = data as LeadLike | null;
        if (!phone) phone = player?.telefone ?? "";
      }
      if (!phone) throw new Error("Telefone do destinatário ausente.");
      const to = normalizeE164BR(phone);
      const policy = await evaluateVoiceContactPolicy(item.tenant_id, to);
      if (!policy.allowed) {
        const revoked = policy.reason === "consent_revoked";
        await supabaseAdmin
          .from("call_queue")
          .update({
            status: revoked ? "cancelled" : "audio_ready",
            provider_status: policy.reason,
            scheduled_at: policy.retryAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
          } as never)
          .eq("id", item.id);
        deferred++;
        continue;
      }

      // Fixed-library assets receive a fresh signed URL at dispatch time, so a
      // campaign scheduled for later does not rely on the URL created at draft time.
      let audioUrl = item.audio_url;
      // PG3: the audio's known duration sizes the wallet reservation; null
      // falls back to VOICE_MAX_CALL_SECONDS inside callInfobipVoice.
      let maxSeconds: number | null = null;
      if (item.voice_asset_id) {
        const { data: asset } = await supabaseAdmin
          .from("journey_voice_assets")
          .select("storage_path,is_archived,duration_seconds")
          .eq("id", item.voice_asset_id)
          .eq("tenant_id", item.tenant_id)
          .maybeSingle();
        if (!asset || asset.is_archived)
          throw new Error("Áudio da biblioteca não está disponível.");
        const { data: signed, error: signError } = await supabaseAdmin.storage
          .from("call-audios")
          .createSignedUrl(asset.storage_path, 60 * 60);
        if (signError || !signed?.signedUrl)
          throw new Error("Não foi possível preparar o áudio para a ligação.");
        audioUrl = signed.signedUrl;
        maxSeconds = positiveSeconds(asset.duration_seconds);
      }
      if (maxSeconds == null && item.audio_generation_id) {
        maxSeconds = await audioGenerationSeconds(
          supabaseAdmin,
          item.tenant_id,
          item.audio_generation_id,
        );
      }
      let content: Parameters<typeof callInfobipVoice>[1];
      let renderedText: string | null = null;
      if (item.script_id) {
        const { data: script } = await supabaseAdmin
          .from("call_scripts")
          .select("content")
          .eq("id", item.script_id)
          .eq("tenant_id", item.tenant_id)
          .maybeSingle();
        if (!script?.content) throw new Error("Script de voz não encontrado.");
        renderedText = renderCallScript(script.content, player ?? FAKE_LEAD);
        content = { type: "tts", text: renderedText, language: "pt" };
      } else {
        if (!audioUrl) throw new Error("Áudio da ligação não está pronto.");
        content = { type: "audio", audioUrl };
      }

      // No idempotency key: each dispatch attempt is its own call, so the
      // wallet reference is `voice:<fresh uuid>`.
      const result = await callInfobipVoice(to, content, {
        tenantId: item.tenant_id,
        maxSeconds,
      });
      const outcome = classifyVoiceDispatchResult(result);
      if (outcome === "insufficient_balance") {
        // Final for this item: never re-queued (no call was placed, nothing
        // reserved). The house reruns the campaign after a top-up.
        await supabaseAdmin
          .from("call_queue")
          .update({
            status: "failed",
            provider_status: "saldo_insuficiente",
            provider_response: { error: VOICE_INSUFFICIENT_BALANCE_MESSAGE } as never,
            provider_request_id: result.idempotencyKey,
          } as never)
          .eq("id", item.id);
        insufficientBalance++;
        failed++;
        continue;
      }
      if (outcome === "transient") {
        await supabaseAdmin
          .from("call_queue")
          .update({
            status: "audio_ready",
            provider_status: "provider_unavailable",
            provider_response: result.body as never,
            provider_request_id: result.idempotencyKey,
            scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          } as never)
          .eq("id", item.id);
        deferred++;
        continue;
      }

      const { error: historyInsertError } = await supabaseAdmin.from("call_history").insert({
        tenant_id: item.tenant_id,
        lead_id: item.lead_id,
        script_id: item.script_id,
        call_queue_id: item.id,
        audio_url: audioUrl,
        rendered_text: renderedText,
        to_phone: to,
        status: result.ok ? "pending" : "failed",
        provider: "infobip",
        provider_call_id: result.providerCallId ?? result.idempotencyKey,
        provider_response: {
          ...((result.body && typeof result.body === "object" && !Array.isArray(result.body)) ? result.body : {}),
          correlation_id: result.idempotencyKey,
          cml: content.type === "tts" ? { type: "say", text: content.text, language: content.language ?? "pt" } : undefined,
        } as never,
        provider_status_code: result.status,
        error_message: result.ok ? null : JSON.stringify(result.body).slice(0, 1000),
        billing_reference_id: result.billing?.referenceId ?? null,
      } as never);
      if (historyInsertError) logCallHistoryInsertError("queue", historyInsertError, result);
      await supabaseAdmin
        .from("call_queue")
        .update({
          status: result.ok ? "waiting_provider" : "failed",
          provider_status: result.ok ? "sent" : `error_${result.status}`,
          provider_response: result.body as never,
          provider_request_id: result.idempotencyKey,
          audio_url: audioUrl,
        } as never)
        .eq("id", item.id);
      if (result.ok) dispatched++;
      else failed++;
    } catch (cause) {
      // A demo block is not a dispatch failure and is never recorded: no
      // call_history row, and the item is not marked failed/sent.
      if (isDemoBlockedError(cause)) throw cause;
      failed++;
      await supabaseAdmin
        .from("call_queue")
        .update({
          status: "failed",
          provider_status: "dispatch_error",
          provider_response: {
            error: cause instanceof Error ? cause.message : String(cause),
          } as never,
        } as never)
        .eq("id", item.id);
    }
  }
  return { due: queue?.length ?? 0, dispatched, deferred, failed, insufficientBalance };
}
