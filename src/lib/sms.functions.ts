// Integracao com a API SMS Short Brasil.
// Doc do cliente: POST http://lp01-short.painelsms.com/bot/single-sms.php
// Headers: usuario: <usuario>, chave: <chave>, Content-Type: application/json
// Body: { celular: "11988887777", mensagem: "...", parceiroId?: "<id>" }
import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildPlayerVariables } from "./template-vars.server";
import type { Json } from "@/integrations/supabase/types";

const DEFAULT_SHORT_BRASIL_SINGLE_URL = "http://lp01-short.painelsms.com/bot/single-sms.php";
const DEFAULT_SHORT_BRASIL_BULK_URL = "http://lp01-short.painelsms.com/bot/bulk-sms.php";

function shortBrasilSingleUrl(): string {
  return process.env.SHORT_BRASIL_SMS_SINGLE_URL ?? DEFAULT_SHORT_BRASIL_SINGLE_URL;
}

function shortBrasilBulkUrl(): string {
  return process.env.SHORT_BRASIL_SMS_BULK_URL ?? DEFAULT_SHORT_BRASIL_BULK_URL;
}

function cleanCredential(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

/** Fingerprint curto e irreversivel so pra confirmar nos logs quais credenciais
 *  estao sendo usadas, sem expor os valores. */
async function credentialFingerprint(value: string): Promise<string> {
  try {
    const buf = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 10);
  } catch {
    return "n/a";
  }
}

function normalizeE164BR(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error("Telefone vazio");
  // já vem com 55 na frente?
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  if (withCountry.length < 12 || withCountry.length > 13) {
    throw new Error(`Telefone inválido: ${raw}`);
  }
  return `+${withCountry}`;
}

function toShortBrasilCell(e164OrRaw: string): string {
  const digits = e164OrRaw.replace(/\D/g, "");
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length < 10 || local.length > 11) {
    throw new Error(`Telefone invalido para Short Brasil: ${e164OrRaw}`);
  }
  return local;
}

function renderSmsVariables(
  content: string,
  variables?: Record<string, string | number> | null,
): string {
  if (!variables || Object.keys(variables).length === 0) return content;
  return content.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function shortBrasilCredentials(): { usuario: string; chave: string } {
  return {
    usuario: cleanCredential(process.env.SHORT_BRASIL_SMS_USUARIO),
    chave: cleanCredential(process.env.SHORT_BRASIL_SMS_CHAVE),
  };
}

function getShortBrasilAppStatus(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).status;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function isShortBrasilApplicationError(body: unknown): boolean {
  const status = getShortBrasilAppStatus(body);
  return status === 101 || status === 303 || status === 404 || status === 505;
}

async function callShortBrasil(
  to: string,
  content: string,
  variables?: Record<string, string | number> | null,
) {
  const { usuario, chave } = shortBrasilCredentials();
  if (!usuario || !chave) {
    console.error("SMS Short Brasil credentials missing");
    return {
      ok: false as const,
      status: 0,
      body: { error: "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados" },
      idempotencyKey: "",
    };
  }
  const usuarioFp = await credentialFingerprint(usuario);
  const idempotencyKey = crypto.randomUUID();
  let res: Response;
  const payload = {
    celular: toShortBrasilCell(to),
    mensagem: renderSmsVariables(content, variables),
    parceiroId: idempotencyKey,
  };
  const maxAttempts = 6;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      console.info("SMS Short Brasil request started", {
        to,
        idempotencyKey,
        usuarioFp,
        attempt,
      });
      res = await fetch(shortBrasilSingleUrl(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          usuario,
          chave,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("SMS Short Brasil request failed before response", {
        to,
        idempotencyKey,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return {
        ok: false as const,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
      };
    }
    if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts) {
      console.warn("SMS Short Brasil 5xx - retrying", {
        to,
        idempotencyKey,
        status: res.status,
        attempt,
      });
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    break;
  }
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    const snippet = text.slice(0, 400);
    const looksLikeHtml = /<html|<!doctype/i.test(text);
    body = {
      non_json: true,
      content_type: res.headers.get("content-type") ?? null,
      looks_like_html: looksLikeHtml,
      snippet,
    };
  }
  const appError = isShortBrasilApplicationError(body);
  console.info("SMS Short Brasil response received", {
    to,
    idempotencyKey,
    status: res.status,
    ok: res.ok && !appError,
    attempts: attempt,
  });
  return { ok: res.ok && !appError, status: res.status, body, idempotencyKey };
}

/**
 * Envia 1 SMS para N destinatarios em uma unica chamada HTTP usando o
 * endpoint /bot/bulk-sms.php da Short Brasil. O provedor aceita ate
 * 5000 mensagens por requisicao.
 *
 * Mantemos o nome exportado antigo para compatibilidade interna.
 */
export async function callShortBrasilSmsBulk(args: {
  content: string;
  recipients: string[]; // ja normalizados E.164
  variables?: Record<string, string | number> | null;
}): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  dispatchId: string | null;
  temporary?: boolean;
}> {
  const { usuario, chave } = shortBrasilCredentials();
  if (!usuario || !chave) {
    return {
      ok: false,
      status: 0,
      body: { error: "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados" },
      idempotencyKey: "",
      dispatchId: null,
    };
  }
  const idempotencyKey = crypto.randomUUID();
  const mensagem = renderSmsVariables(args.content, args.variables);
  const payload = {
    bulk: args.recipients.slice(0, 5000).map((to) => ({
      celular: toShortBrasilCell(to),
      mensagem,
      parceiroId: crypto.randomUUID(),
    })),
  };
  const maxAttempts = 3;
  let attempt = 0;
  let res: Response;
  while (true) {
    attempt++;
    try {
      res = await fetch(shortBrasilBulkUrl(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          usuario,
          chave,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return {
        ok: false,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
        dispatchId: null,
        temporary: true,
      };
    }
    if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    break;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { non_json: true, snippet: text.slice(0, 300) };
  }
  const appError = isShortBrasilApplicationError(body);
  let dispatchId: string | null = null;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const cand =
      o.id ??
      o.loteId ??
      o.lote_id ??
      (o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>).id : null);
    if (typeof cand === "string" || typeof cand === "number") {
      dispatchId = String(cand);
    }
  }
  console.info("SMS Short Brasil bulk dispatch", {
    status: res.status,
    ok: res.ok && !appError,
    recipients: args.recipients.length,
    dispatchId,
    attempts: attempt,
  });
  const temporary = (!res.ok || appError) && (res.status === 0 || res.status >= 500);
  return {
    ok: res.ok && !appError,
    status: res.status,
    body,
    idempotencyKey,
    dispatchId,
    temporary,
  };
}

async function logSend(row: {
  to: string;
  content: string;
  status: "sent" | "pending" | "error";
  provider_response: unknown;
  error: string | null;
  idempotency_key: string;
  provider_message_id?: string | null;
  player_id?: string | null;
  flow_id?: string | null;
  trigger_name?: string | null;
  step_index?: number | null;
  step_label?: string | null;
  flow_lead_id?: string | null;
  tenant_id?: string | null;
}) {
  const { error } = await supabaseAdmin.from("sms_send_logs").insert({
    to_phone: row.to,
    content: row.content,
    status: row.status,
    provider: "short-brasil",
    provider_response: (row.provider_response ?? {}) as Json,
    error: row.error,
    idempotency_key: row.idempotency_key || null,
    provider_message_id: row.provider_message_id ?? null,
    delivery_status: row.status === "error" ? "failed" : "sent",
    player_id: row.player_id ?? null,
    flow_id: row.flow_id ?? null,
    trigger_name: row.trigger_name ?? null,
    step_index: row.step_index ?? null,
    step_label: row.step_label ?? null,
    flow_lead_id: row.flow_lead_id ?? null,
    ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}),
  });
  if (error) {
    console.error("Failed to persist SMS send log", { to: row.to, error: error.message });
    throw new Error(`Falha ao registrar envio SMS: ${error.message}`);
  }
}

function extractProviderMessageId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const data = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : null;
  const candidates = [
    o.id,
    o.message_id,
    o.messageId,
    o.sms_id,
    o.smsId,
    o.parceiroId,
    data?.id,
    data?.message_id,
    data?.parceiroId,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function summarizeProviderError(status: number, body: unknown): string {
  if (status === 0) {
    if (body && typeof body === "object" && "error" in body) {
      return `Sem resposta do provedor: ${String((body as { error: unknown }).error)}`;
    }
    return "Sem resposta do provedor";
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.non_json) {
      return `Provedor Short Brasil retornou HTTP ${status} (resposta nao-JSON - endpoint pode estar incorreto ou credenciais invalidas).`;
    }
    const appStatus = getShortBrasilAppStatus(body);
    if (appStatus === 101) return "Short Brasil: erro de autenticacao";
    if (appStatus === 303) return "Short Brasil: erro de requisicao";
    if (appStatus === 404) return "Short Brasil: transacao nao encontrada";
    if (appStatus === 505) return "Short Brasil: saldo insuficiente";
    const msg =
      (typeof b.statusDetalhe === "string" && b.statusDetalhe) ||
      (typeof b.detalhe === "string" && b.detalhe) ||
      (typeof b.message === "string" && b.message) ||
      (typeof b.error === "string" && b.error) ||
      (b.error &&
        typeof b.error === "object" &&
        "message" in (b.error as object) &&
        String((b.error as { message: unknown }).message)) ||
      null;
    if (msg) {
      if (status === 401 || appStatus === 101) {
        return `Short Brasil recusou as credenciais (HTTP ${status}: ${msg}). Confira SHORT_BRASIL_SMS_USUARIO e SHORT_BRASIL_SMS_CHAVE.`;
      }
      return `HTTP ${status}: ${msg}`;
    }
  }
  return `HTTP ${status} do provedor`;
}

/** Envia um SMS, registra log e retorna o resultado. Server-only. */
export async function sendSmsInternal(args: {
  to: string;
  content: string;
  playerId?: string | null;
  flowId?: string | null;
  triggerName?: string | null;
  variables?: Record<string, string | number> | null;
  stepIndex?: number | null;
  stepLabel?: string | null;
  flowLeadId?: string | null;
  tenantId?: string | null;
}) {
  let normalized: string;
  try {
    normalized = normalizeE164BR(args.to);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSend({
      to: args.to,
      content: args.content,
      status: "error",
      provider_response: {},
      error: msg,
      idempotency_key: "",
      player_id: args.playerId,
      flow_id: args.flowId,
      trigger_name: args.triggerName,
      step_index: args.stepIndex,
      step_label: args.stepLabel,
      flow_lead_id: args.flowLeadId,
      tenant_id: args.tenantId ?? null,
    });
    return { ok: false, error: msg };
  }

  const r = await callShortBrasil(normalized, args.content, args.variables);
  const providerMessageId = r.ok ? extractProviderMessageId(r.body) : null;
  const errorSummary = r.ok ? null : summarizeProviderError(r.status, r.body);
  const isTemporary = !r.ok && (r.status === 0 || r.status === 429 || r.status >= 500);
  await logSend({
    to: normalized,
    content: args.content,
    status: r.ok ? "sent" : isTemporary ? "pending" : "error",
    provider_response: r.body,
    error: errorSummary,
    idempotency_key: r.idempotencyKey,
    provider_message_id: providerMessageId,
    player_id: args.playerId,
    flow_id: args.flowId,
    trigger_name: args.triggerName,
    step_index: args.stepIndex,
    step_label: args.stepLabel,
    flow_lead_id: args.flowLeadId,
    tenant_id: args.tenantId ?? null,
  });

  return r.ok
    ? { ok: true as const, status: r.status, response: JSON.stringify(r.body ?? null) }
    : {
        ok: false as const,
        status: r.status,
        error: errorSummary ?? `HTTP ${r.status}`,
        temporary: isTemporary,
        body: JSON.stringify(r.body ?? null),
      };
}

// ---------------- Server functions expostas pra UI ----------------

export const smsProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return {
      configured: Boolean(
        process.env.SHORT_BRASIL_SMS_USUARIO && process.env.SHORT_BRASIL_SMS_CHAVE,
      ),
      provider: "Short Brasil",
      endpoint: DEFAULT_SHORT_BRASIL_SINGLE_URL,
      callbackPath: "/api/public/sms-webhook",
    };
  });

export const sendTestSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        to: z.string().min(8).max(20),
        content: z.string().min(1).max(480),
        playerId: dbUuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let variables: Record<string, string> | null = null;
    if (data.playerId) {
      const { data: p } = await supabaseAdmin
        .from("players")
        .select(
          "nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
        )
        .eq("id", data.playerId)
        .maybeSingle();
      if (p) {
        variables = buildPlayerVariables(p);
      }
    }
    return sendSmsInternal({
      to: data.to,
      content: data.content,
      playerId: data.playerId ?? null,
      triggerName: "teste-manual",
      variables,
    });
  });

export const listSmsLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("sms_send_logs")
      .select(
        "id, to_phone, content, status, error, provider_response, trigger_name, created_at, delivery_status, delivered_at, provider_message_id",
      )
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { logs: data ?? [] };
  });

/** Dispara o fluxo SMS configurado para um determinado gatilho de um player.
 *  Renderiza variáveis e envia o primeiro step imediatamente.
 *  (Steps com delay > 0 podem ser processados por um dispatcher futuro.) */
export const triggerSmsFlowNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        playerId: dbUuid(),
        triggerName: z.string().min(1).max(80),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: flow } = await supabaseAdmin
      .from("sms_flows")
      .select("id, trigger_name, is_active")
      .eq("trigger_name", data.triggerName)
      .eq("is_active", true)
      .maybeSingle();
    if (!flow) return { ok: false, error: "Nenhum fluxo SMS ativo para esse gatilho" };

    const { data: steps } = await supabaseAdmin
      .from("sms_flow_steps")
      .select("id, content, order_index, delay_days, is_active, step_type")
      .eq("flow_id", flow.id)
      .eq("is_active", true)
      .eq("step_type", "sms")
      .order("order_index", { ascending: true });
    const first = (steps ?? []).find((s) => (s.delay_days ?? 0) === 0);
    if (!first?.content) return { ok: false, error: "Fluxo sem step inicial sem delay" };

    const { data: player } = await supabaseAdmin
      .from("players")
      .select(
        "id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
      )
      .eq("id", data.playerId)
      .maybeSingle();
    if (!player?.telefone) return { ok: false, error: "Player sem telefone" };

    const variables = buildPlayerVariables(player);
    return sendSmsInternal({
      to: player.telefone,
      content: first.content,
      playerId: player.id,
      flowId: flow.id,
      triggerName: data.triggerName,
      variables,
    });
  });

export const sendBulkSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phones: z.array(z.string().min(8).max(20)).min(0).max(20000).optional().default([]),
        recipients: z
          .array(
            z.object({
              phone: z.string().min(8).max(20),
              playerId: dbUuid().optional(),
            }),
          )
          .max(20000)
          .optional()
          .default([]),
        content: z.string().min(1).max(480),
        campaignName: z.string().min(1).max(120),
        route: z.literal("iGaming").optional().default("iGaming"),
        ratePerMinute: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .default(1000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const trigger = `campanha:${data.campaignName}:${data.route}`;
    const targets: Array<{ phone: string; playerId?: string }> = [
      ...data.recipients,
      ...data.phones.map((p) => ({ phone: p })),
    ];
    if (targets.length === 0) {
      return { total: 0, sent: 0, failed: 0, results: [] };
    }

    // Envios grandes seriam interrompidos pelo timeout do worker (~30s)
    // e deixavam a campanha pela metade. A partir de 50 destinatários,
    // enfileiramos em `sms_campaigns` com `scheduled_at = now()` e deixamos
    // o dispatcher processar em chunks com cursor persistente. O usuário
    // acompanha o progresso na aba Campanhas.
    const QUEUE_THRESHOLD = 50;
    if (targets.length > QUEUE_THRESHOLD) {
      const { data: tenantRow, error: tenantErr } = await context.supabase.rpc(
        "current_tenant_id",
      );
      if (tenantErr) throw new Error(tenantErr.message);
      const tenantId = tenantRow as string | null;
      if (!tenantId) throw new Error("tenant não encontrado para o usuário");
      const resolved = await resolveRecipientsForTenant(
        tenantId,
        targets.filter((t) => !t.playerId).map((t) => t.phone),
        targets.filter((t) => t.playerId) as Array<{ phone: string; playerId?: string }>,
      );
      const { data: inserted, error: insErr } = await context.supabase
        .from("sms_campaigns")
        .insert({
          tenant_id: tenantId,
          name: data.campaignName,
          content: data.content,
          route: data.route,
          recipients: resolved as unknown as Json,
          total_count: resolved.length,
          scheduled_at: new Date().toISOString(),
          status: "agendada",
          rate_per_minute: data.ratePerMinute,
          created_by: context.userId,
        })
        .select("id")
        .single();
      if (insErr) throw new Error(insErr.message);
      console.info("Bulk SMS enfileirado como campanha", {
        campaignName: data.campaignName,
        total: resolved.length,
        campaignId: inserted.id,
      });
      return {
        total: resolved.length,
        sent: 0,
        failed: 0,
        pending: 0,
        results: [],
        queued: true as const,
        campaignId: inserted.id,
      };
    }

    // Auto-match telefone → player para qualquer target sem playerId.
    // Normaliza para apenas dígitos com prefixo "55" (mesmo formato gravado
    // em public.players.telefone), e também tenta sem o "55" caso o CRM
    // guarde no formato antigo.
    const normalizeDigits = (raw: string): string[] => {
      const d = raw.replace(/\D/g, "");
      if (!d) return [];
      const withCountry = d.startsWith("55") ? d : `55${d}`;
      const noCountry = withCountry.slice(2);
      return Array.from(new Set([withCountry, noCountry, d]));
    };

    const phoneLookup = new Map<string, string>(); // digits → playerId
    const unmatchedDigits = new Set<string>();
    for (const t of targets) {
      if (t.playerId) continue;
      for (const d of normalizeDigits(t.phone)) unmatchedDigits.add(d);
    }
    if (unmatchedDigits.size > 0) {
      const { data: matches } = await supabaseAdmin
        .from("players")
        .select("id, telefone")
        .in("telefone", Array.from(unmatchedDigits));
      (matches ?? []).forEach((m) => {
        const d = (m.telefone ?? "").replace(/\D/g, "");
        if (d) phoneLookup.set(d, m.id);
      });
    }
    for (const t of targets) {
      if (t.playerId) continue;
      for (const d of normalizeDigits(t.phone)) {
        const hit = phoneLookup.get(d);
        if (hit) {
          t.playerId = hit;
          break;
        }
      }
    }

    // Carrega variáveis dos players envolvidos (uma query só)
    const playerIds = Array.from(
      new Set(
        targets
          .map((t) => t.playerId)
          .filter((id): id is string => typeof id === "string"),
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

    console.info("Bulk SMS campaign started", {
      campaignName: data.campaignName,
      route: data.route,
      total: targets.length,
    });
    const results: { phone: string; ok: boolean; error?: string; temporary?: boolean }[] = [];
    const concurrency = 5;
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (t) => {
          const variables = t.playerId ? varsByPlayer.get(t.playerId) ?? null : null;
          const r = await sendSmsInternal({
            to: t.phone,
            content: data.content,
            playerId: t.playerId ?? null,
            triggerName: trigger,
            variables,
          });
          return {
            phone: t.phone,
            ok: r.ok,
            error: r.ok ? undefined : (r as { error?: string }).error,
            temporary: r.ok ? false : (r as { temporary?: boolean }).temporary === true,
          };
        }),
      );
      results.push(...batchResults);
    }
    const sent = results.filter((r) => r.ok).length;
    const pending = results.filter((r) => !r.ok && r.temporary).length;
    const failed = results.length - sent - pending;
    console.info("Bulk SMS campaign finished", {
      campaignName: data.campaignName,
      route: data.route,
      total: results.length,
      sent,
      failed,
      pending,
    });
    return { total: results.length, sent, failed, pending, results };
  });

// ============================================================
// Dashboard — métricas reais a partir de sms_send_logs, sms_flows,
// flow_leads e deposits. Retorna shape pronto para o componente.
// ============================================================

const SMS_COST_BRL = 0.08; // custo medio estimado por SMS
const CONVERSION_WINDOW_HOURS = 72;

function dayKey(d: Date): string {
  // Chave do dia em horário de Brasília (UTC-3 fixo), para que envios
  // feitos à noite no Brasil não pulem para o dia seguinte em UTC.
  const shifted = new Date(d.getTime() - 3 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function denseSeries(
  rangeDays: number,
  buckets: Map<string, { enviados: number; entregues: number; conversoes: number }>,
  endDate?: Date,
) {
  const out: Array<{
    date: string;
    enviados: number;
    entregues: number;
    conversoes: number;
  }> = [];
  // endDate vem como 00:00 BRT (= 03:00 UTC) do último dia do período.
  // Iteramos por dias de calendário BRT para que o eixo do gráfico bata
  // exatamente com os dias mostrados na UI.
  const anchor = endDate ? new Date(endDate) : new Date();
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(anchor.getTime() - i * 86400000);
    const k = dayKey(d);
    const b = buckets.get(k);
    out.push({
      date: k,
      enviados: b?.enviados ?? 0,
      entregues: b?.entregues ?? 0,
      conversoes: b?.conversoes ?? 0,
    });
  }
  return out;
}

function mapDispatchStatus(raw: string | null | undefined): {
  delivery_status: "delivered" | "failed" | "sent";
  isFinal: boolean;
} {
  if (!raw) return { delivery_status: "sent", isFinal: false };
  const s = String(raw).toLowerCase().trim();
  if (
    [
      "delivered",
      "entregue",
      "delivrd",
      "received",
      "completed",
      "success",
      "ok",
      "sent_to_handset",
    ].includes(s)
  ) {
    return { delivery_status: "delivered", isFinal: true };
  }
  if (
    [
      "failed",
      "falhou",
      "error",
      "undeliverable",
      "undelivered",
      "rejected",
      "expired",
      "canceled",
      "cancelled",
    ].includes(s)
  ) {
    return { delivery_status: "failed", isFinal: true };
  }
  return { delivery_status: "sent", isFinal: false };
}

function pickDispatchStatus(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body.status,
    body.state,
    body.delivery_status,
    body.deliveryStatus,
    body?.data?.status,
    body?.data?.state,
    body?.dispatch?.status,
    body?.result?.status,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/**
 * A Short Brasil envia os status por callback em /api/public/sms-webhook.
 * Mantemos este hook como no-op para compatibilidade com o cron existente.
 */
export async function refreshSmsDeliveryStatusInternal(): Promise<{ processed: number }> {
  return { processed: 0 };
}

async function processOne(
  _row: { id: string; provider_response: unknown; created_at: string },
  _token: string,
  _stats: { calls: number; fiveXx: number; lastStatus: number },
): Promise<void> {
  return;
}

export const getSmsDashboard = createServerFn({ method: "POST" })
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
    // Dashboard = leitura pura do banco (rápido). O refresh de delivery_status
    // por callback da Short Brasil em /api/public/sms-webhook.

    // Resolve tenant do usuário autenticado — todas as queries do dashboard
    // DEVEM ser filtradas por tenant para não misturar dados de outros tenants.
    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc(
      "current_tenant_id",
    );
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    // Resolve período em America/Sao_Paulo (BRT). As datas YYYY-MM-DD vindas
    // do front representam dias do calendário em Brasília — não em UTC.
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

    // "Hoje" = último dia BRT do período (mostra o dia mais recente do range)
    let todayStart = new Date(endDate);
    let todayIso = todayStart.toISOString();

    // Respeita o marco "zerar dashboards"
    const { readResetAtAdmin } = await import("@/lib/dashboard-settings.functions");
    const resetAt = await readResetAtAdmin();
    if (resetAt > sinceIso) sinceIso = resetAt;
    if (resetAt > todayIso) {
      todayIso = resetAt;
      todayStart = new Date(resetAt);
    }

    // 1) Logs no período (uma linha por envio — já é único por id)
    // PostgREST limita cada request a 1000 linhas; paginamos para pegar tudo.
    const rows: Array<{
      id: string;
      status: string | null;
      delivery_status: string | null;
      created_at: string;
      player_id: string | null;
      to_phone: string | null;
    }> = [];
    {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data: chunk, error: logsErr } = await supabaseAdmin
          .from("sms_send_logs")
          .select("id, status, delivery_status, created_at, player_id, to_phone")
          .eq("tenant_id", tenantId)
          .gte("created_at", sinceIso)
          .lte("created_at", endIso)
          .order("created_at", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (logsErr) throw new Error(logsErr.message);
        const got = (chunk ?? []) as typeof rows;
        rows.push(...got);
        if (got.length < PAGE) break;
        offset += PAGE;
        if (offset >= 200_000) break; // sanity guard
      }
    }

    // 2) Pendentes (sem janela — fila atual)
    const { count: pendingCount } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "pending");

    // 2b) Fila REAL do dispatcher (sms_flow_leads prontos pra disparar).
    const { count: queueDue } = await supabaseAdmin
      .from("sms_flow_leads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "running"])
      .lte("next_run_at", new Date().toISOString());
    const { count: queueTotal } = await supabaseAdmin
      .from("sms_flow_leads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["pending", "running"]);

    // 3) Fluxos ativos
    const { count: activeFlows } = await supabaseAdmin
      .from("sms_flows")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("is_active", true);

    // 4) Players atualmente em fluxo SMS (flow_leads ativos atrelados a sms_flows)
    const { data: smsFlowIds } = await supabaseAdmin
      .from("sms_flows")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    const flowIdList = (smsFlowIds ?? []).map((r) => r.id);
    let playersInFlow = 0;
    if (flowIdList.length > 0) {
      const { data: leadsInFlow } = await supabaseAdmin
        .from("flow_leads")
        .select("player_id")
        .eq("tenant_id", tenantId)
        .in("flow_id", flowIdList)
        .in("status", ["pending", "running"]);
      const set = new Set<string>();
      (leadsInFlow ?? []).forEach((l) => {
        if (l.player_id) set.add(l.player_id);
      });
      playersInFlow = set.size;
    }

    // 5) Conversões: para cada SMS 'sent' com player_id, conferir se houve depósito
    // dentro da janela CONVERSION_WINDOW_HOURS após o envio.
    const sentRowsWithPlayer = rows.filter(
      (r) => r.status === "sent" && !!r.player_id,
    );
    const playerIds = Array.from(
      new Set(sentRowsWithPlayer.map((r) => r.player_id as string)),
    );
    let depositsByPlayer = new Map<string, Array<{ created_at: string; valor: number }>>();
    if (playerIds.length > 0) {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data: deps } = await supabaseAdmin
          .from("deposits")
          .select("player_id, created_at, valor")
          .eq("tenant_id", tenantId)
          .in("player_id", playerIds)
          .eq("status", "aprovado")
          .gte("created_at", sinceIso)
          .lte("created_at", endIso)
          .range(offset, offset + PAGE - 1);
        const got = deps ?? [];
        got.forEach((d) => {
          if (!d.player_id) return;
          const arr = depositsByPlayer.get(d.player_id) ?? [];
          arr.push({ created_at: d.created_at, valor: Number(d.valor) || 0 });
          depositsByPlayer.set(d.player_id, arr);
        });
        if (got.length < PAGE) break;
        offset += PAGE;
        if (offset >= 200_000) break;
      }
    }

    // Buckets por dia
    const buckets = new Map<
      string,
      { enviados: number; entregues: number; conversoes: number }
    >();
    const ensure = (k: string) => {
      let b = buckets.get(k);
      if (!b) {
        b = { enviados: 0, entregues: 0, conversoes: 0 };
        buckets.set(k, b);
      }
      return b;
    };

    let sentTotal = 0;
    let deliveredTotal = 0;
    let failedTotal = 0;
    let todaySent = 0;
    let todayDelivered = 0;
    let todayFailed = 0;
    const uniquePhonesPeriod = new Set<string>();
    const uniquePhonesToday = new Set<string>();

    for (const r of rows) {
      const created = new Date(r.created_at);
      const k = dayKey(created);
      const b = ensure(k);
      const isFailed = r.status === "error" || r.delivery_status === "failed";
      const isDelivered = r.delivery_status === "delivered";
      const isSent = r.status === "sent";
      if (isSent) {
        sentTotal++;
        b.enviados++;
        if (created >= todayStart) todaySent++;
        if (r.to_phone) {
          uniquePhonesPeriod.add(r.to_phone);
          if (created >= todayStart) uniquePhonesToday.add(r.to_phone);
        }
      }
      if (isDelivered) {
        deliveredTotal++;
        b.entregues++;
        if (created >= todayStart) todayDelivered++;
      }
      if (isFailed) {
        failedTotal++;
        if (created >= todayStart) todayFailed++;
      }
    }

    // Conversões e ROI
    let conversions = 0;
    let convertedRevenue = 0;
    const countedPlayer = new Set<string>();
    for (const r of sentRowsWithPlayer) {
      const pid = r.player_id as string;
      const sentAt = new Date(r.created_at).getTime();
      const windowEnd = sentAt + CONVERSION_WINDOW_HOURS * 3600 * 1000;
      const deps = depositsByPlayer.get(pid) ?? [];
      const matched = deps.find((d) => {
        const t = new Date(d.created_at).getTime();
        return t >= sentAt && t <= windowEnd;
      });
      if (matched && !countedPlayer.has(pid)) {
        countedPlayer.add(pid);
        conversions++;
        // soma todos os depósitos do player dentro da janela
        for (const d of deps) {
          const t = new Date(d.created_at).getTime();
          if (t >= sentAt && t <= windowEnd) convertedRevenue += d.valor;
        }
        const k = dayKey(new Date(matched.created_at));
        ensure(k).conversoes++;
      }
    }

    const totalCost = sentTotal * SMS_COST_BRL;
    const roi_brl = Math.max(0, convertedRevenue - totalCost);

    const series = denseSeries(rangeDays, buckets, endDate);

    return {
      today: {
        sent: todaySent,
        delivered: todayDelivered,
        failed: todayFailed,
        unique_recipients: uniquePhonesToday.size,
      },
      totals: {
        sent: sentTotal,
        delivered: deliveredTotal,
        failed: failedTotal,
        pending: pendingCount ?? 0,
        queue_due: queueDue ?? 0,
        queue_total: queueTotal ?? 0,
        active_flows: activeFlows ?? 0,
        players_in_flow: playersInFlow,
        conversions,
        revenue_brl: Number(convertedRevenue.toFixed(2)),
        roi_brl: Number(roi_brl.toFixed(2)),
        unique_recipients: uniquePhonesPeriod.size,
      },
      by_day: series.map((s) => ({
        date: s.date,
        enviados: s.enviados,
        entregues: s.entregues,
      })),
      conversions_by_day: series.map((s) => ({
        date: s.date,
        conversoes: s.conversoes,
      })),
    };
  });

// ============================================================
// Reenvio de SMS que falharam
// ============================================================

// Janela do dia em BRT (UTC-3) → ISO UTC
function brtDayWindow(dateIso: string): { start: string; end: string } {
  // dateIso: "YYYY-MM-DD" representando dia de calendário BRT
  const start = new Date(`${dateIso}T00:00:00-03:00`).toISOString();
  const end = new Date(`${dateIso}T23:59:59.999-03:00`).toISOString();
  return { start, end };
}

async function requireAdmin(userId: string) {
  const { data: isAdmin } = await supabaseAdmin.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Apenas administradores podem reenviar SMS");
}

/** Conta as falhas do dia separadas por causa, para o diálogo de reenvio. */
export const getFailedSmsBreakdown = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { start, end } = brtDayWindow(data.date);

    const { count: rateLimited } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", start)
      .lte("created_at", end)
      .eq("status", "error")
      .like("error", "HTTP 429%");

    const { count: carrierFailed } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", start)
      .lte("created_at", end)
      .eq("status", "sent")
      .eq("delivery_status", "failed");

    return {
      date: data.date,
      rate_limited: rateLimited ?? 0,
      carrier_failed: carrierFailed ?? 0,
    };
  });

/** Reenvia os SMS que falharam no dia. Deduplica por (telefone + conteúdo)
 *  e evita reenviar para quem já recebeu o mesmo conteúdo com sucesso. */
export const resendFailedSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        includeRateLimited: z.boolean().default(true),
        includeCarrierFailed: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { start, end } = brtDayWindow(data.date);

    type Row = {
      to_phone: string;
      content: string;
      player_id: string | null;
      trigger_name: string | null;
    };
    const rows: Row[] = [];

    if (data.includeRateLimited) {
      const { data: r1 } = await supabaseAdmin
        .from("sms_send_logs")
        .select("to_phone, content, player_id, trigger_name")
        .gte("created_at", start)
        .lte("created_at", end)
        .eq("status", "error")
        .like("error", "HTTP 429%");
      if (r1) rows.push(...r1);
    }
    if (data.includeCarrierFailed) {
      const { data: r2 } = await supabaseAdmin
        .from("sms_send_logs")
        .select("to_phone, content, player_id, trigger_name")
        .gte("created_at", start)
        .lte("created_at", end)
        .eq("status", "sent")
        .eq("delivery_status", "failed");
      if (r2) rows.push(...r2);
    }

    // Deduplica por telefone+conteúdo
    const unique = new Map<string, Row>();
    for (const r of rows) {
      const key = `${r.to_phone}::${r.content}`;
      if (!unique.has(key)) unique.set(key, r);
    }
    const totalCandidates = unique.size;
    if (totalCandidates === 0) {
      return { total: 0, sent: 0, failed: 0, skipped_already_delivered: 0 };
    }

    // Pula quem já recebeu o mesmo conteúdo com entrega confirmada
    // (delivered) ou ainda em trânsito (sent) nas últimas 24h, para não
    // duplicar para destinatários que já receberam.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const phones = Array.from(new Set([...unique.values()].map((r) => r.to_phone)));
    const skipKeys = new Set<string>();
    // Quebra em lotes de 200 pra evitar URL muito longa no .in()
    for (let i = 0; i < phones.length; i += 200) {
      const chunk = phones.slice(i, i + 200);
      const { data: recent } = await supabaseAdmin
        .from("sms_send_logs")
        .select("to_phone, content, status, delivery_status, created_at")
        .in("to_phone", chunk)
        .gte("created_at", since)
        .eq("status", "sent")
        .in("delivery_status", ["delivered", "sent"]);
      (recent ?? []).forEach((r) => {
        skipKeys.add(`${r.to_phone}::${r.content}`);
      });
    }

    const toResend = [...unique.entries()].filter(([k]) => !skipKeys.has(k)).map(([, r]) => r);
    const skippedAlreadyDelivered = totalCandidates - toResend.length;

    if (toResend.length === 0) {
      return {
        total: totalCandidates,
        sent: 0,
        failed: 0,
        skipped_already_delivered: skippedAlreadyDelivered,
      };
    }

    // Pré-carrega variáveis dos players envolvidos
    const playerIds = Array.from(
      new Set(
        toResend
          .map((r) => r.player_id)
          .filter((id): id is string => typeof id === "string"),
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

    console.info("SMS resend started", {
      date: data.date,
      totalCandidates,
      toResend: toResend.length,
      skippedAlreadyDelivered,
    });

    let sent = 0;
    let failed = 0;
    const concurrency = 4;
    for (let i = 0; i < toResend.length; i += concurrency) {
      const batch = toResend.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (r) => {
          const variables = r.player_id ? varsByPlayer.get(r.player_id) ?? null : null;
          return sendSmsInternal({
            to: r.to_phone,
            content: r.content,
            playerId: r.player_id,
            triggerName: `resend_failed:${r.trigger_name ?? "manual"}`,
            variables,
          });
        }),
      );
      for (const res of results) {
        if (res.ok) sent++;
        else failed++;
      }
      // pequena pausa entre lotes pra não estourar rate limit de novo
      if (i + concurrency < toResend.length) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    console.info("SMS resend finished", {
      date: data.date,
      sent,
      failed,
      skipped_already_delivered: skippedAlreadyDelivered,
    });

    return {
      total: totalCandidates,
      sent,
      failed,
      skipped_already_delivered: skippedAlreadyDelivered,
    };
  });

// ============================================================
// Campanhas de SMS agendadas (envio em massa com horário programado)
// ============================================================

const ScheduleBulkSchema = z.object({
  phones: z.array(z.string().min(8).max(20)).min(0).max(20000).optional().default([]),
  recipients: z
    .array(
      z.object({
        phone: z.string().min(8).max(20),
        playerId: dbUuid().optional(),
      }),
    )
    .max(20000)
    .optional()
    .default([]),
  content: z.string().min(1).max(480),
  campaignName: z.string().min(1).max(120),
  route: z.literal("iGaming").optional().default("iGaming"),
  scheduledAt: z.string().min(1),
  ratePerMinute: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .default(1000),
});

/** Match telefone → playerId dentro do tenant, mesmo shape usado em sendBulkSms. */
async function resolveRecipientsForTenant(
  tenantId: string,
  phones: string[],
  recipients: Array<{ phone: string; playerId?: string }>,
): Promise<Array<{ phone: string; playerId?: string }>> {
  const targets: Array<{ phone: string; playerId?: string }> = [
    ...recipients,
    ...phones.map((p) => ({ phone: p })),
  ];
  const normalizeDigits = (raw: string): string[] => {
    const d = raw.replace(/\D/g, "");
    if (!d) return [];
    const withCountry = d.startsWith("55") ? d : `55${d}`;
    const noCountry = withCountry.slice(2);
    return Array.from(new Set([withCountry, noCountry, d]));
  };
  const unmatched = new Set<string>();
  for (const t of targets) {
    if (t.playerId) continue;
    for (const d of normalizeDigits(t.phone)) unmatched.add(d);
  }
  if (unmatched.size > 0) {
    const { data: matches } = await supabaseAdmin
      .from("players")
      .select("id, telefone")
      .eq("tenant_id", tenantId)
      .in("telefone", Array.from(unmatched));
    const lookup = new Map<string, string>();
    (matches ?? []).forEach((m) => {
      const d = (m.telefone ?? "").replace(/\D/g, "");
      if (d) lookup.set(d, m.id);
    });
    for (const t of targets) {
      if (t.playerId) continue;
      for (const d of normalizeDigits(t.phone)) {
        const hit = lookup.get(d);
        if (hit) {
          t.playerId = hit;
          break;
        }
      }
    }
  }
  return targets;
}

export const scheduleBulkSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => ScheduleBulkSchema.parse(input))
  .handler(async ({ data, context }) => {
    const scheduled = new Date(data.scheduledAt);
    if (!Number.isFinite(scheduled.getTime())) {
      throw new Error("Data/hora inválida");
    }
    if (scheduled.getTime() < Date.now() + 60_000) {
      throw new Error("O horário agendado precisa estar pelo menos 1 minuto no futuro");
    }

    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc(
      "current_tenant_id",
    );
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    const targets = await resolveRecipientsForTenant(
      tenantId,
      data.phones,
      data.recipients,
    );
    if (targets.length === 0) throw new Error("Sem destinatários válidos");

    const { data: inserted, error } = await context.supabase
      .from("sms_campaigns")
      .insert({
        tenant_id: tenantId,
        name: data.campaignName,
        content: data.content,
        route: data.route,
        recipients: targets as unknown as Json,
        total_count: targets.length,
        scheduled_at: scheduled.toISOString(),
        status: "agendada",
        rate_per_minute: data.ratePerMinute,
        created_by: context.userId,
      })
      .select("id, name, scheduled_at, total_count, status")
      .single();
    if (error) throw new Error(error.message);
    return inserted;
  });

export const listScheduledSmsCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data, error } = await context.supabase
      .from("sms_campaigns")
      .select(
        "id, name, scheduled_at, status, total_count, sent_count, failed_count, last_error, created_at, updated_at",
      )
      .gte("created_at", since)
      .order("scheduled_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return { campaigns: data ?? [] };
  });

export const cancelScheduledSmsCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: updated, error } = await context.supabase
      .from("sms_campaigns")
      .update({ status: "cancelada" })
      .eq("id", data.id)
      .eq("status", "agendada")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Campanha não pode mais ser cancelada");
    return { ok: true };
  });
