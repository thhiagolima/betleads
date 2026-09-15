// Server functions (RPC) do módulo Ligações com Voz IA.
// Apenas declarações de createServerFn + imports — toda lógica fica em calls.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  callElevenLabs,
  computeAudioHash,
  DEFAULT_VOICE_SETTINGS,
  defaultVoiceId,
  FAKE_LEAD,
  renderCallScript,
  uploadAudioToStorage,
  type LeadLike,
  type VoiceSettings,
} from "./calls.server";
import {
  callBusinessCodeVoice,
  fetchBusinessCodeDispatchStatus,
  normalizeE164BR,
} from "./businesscode-voice.server";

// ============================================================
// Schemas
// ============================================================
const VoiceSettingsSchema = z
  .object({
    stability: z.number().min(0).max(1).default(0.5),
    similarity_boost: z.number().min(0).max(1).default(0.75),
    style: z.number().min(0).max(1).default(0.5),
    speed: z.number().min(0.7).max(1.2).default(1.0),
    use_speaker_boost: z.boolean().default(true),
  })
  .partial()
  .transform((v) => ({ ...DEFAULT_VOICE_SETTINGS, ...v }));

const ScriptStatusSchema = z.enum(["active", "inactive", "draft"]);

// ============================================================
// SCRIPTS
// ============================================================
export const listCallScripts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("call_scripts")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { scripts: data ?? [] };
  });

export const saveCallScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid().optional(),
        name: z.string().min(1).max(120),
        trigger_name: z.string().max(120).nullable().optional(),
        content: z.string().min(1).max(8000),
        status: ScriptStatusSchema.default("draft"),
        default_voice_id: z.string().max(120).nullable().optional(),
        provider: z.string().max(60).default("elevenlabs"),
        voice_settings: VoiceSettingsSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const payload = {
      name: data.name,
      trigger_name: data.trigger_name ?? null,
      content: data.content,
      status: data.status,
      default_voice_id: data.default_voice_id ?? null,
      provider: data.provider,
      voice_settings: (data.voice_settings ?? DEFAULT_VOICE_SETTINGS) as any,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("call_scripts")
        .update(payload as any)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: created, error } = await context.supabase
      .from("call_scripts")
      .insert(payload as any)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

export const deleteCallScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("call_scripts").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// GERAÇÃO DE ÁUDIO (com cache)
// ============================================================
async function loadLead(
  supabase: any,
  leadId: string | null | undefined,
): Promise<LeadLike> {
  if (!leadId) return FAKE_LEAD;
  const { data, error } = await supabase
    .from("players")
    .select(
      "id, nome, telefone, email, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, status, expert, vip, risco",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as LeadLike | null) ?? FAKE_LEAD;
}

export const generateLeadVoiceAudio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        script_id: dbUuid(),
        lead_id: dbUuid().nullable().optional(),
        voice_id: z.string().min(1).max(120).optional(),
        voice_settings: VoiceSettingsSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: script, error: sErr } = await supabase
      .from("call_scripts")
      .select("*")
      .eq("id", data.script_id)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!script) throw new Error("Script não encontrado");

    const lead = await loadLead(supabase, data.lead_id ?? null);
    const renderedText = renderCallScript(script.content as string, lead);

    const voiceId =
      data.voice_id ||
      (script.default_voice_id as string | null) ||
      defaultVoiceId();
    const voiceSettings: VoiceSettings = (data.voice_settings ??
      (script.voice_settings as unknown as VoiceSettings) ??
      DEFAULT_VOICE_SETTINGS) as VoiceSettings;

    const hash = computeAudioHash({
      rendered_text: renderedText,
      voice_id: voiceId,
      provider: (script.provider as string) || "elevenlabs",
      voice_settings: voiceSettings,
    });

    // Cache hit?
    const { data: cached } = await supabase
      .from("call_audio_generations")
      .select("*")
      .eq("audio_hash", hash)
      .eq("generation_status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached?.audio_url) {
      console.log(`[calls] cache HIT hash=${hash.slice(0, 10)}`);
      // Não inserir linha duplicada: reusar o registro existente.
      return { audio: cached, cache: true };
    }

    // Anti-duplicação: se outra execução já está gerando esse mesmo hash
    // (mesmo texto/voz/settings) nos últimos 60s, espera ela terminar e reusa.
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const { data: inFlight } = await supabase
      .from("call_audio_generations")
      .select("*")
      .eq("audio_hash", hash)
      .eq("generation_status", "generating")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (inFlight) {
      console.log(`[calls] cache WAIT hash=${hash.slice(0, 10)} — aguardando geração concorrente`);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: maybeReady } = await supabase
          .from("call_audio_generations")
          .select("*")
          .eq("id", inFlight.id)
          .maybeSingle();
        if (maybeReady?.generation_status === "ready" && maybeReady.audio_url) {
          return { audio: maybeReady, cache: true };
        }
        if (maybeReady?.generation_status === "failed") break;
      }
      // Se passou do timeout ou falhou, cai para geração normal abaixo.
    }

    console.log(`[calls] cache MISS hash=${hash.slice(0, 10)} — gerando via ElevenLabs`);

    // Registro inicial
    const { data: pending, error: pErr } = await supabase
      .from("call_audio_generations")
      .insert({
        lead_id: data.lead_id ?? null,
        script_id: data.script_id,
        provider: "elevenlabs",
        voice_id: voiceId,
        original_text: script.content,
        rendered_text: renderedText,
        audio_hash: hash,
        generation_status: "generating",
        voice_settings: voiceSettings as any,
      } as any)
      .select("*")
      .single();
    if (pErr) throw new Error(pErr.message);

    try {
      const buf = await callElevenLabs({
        text: renderedText,
        voiceId,
        voiceSettings,
      });
      const { path, signedUrl } = await uploadAudioToStorage(buf, hash);

      const { data: updated, error: uErr } = await supabase
        .from("call_audio_generations")
        .update({
          audio_url: signedUrl,
          audio_path: path,
          generation_status: "ready",
        })
        .eq("id", pending.id)
        .select("*")
        .single();
      if (uErr) throw new Error(uErr.message);
      console.log(`[calls] áudio gerado id=${updated.id}`);
      return { audio: updated, cache: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[calls] falha gerando áudio: ${msg}`);
      await supabase
        .from("call_audio_generations")
        .update({ generation_status: "failed", error_message: msg })
        .eq("id", pending.id);
      throw new Error(msg);
    }
  });

export const retryAudioGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ audio_generation_id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("call_audio_generations")
      .select("script_id, lead_id, voice_id, voice_settings")
      .eq("id", data.audio_generation_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row?.script_id) throw new Error("Geração inválida para retry");
    return generateLeadVoiceAudio({
      data: {
        script_id: row.script_id,
        lead_id: row.lead_id ?? null,
      voice_id: row.voice_id ?? undefined,
        voice_settings: (row.voice_settings as unknown as VoiceSettings | undefined) ?? undefined,
      },
    });
  });

// ============================================================
// PREVIEW MANUAL
// ============================================================
export const getCallAudioPreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        script_id: dbUuid().optional(),
        script_content: z.string().min(1).max(8000).optional(),
        lead_id: dbUuid().nullable().optional(),
        voice_id: z.string().max(120).optional(),
        voice_settings: VoiceSettingsSchema.optional(),
      })
      .refine((v) => v.script_id || v.script_content, {
        message: "Informe script_id ou script_content",
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let content = data.script_content ?? "";
    let provider = "elevenlabs";
    let voiceId = data.voice_id || defaultVoiceId();
    let voiceSettings: VoiceSettings =
      (data.voice_settings as VoiceSettings | undefined) ?? DEFAULT_VOICE_SETTINGS;

    if (data.script_id) {
      const { data: s, error } = await supabase
        .from("call_scripts")
        .select("content, default_voice_id, provider, voice_settings")
        .eq("id", data.script_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (s) {
        content = (s.content as string) ?? content;
        provider = (s.provider as string) || provider;
        voiceId = data.voice_id || (s.default_voice_id as string | null) || voiceId;
        voiceSettings =
          (data.voice_settings as VoiceSettings | undefined) ??
          ((s.voice_settings as unknown as VoiceSettings) ?? voiceSettings);
      }
    }

    const lead = await loadLead(supabase, data.lead_id ?? null);
    const renderedText = renderCallScript(content, lead);

    const hash = computeAudioHash({
      rendered_text: renderedText,
      voice_id: voiceId,
      provider,
      voice_settings: voiceSettings,
    });

    // cache?
    const { data: cached } = await supabase
      .from("call_audio_generations")
      .select("audio_url, audio_path")
      .eq("audio_hash", hash)
      .eq("generation_status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached?.audio_url) {
      return { rendered_text: renderedText, audio_url: cached.audio_url, cache: true };
    }

    const buf = await callElevenLabs({ text: renderedText, voiceId, voiceSettings });
    const { path, signedUrl } = await uploadAudioToStorage(buf, hash);

    await supabase.from("call_audio_generations").insert({
      lead_id: data.lead_id ?? null,
      script_id: data.script_id ?? null,
      provider,
      voice_id: voiceId,
      original_text: content,
      rendered_text: renderedText,
      audio_url: signedUrl,
      audio_path: path,
      audio_hash: hash,
      generation_status: "ready",
      voice_settings: voiceSettings as any,
    } as any);

    return { rendered_text: renderedText, audio_url: signedUrl, cache: false };
  });

// ============================================================
// FILA DE LIGAÇÕES
// ============================================================
export const createCallQueueItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        lead_id: dbUuid().nullable().optional(),
        script_id: dbUuid(),
        trigger_name: z.string().max(120).nullable().optional(),
        priority: z.number().int().min(1).max(1000).default(100),
        scheduled_at: z.string().datetime().optional(),
        phone_number: z.string().max(40).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: created, error } = await context.supabase
      .from("call_queue")
      .insert({
        lead_id: data.lead_id ?? null,
        script_id: data.script_id,
        trigger_name: data.trigger_name ?? null,
        priority: data.priority,
        scheduled_at: data.scheduled_at ?? new Date().toISOString(),
        phone_number: data.phone_number ?? null,
        status: "pending_audio",
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    console.log(`[calls] fila criada id=${created.id}`);
    return { item: created };
  });

export const prepareCallForLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        lead_id: dbUuid().nullable().optional(),
        script_id: dbUuid(),
        trigger_name: z.string().max(120).nullable().optional(),
        phone_number: z.string().max(40).nullable().optional(),
        voice_id: z.string().max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    // 1. Cria item na fila
    const { data: queueItem, error: qErr } = await supabase
      .from("call_queue")
      .insert({
        lead_id: data.lead_id ?? null,
        script_id: data.script_id,
        trigger_name: data.trigger_name ?? null,
        phone_number: data.phone_number ?? null,
        status: "pending_audio",
      })
      .select("*")
      .single();
    if (qErr) throw new Error(qErr.message);

    // 2. Gera áudio
    const audioRes = await generateLeadVoiceAudio({
      data: {
        script_id: data.script_id,
        lead_id: data.lead_id ?? null,
        voice_id: data.voice_id,
      },
    });

    // 3. Atualiza fila para audio_ready
    const { data: updated, error: uErr } = await supabase
      .from("call_queue")
      .update({
        audio_generation_id: audioRes.audio.id,
        audio_url: audioRes.audio.audio_url,
        status: "audio_ready",
      })
      .eq("id", queueItem.id)
      .select("*")
      .single();
    if (uErr) throw new Error(uErr.message);

    return { queue: updated, audio: audioRes.audio };
  });

export const listCallQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        status: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("call_queue")
      .select("*")
      .order("priority", { ascending: true })
      .order("scheduled_at", { ascending: true })
      .limit(data.limit);
    if (data.status) q = q.eq("status", data.status as any);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { items: rows ?? [] };
  });

// ============================================================
// HISTÓRICO
// ============================================================
export const listCallHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        lead_id: dbUuid().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("call_history")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.lead_id) q = q.eq("lead_id", data.lead_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { history: rows ?? [] };
  });

export const listAudioGenerations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        lead_id: dbUuid().optional(),
        script_id: dbUuid().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("call_audio_generations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.lead_id) q = q.eq("lead_id", data.lead_id);
    if (data.script_id) q = q.eq("script_id", data.script_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { generations: rows ?? [] };
  });

// ============================================================
// LEADS (somente leitura leve para selector)
// ============================================================
export const listPlayersForCalls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("players")
      .select("id, nome, telefone, saldo_carteira, status, vip")
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.search && data.search.trim()) {
      const s = data.search.trim();
      q = q.or(`nome.ilike.%${s}%,telefone.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { players: rows ?? [] };
  });

export const cancelCallQueueItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("call_queue")
      .update({ status: "cancelled" })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateCallQueueStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid(),
        status: z.enum([
          "pending_audio",
          "audio_ready",
          "queued",
          "waiting_provider",
          "calling",
          "completed",
          "failed",
          "cancelled",
          "paused",
        ]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("call_queue")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// DISPATCH — BusinessCode Voice
// ============================================================
export const dispatchCallQueueItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ call_queue_id: dbUuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: q, error: qErr } = await supabase
      .from("call_queue")
      .select("id, phone_number, audio_url, lead_id, script_id, status")
      .eq("id", data.call_queue_id)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!q) throw new Error("Item da fila não encontrado");
    if (!q.audio_url) throw new Error("Áudio ainda não está pronto");

    // resolve telefone
    let rawPhone = q.phone_number ?? "";
    if (!rawPhone && q.lead_id) {
      const { data: lead } = await supabase
        .from("players")
        .select("telefone")
        .eq("id", q.lead_id)
        .maybeSingle();
      rawPhone = (lead?.telefone as string | null) ?? "";
    }
    if (!rawPhone) throw new Error("Telefone do lead ausente");

    let to: string;
    try {
      to = normalizeE164BR(rawPhone);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }

    const result = await callBusinessCodeVoice(to, q.audio_url);

    // 5xx ou body não-JSON (HTML) = falha transitória do provedor.
    // Preservamos o item em audio_ready com provider_status='provider_unavailable'
    // para retentar depois — não marcamos failed nem registramos no histórico.
    const bodyAny = (result.body ?? {}) as any;
    const isTransient =
      !result.ok &&
      (result.status === 0 ||
        result.status === 429 ||
        (result.status >= 500 && result.status <= 599) ||
        bodyAny?.non_json === true);

    if (isTransient) {
      const errMsg = `BusinessCode voice ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}`;
      try {
        await supabase.rpc("register_provider_throttle", {
          p_channel: "voice",
          p_retry_after_seconds: 300,
          p_error: errMsg,
        });
      } catch {
        /* tabela pode não ter linha 'voice' — ignora silenciosamente */
      }
      await supabase
        .from("call_queue")
        .update({
          status: "audio_ready",
          provider_status: "provider_unavailable",
          provider_response: (result.body ?? null) as any,
          provider_request_id: result.idempotencyKey || null,
        } as any)
        .eq("id", q.id);
      return {
        ok: false,
        pending: true,
        temporary: true,
        status: result.status,
        message: `Provedor de voz indisponível (HTTP ${result.status}). A ligação ficou pendente e será retentada — fila preservada.`,
      };
    }

    const historyStatus = result.ok ? "pending" : "failed";
    await supabase.from("call_history").insert({
      lead_id: q.lead_id,
      call_queue_id: q.id,
      script_id: q.script_id,
      audio_url: q.audio_url,
      status: historyStatus as any,
      provider: "businesscode",
      provider_call_id: result.idempotencyKey || null,
      error_message: result.ok ? null : JSON.stringify(result.body).slice(0, 1000),
      provider_response: (result.body ?? {}) as any,
      provider_status_code: result.status,
      to_phone: to,
    } as any);

    await supabase
      .from("call_queue")
      .update({
        status: result.ok ? "waiting_provider" : "failed",
        provider_status: result.ok ? "sent" : `error_${result.status}`,
        provider_response: (result.body ?? null) as any,
        provider_request_id: result.idempotencyKey || null,
      } as any)
      .eq("id", q.id);

    if (!result.ok) {
      throw new Error(
        `BusinessCode retornou ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`,
      );
    }
    return { ok: true, idempotency_key: result.idempotencyKey, to };
  });

// ============================================================
// ENVIO EM MASSA
// ============================================================
export const bulkDispatchCalls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        script_id: dbUuid(),
        campaign_name: z.string().max(120).optional(),
        targets: z
          .array(
            z.object({
              lead_id: dbUuid().nullable().optional(),
              phone_number: z.string().max(40).nullable().optional(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const results: Array<{
      ok: boolean;
      lead_id: string | null;
      phone: string | null;
      error?: string;
    }> = [];
    let queued = 0;
    let pending = 0;
    let failed = 0;

    for (const target of data.targets) {
      try {
        // 1. cria item na fila
        const { data: q, error: qErr } = await supabase
          .from("call_queue")
          .insert({
            lead_id: target.lead_id ?? null,
            script_id: data.script_id,
            trigger_name: data.campaign_name ?? null,
            phone_number: target.phone_number ?? null,
            status: "pending_audio",
          })
          .select("id")
          .single();
        if (qErr) throw new Error(qErr.message);

        // 2. gera áudio (cache hits aceleram muito)
        const audioRes = await generateLeadVoiceAudio({
          data: {
            script_id: data.script_id,
            lead_id: target.lead_id ?? null,
          },
        });

        // 3. marca audio_ready
        await supabase
          .from("call_queue")
          .update({
            audio_generation_id: audioRes.audio.id,
            audio_url: audioRes.audio.audio_url,
            status: "audio_ready",
          })
          .eq("id", q.id);

        // 4. dispara
        const dispatchResult = (await dispatchCallQueueItem({ data: { call_queue_id: q.id } })) as any;
        if (dispatchResult?.ok === false && dispatchResult?.pending) {
          pending += 1;
          results.push({
            ok: true,
            lead_id: target.lead_id ?? null,
            phone: target.phone_number ?? null,
            error: dispatchResult.message,
          });
        } else {
          queued += 1;
          results.push({
            ok: true,
            lead_id: target.lead_id ?? null,
            phone: target.phone_number ?? null,
          });
        }
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          ok: false,
          lead_id: target.lead_id ?? null,
          phone: target.phone_number ?? null,
          error: msg,
        });
      }
    }

    console.log(
      `[calls] bulk dispatch: total=${data.targets.length} ok=${queued} fail=${failed}`,
    );
    return { total: data.targets.length, queued, pending, failed, results };
  });

// ============================================================
// DASHBOARD
// ============================================================
export const getCallsDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        range_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Dias em BRT (America/Sao_Paulo) — mesmo critério dos outros dashboards.
    const { parseBrtDayStart, parseBrtDayEnd, brtDayStart, brtDayEnd } =
      await import("./tz");
    let sinceDate: Date;
    let endDate: Date;
    if (data.from && data.to) {
      sinceDate = parseBrtDayStart(data.from);
      endDate = parseBrtDayStart(data.to);
    } else {
      const rd = data.range_days ?? 7;
      endDate = brtDayStart();
      sinceDate = new Date(endDate.getTime() - (rd - 1) * 86400000);
    }
    const rangeDays = Math.max(
      1,
      Math.round((endDate.getTime() - sinceDate.getTime()) / 86400000) + 1,
    );
    let sinceIso = sinceDate.toISOString();
    const endIso = (data.from && data.to ? parseBrtDayEnd(data.to) : brtDayEnd(endDate)).toISOString();
    let startToday = new Date(endDate);
    let startTodayIso = startToday.toISOString();

    // Respeita o marco "zerar dashboards"
    const { readResetAtAdmin } = await import("@/lib/dashboard-settings.functions");
    const resetAt = await readResetAtAdmin();
    if (resetAt > sinceIso) sinceIso = resetAt;
    if (resetAt > startTodayIso) {
      startTodayIso = resetAt;
      startToday = new Date(resetAt);
    }

    // 1. Histórico do período
    const { data: history, error: hErr } = await supabase
      .from("call_history")
      .select(
        "id, status, duration_seconds, created_at, script_id, lead_id, provider",
      )
      .gte("created_at", sinceIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: false });
    if (hErr) throw new Error(hErr.message);
    const rows = history ?? [];

    function emptyCounters() {
      return {
        total: 0,
        answered: 0,
        not_answered: 0,
        busy: 0,
        failed: 0,
        completed: 0,
        converted: 0,
        avg_duration_seconds: 0,
      };
    }

    const totals = emptyCounters();
    const today = emptyCounters();
    let totalDur = 0;
    let totalDurCount = 0;
    let todayDur = 0;
    let todayDurCount = 0;

    for (const r of rows) {
      totals.total += 1;
      if (r.status && (totals as any)[r.status] !== undefined) {
        (totals as any)[r.status] += 1;
      }
      if (r.duration_seconds != null) {
        totalDur += r.duration_seconds;
        totalDurCount += 1;
      }
      if (r.created_at >= startTodayIso) {
        today.total += 1;
        if (r.status && (today as any)[r.status] !== undefined) {
          (today as any)[r.status] += 1;
        }
        if (r.duration_seconds != null) {
          todayDur += r.duration_seconds;
          todayDurCount += 1;
        }
      }
    }
    totals.avg_duration_seconds = totalDurCount
      ? Math.round(totalDur / totalDurCount)
      : 0;
    today.avg_duration_seconds = todayDurCount
      ? Math.round(todayDur / todayDurCount)
      : 0;

    // 2. Pendentes na fila
    const { count: pendingCount } = await supabase
      .from("call_queue")
      .select("id", { count: "exact", head: true })
      .in("status", [
        "pending_audio",
        "audio_ready",
        "queued",
        "waiting_provider",
        "calling",
      ]);

    // 3. Série diária
    const dayMap = new Map<
      string,
      { total: number; answered: number; failed: number }
    >();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, { total: 0, answered: 0, failed: 0 });
    }
    for (const r of rows) {
      const key = (r.created_at as string).slice(0, 10);
      const slot = dayMap.get(key);
      if (!slot) continue;
      slot.total += 1;
      if (r.status === "answered" || r.status === "completed" || r.status === "converted") {
        slot.answered += 1;
      }
      if (r.status === "failed") slot.failed += 1;
    }
    const by_day = Array.from(dayMap.entries()).map(([date, v]) => ({
      date,
      ...v,
    }));

    // 4. Top scripts
    const scriptAgg = new Map<
      string,
      { total: number; answered: number }
    >();
    for (const r of rows) {
      if (!r.script_id) continue;
      const agg = scriptAgg.get(r.script_id) ?? { total: 0, answered: 0 };
      agg.total += 1;
      if (r.status === "answered" || r.status === "completed" || r.status === "converted") {
        agg.answered += 1;
      }
      scriptAgg.set(r.script_id, agg);
    }
    const topIds = Array.from(scriptAgg.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);
    let topScriptsNames: Record<string, string> = {};
    if (topIds.length > 0) {
      const { data: scripts } = await supabase
        .from("call_scripts")
        .select("id, name")
        .in("id", topIds.map(([id]) => id));
      for (const s of scripts ?? []) topScriptsNames[s.id] = s.name as string;
    }
    const top_scripts = topIds.map(([id, v]) => ({
      script_id: id,
      name: topScriptsNames[id] ?? "Script removido",
      total: v.total,
      answered: v.answered,
    }));

    // 5. Últimas 10 com lead + script
    const recentRaw = rows.slice(0, 10);
    const leadIds = Array.from(
      new Set(recentRaw.map((r) => r.lead_id).filter(Boolean)),
    ) as string[];
    const scriptIds = Array.from(
      new Set(recentRaw.map((r) => r.script_id).filter(Boolean)),
    ) as string[];
    const leadMap: Record<string, string> = {};
    const scriptMap: Record<string, string> = {};
    if (leadIds.length) {
      const { data: leads } = await supabase
        .from("players")
        .select("id, nome")
        .in("id", leadIds);
      for (const l of leads ?? []) leadMap[l.id] = l.nome as string;
    }
    if (scriptIds.length) {
      const { data: scripts } = await supabase
        .from("call_scripts")
        .select("id, name")
        .in("id", scriptIds);
      for (const s of scripts ?? []) scriptMap[s.id] = s.name as string;
    }
    const recent = recentRaw.map((r) => ({
      id: r.id,
      status: r.status,
      duration_seconds: r.duration_seconds,
      created_at: r.created_at,
      provider: r.provider,
      lead_nome: r.lead_id ? (leadMap[r.lead_id] ?? "—") : "Avulso",
      script_name: r.script_id ? (scriptMap[r.script_id] ?? "—") : "—",
    }));

    return {
      range_days: rangeDays,
      totals: { ...totals, pending: pendingCount ?? 0 },
      today,
      by_day,
      top_scripts,
      recent,
    };
  });

// ============================================================
// REFRESH STATUS — consulta GET no BusinessCode/Infobip e sincroniza
// ============================================================
function mapBcStatusToHistory(s: string | null | undefined): string | null {
  if (!s) return null;
  const map: Record<string, string> = {
    queued: "pending",
    sent: "pending",
    delivered: "answered",
    answered: "answered",
    completed: "completed",
    failed: "failed",
    rejected: "failed",
    bounced: "failed",
    no_answer: "no_answer",
    busy: "busy",
    canceled: "cancelled",
    cancelled: "cancelled",
  };
  return map[s] ?? null;
}

export const refreshCallDispatchStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ call_history_id: dbUuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: h, error: hErr } = await supabase
      .from("call_history")
      .select("id, call_queue_id, provider_response, provider_call_id")
      .eq("id", data.call_history_id)
      .maybeSingle();
    if (hErr) throw new Error(hErr.message);
    if (!h) throw new Error("Registro de histórico não encontrado");

    const pr = (h.provider_response ?? {}) as any;
    const dispatchId =
      pr?.dispatch_id ??
      pr?.data?.id ??
      (typeof pr?._links?.status === "string"
        ? Number(pr._links.status.split("/").pop())
        : null);
    if (!dispatchId) {
      throw new Error(
        "Sem dispatch_id na resposta original — não dá pra consultar status.",
      );
    }

    const res = await fetchBusinessCodeDispatchStatus(dispatchId);
    if (!res.ok) {
      throw new Error(
        `BusinessCode retornou ${res.status} ao consultar status: ${JSON.stringify(
          res.body,
        ).slice(0, 300)}`,
      );
    }
    const body = (res.body ?? {}) as any;
    const d = body?.data ?? body;
    const bcStatus: string | null = d?.status ?? null;
    const voiceStatus: string | null = d?.voice_status ?? null;
    const durationSec: number | null =
      typeof d?.call_duration_seconds === "number"
        ? d.call_duration_seconds
        : null;
    const errorMessage: string | null = d?.error_message ?? null;

    const newHistStatus =
      mapBcStatusToHistory(voiceStatus) ?? mapBcStatusToHistory(bcStatus);

    await supabase
      .from("call_history")
      .update({
        status: (newHistStatus ?? "pending") as any,
        provider_response: d as any,
        duration_seconds: durationSec,
        error_message: errorMessage,
      })
      .eq("id", h.id);

    if (h.call_queue_id) {
      const finalStatuses = new Set([
        "answered",
        "completed",
        "failed",
        "no_answer",
        "busy",
        "cancelled",
      ]);
      const queueUpdate: Record<string, unknown> = {
        provider_status: voiceStatus ?? bcStatus ?? null,
        provider_response: d as any,
      };
      if (newHistStatus && finalStatuses.has(newHistStatus)) {
        queueUpdate.status =
          newHistStatus === "answered" || newHistStatus === "completed"
            ? "completed"
            : newHistStatus === "cancelled"
              ? "cancelled"
              : "failed";
      }
      await supabase
        .from("call_queue")
        .update(queueUpdate as any)
        .eq("id", h.call_queue_id);
    }

    return {
      ok: true,
      bc_status: bcStatus,
      voice_status: voiceStatus,
      mapped: newHistStatus,
      duration_seconds: durationSec,
      error_message: errorMessage,
      raw: d,
    };
  });