// PaganoPay Pix client (server-only). Creates, reads and cancels Pix charges
// for tenant invoices and credit top-ups, normalized to the shared PixCharge
// shape. Docs: https://www.paganopay.com/docs (scope:
// docs/ESCOPO_GATEWAY_PAGANOPAY_2026-11-16.md).
//
// - Auth: X-API-Public-Key + X-API-Secret-Key on every call. The secret key
//   ALSO authorizes withdrawals (no 2FA on the API): this module never calls
//   any /cash-out route, and keys never reach a log, an error or a payload.
// - Production only (no sandbox). Always the plural `/payments/...` prefix:
//   the singular legacy one has no idempotency.
// - Amounts go out in integer cents; responses carry `amount` in cents and
//   `*_brl`/fee fields in reais (sometimes as text).
// - Idempotency-Key on create (24 h window): a repeat answers 200 with the
//   original charge, so a retry after a timeout never creates a second Pix.
// - The payer is a fixed payer of ours (config `payer`), never the house.
// - Cancel is local to PaganoPay only: the QR stays payable at the acquirer
//   and a later payment flips the charge back to PAID (normal confirm path).
// - LGPD: `raw` (payment_charges.last_provider_payload) is an allow-list of
//   scalar fields, never the response body (which echoes our `customer`).

import { recordBillingSignal } from "./billing-signals.server";
import { getPaganoPayConfig, type PaganoPayConfig } from "./payment-gateway-config.server";
import { PixGatewayError } from "./pix-gateway-error";
// Type-only: pix-gateway.server imports this module at runtime.
import type {
  CreatePixChargeInput,
  PixCharge,
  PixChargeRef,
  PixChargeStatus,
  PixGateway,
} from "./pix-gateway.server";

export class PaganoPayError extends PixGatewayError {
  constructor(
    message: string,
    options: { status: number; code: string | null; retryable: boolean; cause?: unknown },
  ) {
    super(message, { ...options, provider: "paganopay" });
    this.name = "PaganoPayError";
  }
}

export const PAGANOPAY_DEFAULT_BASE = "https://www.paganopay.com/api";
const TIMEOUT_MS = 15_000;
/** PaganoPay accepts expiresIn from 60 s to 30 days. */
const MIN_EXPIRES_IN = 60;
const MAX_EXPIRES_IN = 2_592_000;

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

async function loadConfig(): Promise<PaganoPayConfig | null> {
  return (await getPaganoPayConfig()).config;
}

export function paganoPayBase(apiBase: string | null | undefined): string {
  return (trimmed(apiBase) ?? PAGANOPAY_DEFAULT_BASE).replace(/\/+$/, "");
}

async function isPaganoPayConfigured(): Promise<boolean> {
  const config = await loadConfig();
  if (!config) return false;
  return [
    config.publicKey,
    config.secretKey,
    config.webhookSecret,
    config.payer?.name,
    config.payer?.document,
    config.payer?.email,
    config.payer?.phone,
  ].every((value) => trimmed(value) !== null);
}

function notConfigured(what: string): PaganoPayError {
  return new PaganoPayError(`PaganoPay não configurada: ${what} ausente.`, {
    status: 0,
    code: "NOT_CONFIGURED",
    retryable: false,
  });
}

function invalidResponse(field: string): PaganoPayError {
  return new PaganoPayError(`Resposta da PaganoPay com ${field} inválido.`, {
    status: 0,
    code: "INVALID_RESPONSE",
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// Status

const PAID_STATUSES = new Set(["PAID", "COMPLETED", "CONFIRMED"]);
/** Payer dispute (MED/chargeback): the money is held while PaganoPay reviews it. */
export const PAGANOPAY_DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  "MED",
  "IN_PROTEST",
  "DISPUTE",
  "CHARGEBACK",
  "CHARGEDBACK",
  "PRECHARGEBACK",
]);

/**
 * PaganoPay status → ours. A dispute keeps PAID (the payment happened; the
 * review flag comes from confirmCharge reading the raw status). REFUNDED is
 * FAILED: a FAILED snapshot never overwrites a PAID row, and confirmCharge
 * flags a refunded paid charge for review. Anything unknown is "not paid and
 * not final" (their docs): ACTIVE, so reconcile keeps asking.
 */
export function mapPaganoPayStatus(value: unknown): PixChargeStatus {
  const status = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (PAID_STATUSES.has(status) || PAGANOPAY_DISPUTE_STATUSES.has(status)) return "PAID";
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "CANCELLED" || status === "CANCELED") return "CANCELLED";
  if (status === "FAILED" || status === "REJECTED" || status === "REFUNDED") return "FAILED";
  if (status !== "PENDING" && status !== "WAITING_PAYMENT" && status !== "PROCESSING") {
    console.warn("[paganopay] unknown charge status; treated as not paid", { status });
  }
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// Parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function centsFrom(record: Record<string, unknown>): number | null {
  const cents = record.amount;
  if (typeof cents === "number" && Number.isSafeInteger(cents)) return cents;
  if (typeof cents === "string" && /^\d+$/.test(cents.trim())) return Number(cents.trim());
  const brl = record.amount_brl ?? record.amountBrl;
  const n = typeof brl === "string" && brl.trim() ? Number(brl) : brl;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;
}

function httpsOnly(value: unknown): string | null {
  const s = str(value);
  return s && s.startsWith("https://") ? s : null;
}

const RAW_KEYS = [
  "id",
  "status",
  "amount",
  "amount_brl",
  "externalRef",
  "external_ref",
  "externalId",
  "external_id",
  "paidAt",
  "paid_at",
  "createdAt",
  "created_at",
  "fee_amount",
  "net_amount",
  "payerMatchesCustomer",
] as const;

/** Allow-list of scalars + the end-to-end id at the top level (payment-reference reads it there). */
function rawSnapshot(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RAW_KEYS) {
    const value = data[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  const pix = isRecord(data.pix) ? data.pix : {};
  out.endToEndId = str(data.endToEndId) ?? str(pix.endToEndId) ?? null;
  return out;
}

/**
 * Normalizes a charge record (create `data`, GET /transactions/{id} `data`
 * or a webhook body). `fallbackAmountCents` covers the create response, which
 * only carries `amount_brl`.
 */
export function parsePaganoPayCharge(
  data: unknown,
  fallback: { externalId?: string; amountCents?: number } = {},
): PixCharge {
  if (!isRecord(data)) throw invalidResponse("data");
  const id = str(data.id) ?? str(data.transactionId);
  if (!id) throw invalidResponse("id");
  const status = mapPaganoPayStatus(data.status);
  const amountCents = centsFrom(data) ?? fallback.amountCents ?? null;
  if (amountCents === null) throw invalidResponse("amount");
  const pix = isRecord(data.pix) ? data.pix : {};
  const payer = isRecord(data.payer) ? data.payer : null;
  return {
    id,
    externalId:
      str(data.externalRef) ?? str(data.external_ref) ?? str(data.sellerExternalRef) ??
      fallback.externalId ??
      null,
    status,
    amountCents,
    emv: str(pix.copyPaste) ?? str(pix.qrcode),
    // Not always present; the payment dialog draws the QR from `emv` otherwise.
    qrCodeImage: httpsOnly(pix.qrcodeUrl) ?? httpsOnly(data.qrcodeUrl),
    paymentUrl: null,
    expiresAt:
      str(pix.expiresAt) ?? str(pix.expirationDate) ?? str(data.expiresAt) ?? str(data.expirationDate),
    paidAt: str(data.paidAt) ?? str(data.paid_at),
    paidAmountCents: status === "PAID" ? amountCents : null,
    payer: payer ? { name: str(payer.name), document: str(payer.document) } : null,
    raw: rawSnapshot(data),
  };
}

// ---------------------------------------------------------------------------
// HTTP

function errorCode(status: number, bodyCode: string | null): string {
  if (bodyCode) return bodyCode;
  if (status === 400 || status === 422) return "VALIDATION";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

/** Their `message`, cut and with any of our secrets redacted; never the body. */
export function paganoPayErrorDetail(body: unknown, secrets: Array<string | null | undefined>): string | null {
  if (!isRecord(body) || typeof body.message !== "string") return null;
  let message = body.message.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    const s = trimmed(secret);
    if (s) message = message.split(s).join("•••");
  }
  message = message.replace(/\b(pk|sk)_[0-9a-f]{8,}\b/gi, "•••");
  return message ? message.slice(0, 160) : null;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function paganoPayRequest(
  config: PaganoPayConfig | null,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<unknown> {
  const publicKey = trimmed(config?.publicKey);
  const secretKey = trimmed(config?.secretKey);
  if (!config || !publicKey || !secretKey) throw notConfigured("chaves de API");

  let response: Response;
  try {
    response = await fetch(`${paganoPayBase(config.apiBase)}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-API-Public-Key": publicKey,
        "X-API-Secret-Key": secretKey,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    void recordBillingSignal("paganopay_unavailable", timedOut ? "TIMEOUT" : "NETWORK_ERROR");
    throw new PaganoPayError(
      timedOut ? "Tempo esgotado ao chamar a PaganoPay." : "Falha de rede ao chamar a PaganoPay.",
      { status: 0, code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", retryable: true, cause: error },
    );
  }

  const parsed = await parseBody(response);
  if (!response.ok) {
    const status = response.status;
    const bodyCode = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : null;
    const code = errorCode(status, bodyCode);
    const detail = paganoPayErrorDetail(parsed, [publicKey, secretKey, config.webhookSecret]);
    if (status === 401 || status === 403 || code === "ACCOUNT_DISABLED") {
      void recordBillingSignal("paganopay_unauthorized", `${status} ${code}`);
    } else if (status >= 500) {
      void recordBillingSignal("paganopay_unavailable", `${status} ${code}`);
    }
    throw new PaganoPayError(
      detail ? `PaganoPay respondeu ${status}: ${detail}` : `PaganoPay respondeu ${status}.`,
      { status, code, retryable: status === 429 || status >= 500 },
    );
  }
  return parsed;
}

function dataOf(body: unknown): unknown {
  return isRecord(body) && body.data !== undefined ? body.data : body;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Our Idempotency-Key: prefixed, one per payment_charges.external_id. */
export function paganoPayIdempotencyKey(externalId: string): string {
  return `betleads-${externalId}`;
}

export function buildPaganoPayChargeBody(input: CreatePixChargeInput, payer: PaganoPayConfig["payer"]) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100) {
    throw new PaganoPayError("Valor da cobrança inválido.", {
      status: 0,
      code: "VALIDATION",
      retryable: false,
    });
  }
  const document = onlyDigits(payer.document);
  return {
    amount: input.amountCents,
    sellerExternalRef: input.externalId,
    customer: {
      name: payer.name,
      email: payer.email,
      phone: onlyDigits(payer.phone),
      documentType: document.length === 14 ? "CNPJ" : "CPF",
      document,
    },
    items: [{ title: input.description.slice(0, 120), quantity: 1, amount: input.amountCents }],
    expiresIn: Math.min(MAX_EXPIRES_IN, Math.max(MIN_EXPIRES_IN, Math.round(input.expiresIn))),
    metadata: input.metadata,
  };
}

async function createPaganoPayCharge(input: CreatePixChargeInput): Promise<PixCharge> {
  const config = await loadConfig();
  if (!config) throw notConfigured("chaves de API");
  const payer = config.payer;
  if (!trimmed(payer?.name) || !trimmed(payer?.document) || !trimmed(payer?.email) || !trimmed(payer?.phone)) {
    throw notConfigured("dados do pagador");
  }
  const body = buildPaganoPayChargeBody(input, payer);
  const idempotencyKey = paganoPayIdempotencyKey(input.externalId);
  const post = () =>
    paganoPayRequest(config, "POST", "/payments/pix", { body, idempotencyKey });

  let response: unknown;
  try {
    response = await post();
  } catch (error) {
    // One automatic retry for network/5xx/429, with the SAME Idempotency-Key:
    // if the first attempt landed, PaganoPay answers 200 with that charge.
    if (error instanceof PaganoPayError && error.retryable) response = await post();
    else throw error;
  }
  return parsePaganoPayCharge(dataOf(response), {
    externalId: input.externalId,
    amountCents: input.amountCents,
  });
}

function listItems(body: unknown): unknown[] {
  const data = dataOf(body);
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const key of ["transactions", "items", "data", "results"]) {
      if (Array.isArray(data[key])) return data[key] as unknown[];
    }
  }
  return [];
}

async function getPaganoPayCharge(ref: PixChargeRef): Promise<PixCharge> {
  const config = await loadConfig();
  let id = ref.providerChargeId;
  if (!id) {
    // We crashed between the POST and storing their id: find it by our reference.
    const params = new URLSearchParams({ sellerExternalRef: ref.externalId, limit: "1" });
    const list = await paganoPayRequest(config, "GET", `/payments/transactions?${params}`);
    const first = listItems(list)[0];
    id = isRecord(first) ? str(first.id) : null;
    if (!id) {
      throw new PaganoPayError("Cobrança não encontrada na PaganoPay.", {
        status: 404,
        code: "NOT_FOUND",
        retryable: false,
      });
    }
  }
  const body = await paganoPayRequest(config, "GET", `/payments/transactions/${encodeURIComponent(id)}`);
  const charge = parsePaganoPayCharge(dataOf(body), { externalId: ref.externalId });
  // Defense in depth: an id that belongs to another reference is never read as this charge.
  if (charge.externalId !== null && charge.externalId !== ref.externalId) {
    throw invalidResponse("externalRef");
  }
  return charge;
}

/**
 * Cancels on PaganoPay (only PENDING charges can be) and returns the fresh
 * charge. A charge PaganoPay refuses to cancel because it already moved on
 * (paid, expired…) comes back with that real status so the caller records it;
 * the QR itself stays payable either way (their docs).
 */
async function cancelPaganoPayCharge(ref: PixChargeRef): Promise<PixCharge> {
  const config = await loadConfig();
  const current = await getPaganoPayCharge(ref);
  if (current.status !== "ACTIVE") return current;
  try {
    await paganoPayRequest(
      config,
      "POST",
      `/payments/transactions/${encodeURIComponent(current.id)}/cancel`,
      { body: { reason: "Cobrança substituída ou encerrada no Betleads" } },
    );
  } catch (error) {
    if (!(error instanceof PaganoPayError) || error.status !== 400) throw error;
    // 400 = no longer PENDING: fall through to the fresh read.
  }
  const fresh = await getPaganoPayCharge({ externalId: ref.externalId, providerChargeId: current.id });
  if (fresh.status === "ACTIVE") {
    throw new PaganoPayError("A PaganoPay não cancelou a cobrança.", {
      status: 0,
      code: "CANCEL_NOT_APPLIED",
      retryable: true,
    });
  }
  return fresh;
}

export const paganoPayGateway: PixGateway = {
  provider: "paganopay",
  isConfigured: isPaganoPayConfigured,
  create: ({ requestIp: _requestIp, ...input }) => createPaganoPayCharge(input),
  get: getPaganoPayCharge,
  cancel: cancelPaganoPayCharge,
};
