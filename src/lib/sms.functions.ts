// Integracao SMS. A API HTTPS atual usa Bearer token; o formato legado
// usuario/chave continua disponivel apenas para instalacoes que ainda o exigem.
import { createServerFn } from "@tanstack/react-start";
import { tenantChannelHealth } from "@/lib/provider-governance.server";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assertTenantCanOperate,
  assertTenantNotDemoForSend,
  demoSendBlockedReason,
  requireActiveTenantAdmin,
  resolveCurrentTenantId,
  resolveOperationalTenantId,
} from "@/lib/tenant-access.server";
import { buildPlayerVariables } from "./template-vars.server";
import { loadHouseLinks } from "./house-links.server";
import {
  markTrackedDispatchesFailed,
  markTrackedDispatchesSent,
  prepareTrackedText,
} from "./shortio.server";
import type { Json } from "@/integrations/supabase/types";
import { isChannelRevoked } from "./consent.server";
import { requireBrazilianPhone } from "./phone-normalization";
import {
  smsProviderAccountReason,
  transportErrorKind,
  type ProviderErrorKind,
} from "./rate-limit/transport-errors";
import {
  cachedSmsBreaker,
  noteSmsProviderSuccess,
  readSmsBreaker,
  reportSmsProviderAccountFailure,
  smsSuspendedMessage,
} from "./sms-provider-breaker.server";
import type { LinkTrackingContext } from "./shortio.server";
import { conversionFunnelSnapshot } from "./conversion-funnel";
import { campaignShortDomainColumn } from "./campaign-refs.server";
import { normalizeSmsAudienceCriteria } from "./sms-audience-criteria";
import {
  campaignDeliveryKey,
  countUnresolvedByReason,
  noRecipientResolvedMessage,
  type RecipientResolution,
} from "./campaign-recipients";
import {
  isMissingColumnError,
  persistCampaignUnresolved,
  resolveCampaignRecipients,
  type CampaignDb,
} from "./campaign-recipients.server";

const DEFAULT_SHORT_BRASIL_SINGLE_URL = "http://lp01-short.painelsms.com/bot/single-sms.php";
const DEFAULT_SHORT_BRASIL_BULK_URL = "http://lp01-short.painelsms.com/bot/bulk-sms.php";
const DEFAULT_SHORTCODE_MESSAGES_URL = "https://api.shortcode.com.br/messages";
// Mantém a tentativa abaixo do timeout de uma server function. Sem isso, uma
// conexão TCP bloqueada pelo provedor pode deixar o envio preso indefinidamente.
const SHORT_BRASIL_REQUEST_TIMEOUT_MS = 8_000;

const campaignDb = () => supabaseAdmin as unknown as CampaignDb;

/**
 * ENV-06: campaigns send to every recipient that resolves to a player of the
 * tenant and report the rest. Only a campaign with NO resolvable recipient is
 * refused.
 */
async function resolveCampaignTargetsForSend(
  tenantId: string,
  targets: Array<{ phone: string; playerId?: string | null }>,
) {
  const resolution = await resolveCampaignRecipients(campaignDb(), tenantId, targets);
  if (resolution.resolved.length === 0)
    throw new Error(noRecipientResolvedMessage(resolution.unresolved));
  return resolution;
}

function campaignUnresolvedSummary(resolution: RecipientResolution) {
  return {
    unresolvedCount: resolution.unresolved.length,
    unresolvedByReason: countUnresolvedByReason(resolution.unresolved),
    duplicates: resolution.duplicates,
  };
}

function shortBrasilSingleUrl(): string {
  return process.env.SHORT_BRASIL_SMS_SINGLE_URL ?? DEFAULT_SHORT_BRASIL_SINGLE_URL;
}

export function shortBrasilBulkUrl(): string {
  return process.env.SHORT_BRASIL_SMS_BULK_URL ?? DEFAULT_SHORT_BRASIL_BULK_URL;
}

function shortcodeMessagesUrl(): string {
  return process.env.SHORTCODE_SMS_URL ?? DEFAULT_SHORTCODE_MESSAGES_URL;
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
  return requireBrazilianPhone(raw);
}

export function toShortBrasilCell(e164OrRaw: string): string {
  const digits = e164OrRaw.replace(/\D/g, "");
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length < 10 || local.length > 11) {
    throw new Error(`Telefone invalido para Short Brasil: ${e164OrRaw}`);
  }
  return local;
}

export function renderSmsVariables(
  content: string,
  variables?: Record<string, string | number> | null,
): string {
  if (!variables || Object.keys(variables).length === 0) return content;
  return content.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export function shortBrasilCredentials(): { usuario: string; chave: string } {
  return {
    usuario: cleanCredential(process.env.SHORT_BRASIL_SMS_USUARIO),
    chave: cleanCredential(process.env.SHORT_BRASIL_SMS_CHAVE),
  };
}

export function shortcodeToken(): string {
  return cleanCredential(process.env.SHORTCODE_SMS_TOKEN);
}

async function shortBrasilFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHORT_BRASIL_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Short Brasil não respondeu em ${SHORT_BRASIL_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function getShortBrasilAppStatus(body: unknown): number | null {
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

function shortcodeResponseFailed(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return true;
  return body.some((item) => {
    if (!item || typeof item !== "object") return true;
    return String((item as Record<string, unknown>).status ?? "").toLowerCase() !== "accepted";
  });
}

async function callShortBrasil(
  tenantId: string | null,
  to: string,
  content: string,
  variables?: Record<string, string | number> | null,
  idempotencyKey: string = crypto.randomUUID(),
) {
  // Demo guard right before the provider request (fail-closed). Returned as a
  // non-temporary failure so the caller refunds/logs the usual way and no
  // retry loop ever resends it.
  const blocked = await demoSendBlockedReason(tenantId);
  if (blocked) {
    return {
      ok: false as const,
      status: 0,
      body: { error: blocked },
      idempotencyKey: "",
      errorKind: null as ProviderErrorKind | null,
      demoBlocked: true as const,
    };
  }
  const token = shortcodeToken();
  const { usuario, chave } = shortBrasilCredentials();
  if (!token && (!usuario || !chave)) {
    console.error("SMS Short Brasil credentials missing");
    return {
      ok: false as const,
      status: 0,
      body: {
        error:
          "SHORTCODE_SMS_TOKEN ou SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados",
      },
      idempotencyKey: "",
      errorKind: "misconfigured" as ProviderErrorKind,
    };
  }
  const credentialFp = await credentialFingerprint(token || usuario);
  let res: Response;
  const message = renderSmsVariables(content, variables);
  const payload = token
    ? [{ external_id: idempotencyKey, number: toShortBrasilCell(to), message }]
    : { celular: toShortBrasilCell(to), mensagem: message, parceiroId: idempotencyKey };
  const maxAttempts = 3;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      console.info("SMS Short Brasil request started", {
        to,
        idempotencyKey,
        credentialFp,
        api: token ? "shortcode-v1" : "short-brasil-legacy",
        attempt,
      });
      res = await shortBrasilFetch(token ? shortcodeMessagesUrl() : shortBrasilSingleUrl(), {
        method: "POST",
        headers: token
          ? {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            }
          : { Accept: "application/json", "Content-Type": "application/json", usuario, chave },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // B1: only a request that provably never left is retried here. A
      // timeout/reset may have been accepted (Short Brasil does not dedupe by
      // external_id), so it goes back to the caller as outcome_unknown.
      const errorKind = transportErrorKind(err);
      console.error("SMS Short Brasil request failed before response", {
        to,
        idempotencyKey,
        attempt,
        errorKind,
        error: err instanceof Error ? err.message : String(err),
      });
      if (errorKind === "not_sent" && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return {
        ok: false as const,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
        errorKind: errorKind as ProviderErrorKind,
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
  const appError = token ? shortcodeResponseFailed(body) : isShortBrasilApplicationError(body);
  console.info("SMS Short Brasil response received", {
    to,
    idempotencyKey,
    status: res.status,
    ok: res.ok && !appError,
    attempts: attempt,
  });
  return {
    ok: res.ok && !appError,
    status: res.status,
    body,
    idempotencyKey,
    errorKind: null as ProviderErrorKind | null,
  };
}

/**
 * Envia 1 SMS para N destinatarios em uma unica chamada HTTP usando o
 * endpoint /bot/bulk-sms.php da Short Brasil. O provedor aceita ate
 * 5000 mensagens por requisicao.
 *
 * Mantemos o nome exportado antigo para compatibilidade interna.
 */
export async function callShortBrasilSmsBulk(args: {
  tenantId: string;
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
  const blocked = await demoSendBlockedReason(args.tenantId);
  if (blocked) {
    return { ok: false, status: 0, body: { error: blocked }, idempotencyKey: "", dispatchId: null };
  }
  const token = shortcodeToken();
  const { usuario, chave } = shortBrasilCredentials();
  if (!token && (!usuario || !chave)) {
    return {
      ok: false,
      status: 0,
      body: {
        error:
          "SHORTCODE_SMS_TOKEN ou SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados",
      },
      idempotencyKey: "",
      dispatchId: null,
    };
  }
  const idempotencyKey = crypto.randomUUID();
  const mensagem = renderSmsVariables(args.content, args.variables);
  const payload = token
    ? args.recipients.slice(0, 1000).map((to) => ({
        external_id: crypto.randomUUID(),
        number: toShortBrasilCell(to),
        message: mensagem,
      }))
    : {
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
      res = await shortBrasilFetch(token ? shortcodeMessagesUrl() : shortBrasilBulkUrl(), {
        method: "POST",
        headers: token
          ? {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            }
          : { Accept: "application/json", "Content-Type": "application/json", usuario, chave },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // B1: never resend a bulk request that may have been accepted.
      if (transportErrorKind(err) === "not_sent" && attempt < maxAttempts) {
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
  const appError = token ? shortcodeResponseFailed(body) : isShortBrasilApplicationError(body);
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
  const { data, error } = await supabaseAdmin
    .from("sms_send_logs")
    .insert({
      to_phone: row.to,
      content: row.content,
      status: row.status,
      provider: "short-brasil",
      provider_response: (row.provider_response ?? {}) as Json,
      error: row.error,
      idempotency_key: row.idempotency_key || null,
      provider_message_id: row.provider_message_id ?? null,
      delivery_status:
        row.status === "sent" ? "sent" : row.status === "pending" ? "pending" : "failed",
      player_id: row.player_id ?? null,
      flow_id: row.flow_id ?? null,
      trigger_name: row.trigger_name ?? null,
      step_index: row.step_index ?? null,
      step_label: row.step_label ?? null,
      flow_lead_id: row.flow_lead_id ?? null,
      ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}),
    })
    .select("id")
    .single();
  if (error) {
    console.error("Failed to persist SMS send log", { to: row.to, error: error.message });
    throw new Error(`Falha ao registrar envio SMS: ${error.message}`);
  }
  return data?.id ? String(data.id) : null;
}

function extractProviderMessageId(body: unknown): string | null {
  if (Array.isArray(body)) {
    const first = body[0];
    if (first && typeof first === "object") {
      const value = (first as Record<string, unknown>).external_id;
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }
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

export function summarizeProviderError(status: number, body: unknown): string {
  if (status === 0) {
    if (body && typeof body === "object" && "error" in body) {
      return `Sem resposta do provedor: ${String((body as { error: unknown }).error)}`;
    }
    return "Sem resposta do provedor";
  }
  if (Array.isArray(body)) {
    const failed = body.find(
      (item) =>
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).status ?? "").toLowerCase() !== "accepted",
    ) as Record<string, unknown> | undefined;
    const reason = failed?.reason ?? failed?.message ?? failed?.error;
    return reason ? `Short Code recusou o SMS: ${String(reason)}` : `HTTP ${status} do provedor`;
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
        return `Provedor SMS recusou as credenciais (HTTP ${status}: ${msg}). Confira SHORTCODE_SMS_TOKEN ou as credenciais legadas.`;
      }
      return `HTTP ${status}: ${msg}`;
    }
  }
  return `HTTP ${status} do provedor`;
}

type SmsCreditRpcResult<T = unknown> = {
  data: T | null;
  error: { message: string } | null;
};
type SmsCreditRpcClient = {
  rpc: <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<SmsCreditRpcResult<T>>;
};

function smsCreditDb() {
  return supabaseAdmin as unknown as SmsCreditRpcClient;
}

async function resolveBillingTenantId(args: {
  tenantId?: string | null;
  playerId?: string | null;
}) {
  if (args.tenantId) return args.tenantId;
  if (!args.playerId) return null;
  const { data, error } = await supabaseAdmin
    .from("players")
    .select("tenant_id")
    .eq("id", args.playerId)
    .maybeSingle();
  if (error) {
    console.warn("Failed to resolve SMS billing tenant", {
      playerId: args.playerId,
      error: error.message,
    });
    return null;
  }
  return data?.tenant_id ?? null;
}

async function reserveSmsCredit(tenantId: string, referenceId: string) {
  const { data, error } = await smsCreditDb().rpc("reserve_sms_credits", {
    _tenant: tenantId,
    _credits: 1,
    _reference_type: "sms_send",
    _reference_id: referenceId,
    _idempotency_key: `sms-reserve:${referenceId}`,
  });
  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("insufficient_sms_credits")) {
      return { ok: false as const, error: "Saldo de créditos SMS insuficiente" };
    }
    throw new Error(message);
  }
  return { ok: true as const, data };
}

export async function refundSmsCredit(tenantId: string, referenceId: string, reason: string) {
  const { error } = await smsCreditDb().rpc("refund_sms_credits", {
    _tenant: tenantId,
    _credits: 1,
    _reference_type: "sms_send",
    _reference_id: referenceId,
    _idempotency_key: `sms-refund:${referenceId}`,
    _reason: reason,
  });
  if (error) {
    console.error("Failed to refund SMS credit", {
      tenantId,
      referenceId,
      error: error.message,
    });
  }
}

/** Max refunded attempts of one delivery that still get a deterministic billing reference. */
export const SMS_BILLING_MAX_GENERATIONS = 20;

/**
 * Billing reference for one logical delivery. Generation 0 is the first charge;
 * a retry only moves to the next generation after the previous charge was
 * refunded, so "provider accepted -> commit failed -> retry" never charges twice
 * and a retry after a refunded rejection is still charged once.
 */
export function smsBillingReference(deliveryKey: string, generation: number): string {
  return generation === 0 ? `delivery:${deliveryKey}` : `delivery:${deliveryKey}:${generation}`;
}

async function smsCreditWasRefunded(tenantId: string, referenceId: string): Promise<boolean> {
  const { data, error } = await (supabaseAdmin as any)
    .from("sms_credit_ledger")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", `sms-refund:${referenceId}`)
    .limit(1);
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Reserves the credit for one send. Without a delivery key every call is a new
 * charge (campaigns, manual sends). With one, the reference is derived from it:
 * an existing, non-refunded reservation is reused instead of charging again.
 */
export async function reserveSmsCreditForDelivery(
  tenantId: string,
  deliveryKey: string | null | undefined,
): Promise<{ ok: true; referenceId: string } | { ok: false; referenceId: string; error: string }> {
  if (!deliveryKey) {
    const referenceId = crypto.randomUUID();
    const reservation = await reserveSmsCredit(tenantId, referenceId);
    return reservation.ok
      ? { ok: true, referenceId }
      : { ok: false, referenceId, error: reservation.error };
  }
  for (let generation = 0; generation < SMS_BILLING_MAX_GENERATIONS; generation++) {
    const referenceId = smsBillingReference(deliveryKey, generation);
    const reservation = await reserveSmsCredit(tenantId, referenceId);
    if (!reservation.ok) return { ok: false, referenceId, error: reservation.error };
    const idempotent = (reservation.data as { idempotent?: boolean } | null)?.idempotent === true;
    if (!idempotent) return { ok: true, referenceId };
    if (!(await smsCreditWasRefunded(tenantId, referenceId))) return { ok: true, referenceId };
  }
  console.warn("SMS delivery exceeded deterministic billing generations", { deliveryKey });
  return reserveSmsCreditForDelivery(tenantId, null);
}

/** Log of a previous send of this delivery that the provider already accepted. */
async function findAcceptedSmsForDeliveryKey(deliveryKey: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id")
    .eq("idempotency_key", deliveryKey)
    .in("status", ["sent", "delivered", "enviado", "entregue"])
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.id ?? null;
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
  linkTrackingEnabled?: boolean;
  /** Structured origin for campaign/journey attribution. Never infer this from display text. */
  linkTrackingOrigin?: Pick<
    LinkTrackingContext,
    "sourceType" | "sourceId" | "journeyStepId" | "journeyStepPosition" | "shortDomainId"
  >;
  /** Stable identity supplied by a queue/worker when retrying one delivery. */
  deliveryKey?: string | null;
}) {
  // Demo guard first: before the phone check, billing, link tracking or any
  // sms_send_logs / sms_credit_ledger / link_dispatches write. Fail-closed: a
  // send whose tenant cannot be resolved (no tenantId and no playerId, or an
  // unknown player) is blocked too.
  const billingTenantId = await resolveBillingTenantId({
    tenantId: args.tenantId,
    playerId: args.playerId,
  });
  const demoBlocked = await demoSendBlockedReason(billingTenantId);
  if (demoBlocked) {
    return { ok: false as const, status: 0, error: demoBlocked, temporary: false };
  }

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

  // A retried delivery whose provider call was already accepted (e.g. the
  // worker failed after sending) must not reach the provider or billing again.
  if (args.deliveryKey) {
    const acceptedLogId = await findAcceptedSmsForDeliveryKey(args.deliveryKey);
    if (acceptedLogId) {
      return {
        ok: true as const,
        status: 200,
        response: JSON.stringify({ already_sent: true, sms_log_id: acceptedLogId }),
        alreadySent: true as const,
      };
    }
  }

  if (billingTenantId) {
    await assertTenantCanOperate(billingTenantId);
    if (await isChannelRevoked(billingTenantId, "sms", normalized)) {
      await logSend({
        to: normalized,
        content: args.content,
        status: "error",
        provider_response: { suppressed: true, reason: "consent_revoked" },
        error: "Destinatario revogou o consentimento para SMS",
        idempotency_key: args.deliveryKey ?? "",
        player_id: args.playerId,
        flow_id: args.flowId,
        trigger_name: args.triggerName,
        step_index: args.stepIndex,
        step_label: args.stepLabel,
        flow_lead_id: args.flowLeadId,
        tenant_id: billingTenantId,
      });
      return {
        ok: false as const,
        status: 200,
        suppressed: true,
        error: "Destinatario bloqueado por consentimento",
      };
    }
  }
  const renderedContent = renderSmsVariables(args.content, args.variables);
  const deliveryKey = args.deliveryKey ?? crypto.randomUUID();
  let preparedContent = renderedContent;
  let trackedDispatchIds: string[] = [];
  if (billingTenantId ?? args.tenantId) {
    const prepared = await prepareTrackedText(renderedContent, {
      tenantId: billingTenantId ?? args.tenantId!,
      channel: "sms",
      sourceType:
        args.linkTrackingOrigin?.sourceType ??
        (args.triggerName?.startsWith("journey:")
          ? "journey"
          : args.flowId
            ? "sms_flow"
            : args.triggerName === "teste-manual"
              ? "test"
              : "manual"),
      sourceId: args.linkTrackingOrigin?.sourceId ?? args.flowId ?? args.triggerName ?? null,
      journeyStepId: args.linkTrackingOrigin?.journeyStepId ?? null,
      journeyStepPosition: args.linkTrackingOrigin?.journeyStepPosition ?? null,
      shortDomainId: args.linkTrackingOrigin?.shortDomainId ?? null,
      recipientPlayerId: args.playerId ?? null,
      messageLogType: "sms_send_logs",
      deliveryKey,
      enabled: args.linkTrackingEnabled,
    });
    preparedContent = prepared.content;
    trackedDispatchIds = prepared.links.map((link) => link.dispatchId);
  }
  let billingReferenceId: string = crypto.randomUUID();
  let creditReserved = false;
  if (billingTenantId) {
    const reservation = await reserveSmsCreditForDelivery(billingTenantId, args.deliveryKey);
    billingReferenceId = reservation.referenceId;
    if (!reservation.ok) {
      await logSend({
        to: normalized,
        content: preparedContent,
        status: "error",
        provider_response: { billing_reference_id: billingReferenceId },
        error: reservation.error,
        idempotency_key: "",
        player_id: args.playerId,
        flow_id: args.flowId,
        trigger_name: args.triggerName,
        step_index: args.stepIndex,
        step_label: args.stepLabel,
        flow_lead_id: args.flowLeadId,
        tenant_id: billingTenantId,
      });
      return { ok: false as const, status: 402, error: reservation.error };
    }
    creditReserved = true;
  }

  const sendStartedAt = new Date();
  const r = await callShortBrasil(
    billingTenantId,
    normalized,
    preparedContent,
    undefined,
    deliveryKey,
  );
  const providerMessageId = r.ok ? extractProviderMessageId(r.body) : null;
  const errorSummary = r.ok ? null : summarizeProviderError(r.status, r.body);
  // A demo block from the transport guard is final: never "pending"/retried.
  const demoBlockedAtTransport = "demoBlocked" in r && r.demoBlocked === true;
  const isTemporary =
    !r.ok && !demoBlockedAtTransport && (r.status === 0 || r.status === 429 || r.status >= 500);
  // Account-level refusal (101/505, HTTP 401/402/403): not the lead's fault.
  // Opens the SMS circuit breaker; workers defer without consuming attempts.
  const accountReason =
    !r.ok && r.errorKind === null && r.status > 0
      ? smsProviderAccountReason(r.status, r.body)
      : null;
  if (accountReason) {
    await reportSmsProviderAccountFailure({
      reason: accountReason,
      error: errorSummary ?? `HTTP ${r.status}`,
      sendStartedAt,
    });
  } else if (r.ok) {
    await noteSmsProviderSuccess(sendStartedAt);
  }
  if (!r.ok && creditReserved && billingTenantId) {
    await refundSmsCredit(
      billingTenantId,
      billingReferenceId,
      errorSummary ?? `SMS nao aceito pelo provedor: HTTP ${r.status}`,
    );
  }
  const messageLogId = await logSend({
    to: normalized,
    content: preparedContent,
    status: r.ok ? "sent" : isTemporary ? "pending" : "error",
    provider_response: {
      ...(r.body && typeof r.body === "object" && !Array.isArray(r.body)
        ? (r.body as Record<string, unknown>)
        : { raw: r.body }),
      billing_reference_id: billingReferenceId,
      credit_reserved: creditReserved && r.ok,
    },
    error: errorSummary,
    idempotency_key: r.idempotencyKey,
    provider_message_id: providerMessageId,
    player_id: args.playerId,
    flow_id: args.flowId,
    trigger_name: args.triggerName,
    step_index: args.stepIndex,
    step_label: args.stepLabel,
    flow_lead_id: args.flowLeadId,
    tenant_id: billingTenantId ?? args.tenantId ?? null,
  });
  if (messageLogId && trackedDispatchIds.length > 0) {
    const { error: dispatchLogError } = await (supabaseAdmin as any)
      .from("link_dispatches")
      .update({ message_log_id: messageLogId })
      .in("id", trackedDispatchIds);
    if (dispatchLogError)
      console.error("Failed to link Short.io dispatches to SMS log", dispatchLogError.message);
  }
  if (r.ok) {
    await markTrackedDispatchesSent(trackedDispatchIds);
  } else {
    await markTrackedDispatchesFailed(trackedDispatchIds);
  }

  return r.ok
    ? { ok: true as const, status: r.status, response: JSON.stringify(r.body ?? null) }
    : {
        ok: false as const,
        status: r.status,
        error: errorSummary ?? `HTTP ${r.status}`,
        // provider_account is retryable later (nothing was sent, credit refunded).
        temporary: isTemporary || accountReason !== null,
        body: JSON.stringify(r.body ?? null),
        errorKind: (accountReason
          ? "provider_account"
          : (r.errorKind ?? null)) as ProviderErrorKind | null,
      };
}

// ---------------- Server functions expostas pra UI ----------------

export const smsProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const health = tenantChannelHealth(
      Boolean(
        process.env.SHORTCODE_SMS_TOKEN ||
        (process.env.SHORT_BRASIL_SMS_USUARIO && process.env.SHORT_BRASIL_SMS_CHAVE),
      ),
    );
    return { ...health, configured: health.available };
  });

export const sendTestSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        to: z.string().min(8).max(20),
        content: z.string().min(1).max(480),
        playerId: dbUuid().optional(),
        trackLinks: z.boolean().optional().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    let variables: Record<string, string> | null = null;
    if (data.playerId) {
      const { data: p } = await supabaseAdmin
        .from("players")
        .select(
          "nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
        )
        .eq("id", data.playerId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (p) {
        variables = buildPlayerVariables(p, await loadHouseLinks(tenantId));
      }
    }
    return sendSmsInternal({
      to: data.to,
      content: data.content,
      playerId: data.playerId ?? null,
      triggerName: "teste-manual",
      variables,
      tenantId,
      linkTrackingEnabled: data.trackLinks,
    });
  });

export const listSmsLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    const { data, error } = await supabaseAdmin
      .from("sms_send_logs")
      .select(
        "id, to_phone, content, status, error, provider_response, trigger_name, created_at, delivery_status, delivered_at, provider_message_id",
      )
      .eq("tenant_id", tenantId)
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
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: flow } = await supabaseAdmin
      .from("sms_flows")
      .select("id, trigger_name, is_active, tenant_id")
      .eq("tenant_id", tenantId)
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
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!player?.telefone) return { ok: false, error: "Player sem telefone" };

    const variables = buildPlayerVariables(player, await loadHouseLinks(tenantId));
    return sendSmsInternal({
      to: player.telefone,
      content: first.content,
      playerId: player.id,
      flowId: flow.id,
      triggerName: data.triggerName,
      variables,
      tenantId,
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
        ratePerMinute: z.number().int().min(1).max(5000).optional().default(1000),
        trackLinks: z.boolean().optional().default(true),
        templateId: dbUuid().optional(),
        conversionObjective: z
          .enum(["acquisition", "conversion", "reactivation"])
          .default("conversion"),
        enabledFunnelSteps: z.array(z.string().max(80)).max(10).optional(),
        /** tenant_domains shortener for this campaign's links. */
        shortDomainId: dbUuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    await assertTenantCanOperate(tenantId);
    // Demo guard once, before the campaign row, stats or any per-recipient send.
    await assertTenantNotDemoForSend(tenantId);
    let templateSnapshot: Json | null = null;
    if (data.templateId) {
      const { data: template, error } = await (context.supabase as any)
        .from("sms_templates")
        .select("id,name,content,version")
        .eq("id", data.templateId)
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .single();
      if (error || !template) throw new Error("Template SMS indisponível para esta campanha");
      templateSnapshot = {
        id: template.id,
        name: template.name,
        content: template.content,
        version: template.version,
      };
    }

    const shortDomainColumn = await campaignShortDomainColumn(tenantId, data.shortDomainId);
    const trigger = `campanha:${data.campaignName}:${data.route}`;
    const inputTargets: Array<{ phone: string; playerId?: string }> = [
      ...data.recipients,
      ...data.phones.map((p) => ({ phone: p })),
    ];
    if (inputTargets.length === 0) {
      return { total: 0, sent: 0, failed: 0, results: [] };
    }

    // ENV-06: resolve por telefone normalizado em lotes; quem não resolve não
    // bloqueia a campanha — é registrado com o motivo e aparece no relatório.
    const resolution = await resolveCampaignTargetsForSend(tenantId, inputTargets);
    const targets = resolution.resolved;
    const unresolvedSummary = campaignUnresolvedSummary(resolution);

    // Envios grandes seriam interrompidos pelo timeout do worker (~30s)
    // e deixavam a campanha pela metade. A partir de 50 destinatários,
    // enfileiramos em `sms_campaigns` com `scheduled_at = now()` e deixamos
    // o dispatcher processar em chunks com cursor persistente. O usuário
    // acompanha o progresso na aba Campanhas.
    const QUEUE_THRESHOLD = 50;
    if (targets.length > QUEUE_THRESHOLD) {
      const { data: inserted, error: insErr } = await (context.supabase as any)
        .from("sms_campaigns")
        .insert({
          tenant_id: tenantId,
          name: data.campaignName,
          content: data.content,
          route: data.route,
          recipients: targets as unknown as Json,
          total_count: targets.length,
          scheduled_at: new Date().toISOString(),
          status: "agendada",
          rate_per_minute: data.ratePerMinute,
          track_links: true,
          template_id: data.templateId ?? null,
          template_snapshot: templateSnapshot,
          conversion_objective: data.conversionObjective,
          conversion_funnel_snapshot: conversionFunnelSnapshot(
            data.conversionObjective,
            "campaign",
            data.enabledFunnelSteps,
          ),
          created_by: context.userId,
          ...shortDomainColumn,
        })
        .select("id")
        .single();
      if (insErr) throw new Error(insErr.message);
      if (resolution.unresolved.length > 0)
        await persistCampaignUnresolved(campaignDb(), inserted.id, resolution.unresolved);
      console.info("Bulk SMS enfileirado como campanha", {
        campaignName: data.campaignName,
        total: targets.length,
        unresolved: resolution.unresolved.length,
        campaignId: inserted.id,
      });
      return {
        total: targets.length,
        sent: 0,
        failed: 0,
        pending: 0,
        results: [],
        queued: true as const,
        campaignId: inserted.id,
        ...unresolvedSummary,
      };
    }

    // Carrega variáveis dos players envolvidos (uma query só)
    const playerIds = Array.from(new Set(targets.map((t) => t.playerId)));
    const varsByPlayer = new Map<string, Record<string, string>>();
    if (playerIds.length > 0) {
      const house = await loadHouseLinks(tenantId);
      const { data: players } = await supabaseAdmin
        .from("players")
        .select(
          "id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
        )
        .in("id", playerIds);
      (players ?? []).forEach((p) => {
        varsByPlayer.set(p.id, buildPlayerVariables(p, house));
      });
    }

    // Even immediate sends are campaigns. Persisting the record before the
    // provider call gives every tracked dispatch a stable UUID origin.
    const { data: immediateCampaign, error: immediateCampaignError } = await (
      context.supabase as any
    )
      .from("sms_campaigns")
      .insert({
        tenant_id: tenantId,
        name: data.campaignName,
        content: data.content,
        route: data.route,
        recipients: targets as unknown as Json,
        total_count: targets.length,
        scheduled_at: new Date().toISOString(),
        status: "enviando",
        rate_per_minute: data.ratePerMinute,
        track_links: true,
        template_id: data.templateId ?? null,
        template_snapshot: templateSnapshot,
        conversion_objective: data.conversionObjective,
        conversion_funnel_snapshot: conversionFunnelSnapshot(
          data.conversionObjective,
          "campaign",
          data.enabledFunnelSteps,
        ),
        created_by: context.userId,
        ...shortDomainColumn,
      })
      .select("id")
      .single();
    if (immediateCampaignError || !immediateCampaign) {
      throw new Error(
        immediateCampaignError?.message ?? "Não foi possível registrar a campanha SMS.",
      );
    }
    if (resolution.unresolved.length > 0)
      await persistCampaignUnresolved(campaignDb(), immediateCampaign.id, resolution.unresolved);

    console.info("Bulk SMS campaign started", {
      campaignName: data.campaignName,
      route: data.route,
      total: targets.length,
      unresolved: resolution.unresolved.length,
    });
    const results: {
      phone: string;
      playerId: string;
      ok: boolean;
      error?: string;
      temporary?: boolean;
    }[] = [];
    const concurrency = 5;
    // SMS circuit breaker: while the provider refuses the account, nothing is
    // sent here; recipients stay pending for the campaign worker (same key).
    const breaker = await readSmsBreaker({ force: true });
    let providerSuspended: string | null =
      breaker.state === "closed" ? null : smsSuspendedMessage(breaker);
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (t) => {
          if (providerSuspended) {
            return {
              phone: t.phone,
              playerId: t.playerId,
              ok: false,
              error: providerSuspended,
              temporary: true,
            };
          }
          const variables = varsByPlayer.get(t.playerId) ?? null;
          const r = await sendSmsInternal({
            to: t.phone,
            content: data.content,
            playerId: t.playerId,
            triggerName: trigger,
            variables,
            tenantId,
            linkTrackingEnabled: true,
            linkTrackingOrigin: {
              sourceType: "campaign",
              sourceId: immediateCampaign.id,
              shortDomainId: shortDomainColumn.short_domain_id ?? null,
            },
            // Mesma chave que o worker usaria: uma nova tentativa deste
            // destinatário nunca chega de novo ao provedor nem à cobrança.
            deliveryKey: await campaignDeliveryKey(immediateCampaign.id, t.playerId),
          });
          if (!r.ok && (r as { errorKind?: unknown }).errorKind === "provider_account") {
            providerSuspended = smsSuspendedMessage(cachedSmsBreaker());
          }
          return {
            phone: t.phone,
            playerId: t.playerId,
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
    // Falhas temporárias ficam no fim da lista, depois do cursor: o worker de
    // campanhas retoma só elas (com a mesma deliveryKey), sem reenviar as demais.
    const finished = results.filter((r) => r.ok || !r.temporary);
    const retry = results.filter((r) => !r.ok && r.temporary);
    await (context.supabase as any)
      .from("sms_campaigns")
      .update({
        status: pending > 0 ? "enviando" : failed === results.length ? "falhou" : "enviado",
        sent_count: sent,
        failed_count: failed,
        ...(pending > 0
          ? {
              recipients: [...finished, ...retry].map((r) => ({
                phone: r.phone,
                playerId: r.playerId,
              })) as unknown as Json,
              sent_cursor: finished.length,
            }
          : {}),
      })
      .eq("id", immediateCampaign.id)
      .eq("tenant_id", tenantId);
    return {
      total: results.length,
      sent,
      failed,
      pending,
      results: results.map(({ playerId: _playerId, ...rest }) => rest),
      campaignId: immediateCampaign.id,
      ...unresolvedSummary,
    };
  });

// ============================================================
// Dashboard — métricas reais a partir de sms_send_logs, sms_flows,
// flow_leads e deposits. Retorna shape pronto para o componente.
// ============================================================

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

function pickDispatchStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : {};
  const dispatch =
    payload.dispatch && typeof payload.dispatch === "object"
      ? (payload.dispatch as Record<string, unknown>)
      : {};
  const result =
    payload.result && typeof payload.result === "object"
      ? (payload.result as Record<string, unknown>)
      : {};
  const candidates = [
    payload.status,
    payload.state,
    payload.delivery_status,
    payload.deliveryStatus,
    data.status,
    data.state,
    dispatch.status,
    result.status,
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
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    // Dashboard = leitura pura do banco (rápido). O refresh de delivery_status
    // por callback da Short Brasil em /api/public/sms-webhook.

    // Resolve tenant do usuário autenticado — todas as queries do dashboard
    // DEVEM ser filtradas por tenant para não misturar dados de outros tenants.
    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    // Resolve período em America/Sao_Paulo (BRT). As datas YYYY-MM-DD vindas
    // do front representam dias do calendário em Brasília — não em UTC.
    const { parseBrtDayStart, parseBrtDayEnd, brtDayStart, brtDayEnd } = await import("./tz");
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
    const endIso = (
      data.from && data.to ? parseBrtDayEnd(data.to) : brtDayEnd(endDate)
    ).toISOString();

    // "Hoje" = último dia BRT do período (mostra o dia mais recente do range)
    let todayStart = new Date(endDate);
    let todayIso = todayStart.toISOString();

    // Respeita o marco "zerar dashboards"
    const { readResetAtAdmin } = await import("@/lib/dashboard-settings.functions");
    const resetAt = await readResetAtAdmin(tenantId);
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
    const sentRowsWithPlayer = rows.filter((r) => r.status === "sent" && !!r.player_id);
    const playerIds = Array.from(new Set(sentRowsWithPlayer.map((r) => r.player_id as string)));
    const depositsByPlayer = new Map<string, Array<{ created_at: string; valor: number }>>();
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
    const buckets = new Map<string, { enviados: number; entregues: number; conversoes: number }>();
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

    // Same price the house pays per credit (and the Central uses as cost).
    const { data: pricing } = await (supabaseAdmin as any).rpc("sms_effective_pricing", {
      _tenant: tenantId,
    });
    const smsPrice = Number(pricing?.sale_price_per_sms) || 0.12;
    const totalCost = sentTotal * smsPrice;
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

// Admin DA CASA ativa (ou super admin), não admin de qualquer casa.
const RESEND_ADMIN_ONLY = "Apenas administradores podem reenviar SMS";

/** Conta as falhas do dia separadas por causa, para o diálogo de reenvio. */
export const getFailedSmsBreakdown = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireActiveTenantAdmin(context.supabase, RESEND_ADMIN_ONLY);
    const { start, end } = brtDayWindow(data.date);

    const { count: rateLimited } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", start)
      .lte("created_at", end)
      .eq("status", "error")
      .like("error", "HTTP 429%");

    const { count: carrierFailed } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
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
    const tenantId = await requireActiveTenantAdmin(context.supabase, RESEND_ADMIN_ONLY);
    await assertTenantCanOperate(tenantId);
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
        .eq("tenant_id", tenantId)
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
        .eq("tenant_id", tenantId)
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
        .eq("tenant_id", tenantId)
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
        toResend.map((r) => r.player_id).filter((id): id is string => typeof id === "string"),
      ),
    );
    const varsByPlayer = new Map<string, Record<string, string>>();
    if (playerIds.length > 0) {
      const house = await loadHouseLinks(tenantId);
      const { data: players } = await supabaseAdmin
        .from("players")
        .select(
          "id, nome, telefone, saldo_carteira, ultimo_login, ultimo_jogo, ultimo_deposito, total_depositado, total_sacado, vip, status, expert, risco",
        )
        .eq("tenant_id", tenantId)
        .in("id", playerIds);
      (players ?? []).forEach((p) => {
        varsByPlayer.set(p.id, buildPlayerVariables(p, house));
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
          const variables = r.player_id ? (varsByPlayer.get(r.player_id) ?? null) : null;
          return sendSmsInternal({
            to: r.to_phone,
            content: r.content,
            playerId: r.player_id,
            triggerName: `resend_failed:${r.trigger_name ?? "manual"}`,
            variables,
            tenantId,
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
  ratePerMinute: z.number().int().min(1).max(5000).optional().default(1000),
  trackLinks: z.boolean().optional().default(true),
  templateId: dbUuid().optional(),
  conversionObjective: z.enum(["acquisition", "conversion", "reactivation"]).default("conversion"),
  enabledFunnelSteps: z.array(z.string().max(80)).max(10).optional(),
  /** Saved audience rule: recipients are recalculated by the worker at send time. */
  audienceCriteria: z.record(z.string(), z.unknown()).optional(),
  /** tenant_domains shortener for this campaign's links. */
  shortDomainId: dbUuid().nullable().optional(),
});

/**
 * ENV-06 — composer preview: how many of the chosen recipients will actually
 * receive the campaign and why the others will not. Same resolver used when the
 * campaign is created and by the worker.
 */
export const previewSmsCampaignRecipients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phones: z.array(z.string().min(1).max(40)).max(20000).optional().default([]),
        recipients: z
          .array(z.object({ phone: z.string().min(1).max(40), playerId: dbUuid().optional() }))
          .max(20000)
          .optional()
          .default([]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const resolution = await resolveCampaignRecipients(campaignDb(), tenantId, [
      ...data.recipients,
      ...data.phones.map((phone) => ({ phone })),
    ]);
    return {
      total: data.recipients.length + data.phones.length,
      resolved: resolution.resolved.length,
      ...campaignUnresolvedSummary(resolution),
    };
  });

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

    const { data: tenantRow, error: tenantErr } = await context.supabase.rpc("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantId = tenantRow as string | null;
    if (!tenantId) throw new Error("tenant não encontrado para o usuário");

    await assertTenantCanOperate(tenantId);
    // Demo guard once, before the campaign row, stats or any per-recipient send.
    await assertTenantNotDemoForSend(tenantId);
    let templateSnapshot: Json | null = null;
    if (data.templateId) {
      const { data: template, error } = await (context.supabase as any)
        .from("sms_templates")
        .select("id,name,content,version")
        .eq("id", data.templateId)
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .single();
      if (error || !template) throw new Error("Template SMS indisponível para esta campanha");
      templateSnapshot = {
        id: template.id,
        name: template.name,
        content: template.content,
        version: template.version,
      };
    }

    if (data.phones.length + data.recipients.length === 0)
      throw new Error("Sem destinatários válidos");
    const resolution = await resolveCampaignTargetsForSend(tenantId, [
      ...data.recipients,
      ...data.phones.map((phone) => ({ phone })),
    ]);
    const targets = resolution.resolved;
    const shortDomainColumn = await campaignShortDomainColumn(tenantId, data.shortDomainId);

    const campaignRow = {
      tenant_id: tenantId,
      name: data.campaignName,
      content: data.content,
      route: data.route,
      recipients: targets as unknown as Json,
      total_count: targets.length,
      scheduled_at: scheduled.toISOString(),
      status: "agendada",
      rate_per_minute: data.ratePerMinute,
      track_links: true,
      template_id: data.templateId ?? null,
      template_snapshot: templateSnapshot,
      conversion_objective: data.conversionObjective,
      conversion_funnel_snapshot: conversionFunnelSnapshot(
        data.conversionObjective,
        "campaign",
        data.enabledFunnelSteps,
      ),
      created_by: context.userId,
      ...shortDomainColumn,
    };
    const insertCampaign = (row: Record<string, unknown>) =>
      (context.supabase as any)
        .from("sms_campaigns")
        .insert(row)
        .select("id, name, scheduled_at, total_count, status")
        .single();
    // Dynamic audience: the worker recalculates the rule at send time; the
    // snapshot above only validates the schedule and shows the current count.
    let { data: inserted, error } = await insertCampaign(
      data.audienceCriteria
        ? {
            ...campaignRow,
            audience_criteria: normalizeSmsAudienceCriteria(data.audienceCriteria) as unknown as Json,
          }
        : campaignRow,
    );
    // Column ships with migration 20261019160000; until then the send keeps the snapshot.
    if (error && data.audienceCriteria && isMissingColumnError(error))
      ({ data: inserted, error } = await insertCampaign(campaignRow));
    if (error) throw new Error(error.message);
    if (resolution.unresolved.length > 0)
      await persistCampaignUnresolved(campaignDb(), inserted.id, resolution.unresolved);
    return { ...inserted, ...campaignUnresolvedSummary(resolution) };
  });

export const listScheduledSmsCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const baseColumns =
      "id, name, scheduled_at, status, total_count, sent_count, deduplicated_count, failed_count, last_error, created_at, updated_at";
    const list = (columns: string) =>
      (context.supabase as any)
        .from("sms_campaigns")
        .select(columns)
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .order("scheduled_at", { ascending: true })
        .limit(200);
    // `unresolved_count` (ENV-06) arrives with migration 20261015113000; until
    // it is applied the list keeps working without the badge.
    let { data, error } = await list(`${baseColumns}, unresolved_count`);
    if (error && isMissingColumnError(error)) ({ data, error } = await list(baseColumns));
    if (error) throw new Error(error.message);
    return {
      campaigns: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        name: (row.name as string | null) ?? null,
        scheduled_at: String(row.scheduled_at),
        status: String(row.status),
        total_count: Number(row.total_count ?? 0),
        sent_count: Number(row.sent_count ?? 0),
        deduplicated_count: Number(row.deduplicated_count ?? 0),
        failed_count: Number(row.failed_count ?? 0),
        last_error: (row.last_error as string | null) ?? null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        unresolved_count: Number(row.unresolved_count ?? 0),
      })),
    };
  });

export const cancelScheduledSmsCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    // The reason is kept on the campaign so the list and the report can say
    // who cancelled it and when (status alone read as "Ação necessária").
    const actor = String((context.claims as { email?: unknown }).email ?? "") || "um usuário";
    const cancelledAt = new Date();
    const when = cancelledAt.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    });
    const { data: updated, error } = await context.supabase
      .from("sms_campaigns")
      .update({ status: "cancelada", last_error: `Cancelada manualmente por ${actor} em ${when}.` })
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .eq("status", "agendada")
      .select("id, name, scheduled_at, total_count")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Campanha não pode mais ser cancelada");
    const { error: auditError } = await supabaseAdmin.from("tenant_audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: context.userId,
      action: "sms_campaign.cancelled",
      entity_type: "sms_campaign",
      entity_id: data.id,
      before_data: { status: "agendada" } as Json,
      after_data: { status: "cancelada" } as Json,
      metadata: { ...updated, actor_email: actor, cancelled_at: cancelledAt.toISOString() } as Json,
    });
    if (auditError)
      console.warn("[sms-campaigns] cancelamento sem auditoria", {
        campaignId: data.id,
        error: auditError.message,
      });
    return { ok: true };
  });
