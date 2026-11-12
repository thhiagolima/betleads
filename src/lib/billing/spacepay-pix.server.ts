// SpacePay ("Space Payment Proxy") Pix client (server-only). Creates and
// reads Pix cash-ins for tenant invoices and credit top-ups, normalized to
// the shared PixCharge shape. Never import this from client code: the tokens
// and the callback secret must stay on the server.
//
// - Amounts go out in REAIS (the API's unit) and come back as cents.
// - Tokens, API base, callback secret and payer come from the gateway config
//   (DB, env fallback); only PUBLIC_APP_URL is read from env here.
// - The payer is a fixed payer of ours (config `payer`), never the house.
// - No cancel endpoint and no expiry parameter on the API.
// - LGPD: `raw` (stored in payment_charges.last_provider_payload) is an
//   allow-list of scalar fields, never the response body. The /transactions
//   body carries the PSP's own callback bodies (`payload`, `history[].payload`,
//   with the real payer's name/CPF under arbitrary keys) and our `callbackUrl`
//   (with the secret callback token); none of that is ever stored.
// - Every request carries `X-Platform-Id` (not in their docs; value from their
//   /create_gateway_token): config platformId, else the gateway token itself.
//   Missing → 400 "Header X-Platform-Id é obrigatório"; unknown →
//   404 "Cassino não encontrado para o platformId informado" (PLATFORM_NOT_FOUND,
//   never read as "charge not found").
// - Real error body: {success, message, data: {errors: [...]}}. Only the first
//   data.errors entry (sanitized, ≤160 chars) reaches the error message.

import { recordBillingSignal } from "./billing-signals.server";
import { getSpacePayConfig, type SpacePayConfig } from "./payment-gateway-config.server";
import { PixGatewayError } from "./pix-gateway-error";
import {
  effectivePlatformId,
  firstSpacePayError,
  isSpacePayPlatformNotFound,
} from "./spacepay-protocol";

export { effectivePlatformId };
// Type-only: pix-gateway.server imports this module at runtime.
import type {
  CreatePixChargeInput,
  PixCharge,
  PixChargeRef,
  PixChargeStatus,
  PixGateway,
} from "./pix-gateway.server";
import { spacePayCallbackToken } from "./spacepay-callback-token";

export class SpacePayError extends PixGatewayError {
  constructor(
    message: string,
    options: { status: number; code: string | null; retryable: boolean; cause?: unknown },
  ) {
    super(message, { ...options, provider: "spacepay" });
    this.name = "SpacePayError";
  }
}

const DEFAULT_BASE_URL = "https://integration.prod.spacedev.pro";
const TIMEOUT_MS = 10_000;
// Idempotency-key lookup window/size (409 recovery and get() without an id).
const LOOKUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const LOOKUP_PER_PAGE = 100;
const LOOKUP_MAX_PAGES = 20;

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function publicAppUrl(): string | null {
  return trimmed(process.env.PUBLIC_APP_URL);
}

/** Current SpacePay config from the gateway config (DB, env fallback), or null. */
async function loadConfig(): Promise<SpacePayConfig | null> {
  return (await getSpacePayConfig()).config;
}

function baseUrl(config: SpacePayConfig): string {
  return (trimmed(config.apiBase) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Token for POST /create_gateway_cash_in. */
function gatewayToken(config: SpacePayConfig | null): string | null {
  return trimmed(config?.gatewayToken);
}

/** Token for the /transactions reads: the casino token when set, else the gateway token. */
function readToken(config: SpacePayConfig | null): string | null {
  return trimmed(config?.casinoToken) ?? gatewayToken(config);
}

async function isSpacePayConfigured(): Promise<boolean> {
  if (!publicAppUrl()) return false;
  const config = await loadConfig();
  if (!config) return false;
  return [
    config.gatewayToken,
    config.callbackSecret,
    config.payer?.name,
    config.payer?.document,
    config.payer?.email,
    config.payer?.phone,
  ].every((value) => trimmed(value) !== null);
}

function notConfigured(what: string): SpacePayError {
  return new SpacePayError(`SpacePay não configurado: ${what} ausente.`, {
    status: 0,
    code: "NOT_CONFIGURED",
    retryable: false,
  });
}

function invalidResponse(field: string): SpacePayError {
  return new SpacePayError(`Resposta do SpacePay com ${field} inválido.`, {
    status: 0,
    code: "INVALID_RESPONSE",
    retryable: false,
  });
}

/**
 * Public callback URL for one charge; the token authenticates the (unsigned)
 * callback. Signed with the CURRENT callbackSecret (gateway config); the
 * webhook route also accepts older secrets still in spacePayCallbackSecrets().
 */
export async function spacePayCallbackUrl(
  externalId: string,
  config?: SpacePayConfig | null,
): Promise<string> {
  const appUrl = publicAppUrl();
  if (!appUrl) throw notConfigured("PUBLIC_APP_URL");
  const secret = trimmed((config === undefined ? await loadConfig() : config)?.callbackSecret);
  if (!secret) throw notConfigured("SPACEPAY_CALLBACK_SECRET");
  return `${appUrl.replace(/\/+$/, "")}/api/public/spacepay/webhook/${await spacePayCallbackToken(externalId, secret)}`;
}

/** Cents → reais without float noise (integer / 100 always prints as the exact 2-decimal value). */
function centsToReais(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new SpacePayError("Valor da cobrança inválido.", {
      status: 0,
      code: "VALIDATION",
      retryable: false,
    });
  }
  return cents / 100;
}

function reaisToCents(value: unknown, field: string): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw invalidResponse(field);
  return Math.round(n * 100);
}

const STATUS_MAP: Record<string, PixChargeStatus> = {
  created: "ACTIVE",
  paid: "PAID",
  expired: "EXPIRED",
  failed: "FAILED",
  // The proxy reverts a failed callback to pending; keep re-checking it.
  callback_failed: "ACTIVE",
  refunded: "FAILED",
};

/** Unknown or missing status is never guessed (it would be written to payment_charges). */
function parseStatus(value: unknown, id: string): PixChargeStatus {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_MAP, value)) {
    if (value === "refunded") {
      console.error("[spacepay] transaction refunded; mapped to FAILED, needs review", { id });
    }
    return STATUS_MAP[value];
  }
  throw invalidResponse("status");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies only the listed keys whose value is a scalar (string/number/boolean/null). */
function pickScalars(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const from = isRecord(source) ? source : {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = from[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

const CASH_IN_RAW_KEYS = [
  "transaction_id",
  "idempotency_key",
  "status",
  "expiration_time",
  "created_at",
  "paid_at",
  "currency",
] as const;

const TRANSACTION_RAW_KEYS = [
  "id",
  "status",
  "amount",
  "paidAt",
  "createdAt",
  "updatedAt",
  "idempotencyKey",
  "externalId",
  "gateway",
  "type",
] as const;

const END_TO_END_KEYS = ["endToEndId", "end_to_end_id", "e2eId", "end2end", "endToEnd"] as const;

function endToEndIn(record: Record<string, unknown>): string | null {
  for (const key of END_TO_END_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * SpacePay has no documented end-to-end field; the PSP's own callback bodies
 * land in `history[].payload`. Newest entry (the array's end) first; a known
 * key at the payload's top level or one level down (e.g. `pix.endToEndId`).
 */
function extractEndToEnd(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const payload = isRecord(entry) ? entry.payload : null;
    if (!isRecord(payload)) continue;
    const direct = endToEndIn(payload);
    if (direct) return direct;
    for (const child of Object.values(payload)) {
      if (!isRecord(child)) continue;
      const nested = endToEndIn(child);
      if (nested) return nested;
    }
  }
  return null;
}

type CashInResponse = {
  transaction_id?: unknown;
  idempotency_key?: unknown;
  copy_paste?: unknown;
  qr_code?: unknown;
  expiration_time?: unknown;
  status?: unknown;
  created_at?: unknown;
  paid_at?: unknown;
};

function parseCashIn(body: unknown, input: CreatePixChargeInput): PixCharge {
  const b = (body ?? {}) as CashInResponse;
  const id = nullableString(b.transaction_id);
  if (!id) throw invalidResponse("transaction_id");
  const status = parseStatus(b.status, id);
  const qr = nullableString(b.qr_code);
  return {
    id,
    externalId: nullableString(b.idempotency_key) ?? input.externalId,
    status,
    // The cash-in response carries no amount; it is the one we sent.
    amountCents: input.amountCents,
    emv: nullableString(b.copy_paste),
    qrCodeImage: qr && qr.startsWith("https://") ? qr : null,
    paymentUrl: null,
    expiresAt: nullableString(b.expiration_time),
    paidAt: nullableString(b.paid_at),
    paidAmountCents: status === "PAID" ? input.amountCents : null,
    payer: null,
    // Allow-list only (LGPD header note); copy_paste is already in `emv`.
    raw: pickScalars(body, CASH_IN_RAW_KEYS),
  };
}

type Transaction = {
  id?: unknown;
  idempotencyKey?: unknown;
  amount?: unknown;
  status?: unknown;
  paidAt?: unknown;
  history?: unknown;
};

/**
 * A /transactions record has no copy_paste/qr/expiry: those stay null and
 * recordChargeSnapshot keeps the values stored at creation.
 */
function parseTransaction(tx: unknown): PixCharge {
  const t = (tx ?? {}) as Transaction;
  const id = nullableString(t.id);
  if (!id) throw invalidResponse("id");
  const status = parseStatus(t.status, id);
  const amountCents = reaisToCents(t.amount, "amount");
  return {
    id,
    externalId: nullableString(t.idempotencyKey),
    status,
    amountCents,
    emv: null,
    qrCodeImage: null,
    paymentUrl: null,
    expiresAt: null,
    paidAt: nullableString(t.paidAt),
    paidAmountCents: status === "PAID" ? amountCents : null,
    payer: null,
    // Allow-list only (LGPD header note): never `payload`, `history` or `callbackUrl`.
    raw: {
      ...pickScalars(t, TRANSACTION_RAW_KEYS),
      endToEndId: extractEndToEnd(t.history),
    },
  };
}

function errorCode(status: number): string {
  if (status === 400 || status === 422) return "VALIDATION";
  if (status === 401) return "INVALID_TOKEN";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "DUPLICATE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function spacePayRequest(
  config: SpacePayConfig | null,
  method: "GET" | "POST",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<unknown> {
  if (!config || !token) throw notConfigured("SPACEPAY_GATEWAY_TOKEN");
  const platformId = effectivePlatformId(config);
  if (!platformId) throw notConfigured("SPACEPAY_GATEWAY_TOKEN");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Platform-Id": platformId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    void recordBillingSignal("spacepay_unavailable", timedOut ? "TIMEOUT" : "NETWORK_ERROR");
    throw new SpacePayError(
      timedOut ? "Tempo esgotado ao chamar o SpacePay." : "Falha de rede ao chamar o SpacePay.",
      {
        status: 0,
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        retryable: true,
        cause: error,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  const parsed = await parseResponseBody(response);

  if (!response.ok) {
    const status = response.status;
    const platformNotFound = isSpacePayPlatformNotFound(status, parsed);
    const code = platformNotFound ? "PLATFORM_NOT_FOUND" : errorCode(status);
    // Only the first data.errors entry, sanitized; never the body otherwise.
    const detail = firstSpacePayError(parsed, [
      config.gatewayToken,
      config.casinoToken,
      config.callbackSecret,
    ]);
    const message = detail
      ? `SpacePay respondeu ${status}: ${detail}`
      : `SpacePay respondeu ${status}.`;
    // Bad/missing token or unknown platform id blocks every charge; 5xx means
    // the proxy is down. Fire-and-forget, never changes the error thrown.
    if (status === 401 || status === 403 || platformNotFound) {
      void recordBillingSignal("spacepay_unauthorized", `${status} ${code}`);
    } else if (status >= 500) {
      void recordBillingSignal("spacepay_unavailable", `${status} ${code}`);
    }
    throw new SpacePayError(message, { status, code, retryable: isRetryableStatus(status) });
  }

  return parsed;
}

type TransactionListResponse = {
  data?: unknown;
  meta?: { page?: unknown; perPage?: unknown; total?: unknown };
};

/** Finds a recent cash-in by idempotency key (= our externalId), or null. */
async function findByIdempotencyKey(
  config: SpacePayConfig | null,
  externalId: string,
): Promise<PixCharge | null> {
  const from = new Date(Date.now() - LOOKUP_WINDOW_MS).toISOString();
  for (let page = 1; page <= LOOKUP_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      type: "cash_in",
      dateField: "createdAt",
      from,
      page: String(page),
      perPage: String(LOOKUP_PER_PAGE),
    });
    const body = (await spacePayRequest(
      config,
      "GET",
      `/transactions?${params.toString()}`,
      readToken(config),
    )) as TransactionListResponse | null;
    const items = Array.isArray(body?.data) ? body.data : null;
    if (!items) throw invalidResponse("data");

    const match = items.find((tx) => (tx as Transaction | null)?.idempotencyKey === externalId);
    if (match) return parseTransaction(match);

    const total = Number(body?.meta?.total);
    const seen = (page - 1) * LOOKUP_PER_PAGE + items.length;
    if (items.length < LOOKUP_PER_PAGE || (Number.isFinite(total) && seen >= total)) break;
  }
  return null;
}

async function createSpacePayCharge(input: CreatePixChargeInput): Promise<PixCharge> {
  const config = await loadConfig();
  if (!gatewayToken(config)) throw notConfigured("SPACEPAY_GATEWAY_TOKEN");
  const name = trimmed(config?.payer?.name);
  const document = trimmed(config?.payer?.document);
  const email = trimmed(config?.payer?.email);
  const phone = trimmed(config?.payer?.phone);
  if (!name || !document || !email || !phone) throw notConfigured("SPACEPAY_PAYER_*");

  // Strict body: any extra field (description, metadata, expiry) is a 400.
  const payload = {
    document,
    email,
    name,
    amount: centsToReais(input.amountCents),
    webhook: await spacePayCallbackUrl(input.externalId, config),
    ip_address: input.requestIp ?? null,
    idempotency_key: input.externalId,
    phone,
  };
  const post = () =>
    spacePayRequest(config, "POST", "/create_gateway_cash_in", gatewayToken(config), payload);

  try {
    let body: unknown;
    try {
      body = await post();
    } catch (error) {
      // Single automatic retry, only for retryable errors, with the exact same
      // idempotency_key/body. If the first attempt did land, the retry gets a
      // 409 and the lookup below recovers the charge.
      if (error instanceof SpacePayError && error.retryable) body = await post();
      else throw error;
    }
    return parseCashIn(body, input);
  } catch (error) {
    if (error instanceof SpacePayError && error.status === 409) {
      const existing = await findByIdempotencyKey(config, input.externalId);
      // The list record carries no copy_paste/QR, so this charge can never
      // be shown for payment: stamp it as already expired so the dialog
      // offers "Gerar novo Pix" (a new attempt) instead of an empty screen.
      // A payment that still lands on it is credited by the normal confirm path.
      if (existing) {
        return existing.status === "ACTIVE" && existing.emv === null
          ? { ...existing, expiresAt: new Date().toISOString() }
          : existing;
      }
    }
    throw error;
  }
}

async function getSpacePayCharge(ref: PixChargeRef): Promise<PixCharge> {
  const config = await loadConfig();
  if (ref.providerChargeId) {
    const body = (await spacePayRequest(
      config,
      "GET",
      `/transactions/${encodeURIComponent(ref.providerChargeId)}`,
      readToken(config),
    )) as { data?: unknown } | null;
    if (!body?.data || typeof body.data !== "object") throw invalidResponse("data");
    const charge = parseTransaction(body.data);
    // Defense in depth: a transaction id that belongs to another of our
    // charges (or anyone else's) must never be read as this one.
    if (charge.externalId !== null && charge.externalId !== ref.externalId) {
      throw invalidResponse("idempotencyKey");
    }
    return charge;
  }
  const found = await findByIdempotencyKey(config, ref.externalId);
  if (!found) {
    throw new SpacePayError("Cobrança não encontrada no SpacePay.", {
      status: 404,
      code: "NOT_FOUND",
      retryable: false,
    });
  }
  return found;
}

export const spacePayGateway: PixGateway = {
  provider: "spacepay",
  isConfigured: isSpacePayConfigured,
  create: createSpacePayCharge,
  get: getSpacePayCharge,
  // No cancel endpoint: the caller closes the row locally.
  cancel: async () => null,
};
