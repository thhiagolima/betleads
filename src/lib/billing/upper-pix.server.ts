// Upper Pix API client (server-only). Creates, fetches and cancels Pix
// charges used for credit top-ups. Never import this from client code: the
// API key must stay on the server.

import { recordBillingSignal, upperErrorSignal } from "./billing-signals.server";

export type UpperChargeStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAID"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type UpperCharge = {
  id: string;
  externalId: string | null;
  status: UpperChargeStatus;
  amountCents: number;
  emv: string | null;
  qrCodeImage: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  paidAmountCents: number | null;
  payer: { name: string | null; document: string | null } | null;
  raw: unknown;
};

export type CreateUpperChargeInput = {
  amountCents: number;
  description: string;
  externalId: string;
  expiresIn: number;
  metadata: Record<string, string>;
};

export class UpperError extends Error {
  status: number;
  code: string | null;
  retryable: boolean;

  constructor(
    message: string,
    options: { status: number; code: string | null; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "UpperError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

const DEFAULT_BASE_URL = "https://api.uppersc.com.br/v1";
const TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// In-memory, per-process rolling window. Waits (never fails) once we are at
// the limit; the Upper key itself allows 120/min, we cap ourselves at 100/min.
let callTimestamps: number[] = [];

async function acquireRateLimitSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    callTimestamps = callTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (callTimestamps.length < RATE_LIMIT_MAX_CALLS) {
      callTimestamps.push(now);
      return;
    }
    const oldest = callTimestamps[0];
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 1;
    await sleep(waitMs);
  }
}

/** Test hook: reset the in-memory rate limiter between tests. */
export function __resetUpperRateLimiterForTests(): void {
  callTimestamps = [];
}

// Normalizes UPPER_API_BASE so the request path always has exactly one
// trailing /v1 segment, regardless of whether the configured value already
// carries it or has a trailing slash.
function baseUrl(): string {
  const raw = (process.env.UPPER_API_BASE?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
}

function apiKey(): string | null {
  return process.env.UPPER_API_KEY?.trim() || null;
}

/** Throws UpperError(INVALID_RESPONSE) when `value` doesn't parse to a finite number. */
function parseAmountCents(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new UpperError(`Resposta da Upper com ${field} inválido.`, {
      status: 0,
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  }
  return n;
}

const UPPER_CHARGE_STATUSES: ReadonlySet<string> = new Set<UpperChargeStatus>([
  "PENDING",
  "ACTIVE",
  "PAID",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

/**
 * Throws UpperError(INVALID_RESPONSE) unless `value` is exactly one of the
 * six statuses Upper documents (case-sensitive: Upper sends upper case). A
 * missing or unknown status is never guessed — it would otherwise be written
 * to payment_charges as-is.
 */
function parseStatus(value: unknown): UpperChargeStatus {
  if (typeof value === "string" && UPPER_CHARGE_STATUSES.has(value)) {
    return value as UpperChargeStatus;
  }
  throw new UpperError("Resposta da Upper com status inválido.", {
    status: 0,
    code: "INVALID_RESPONSE",
    retryable: false,
  });
}

/** Same as parseAmountCents, but null/undefined is a valid "not paid yet" value. */
function parseNullableAmountCents(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return parseAmountCents(value, field);
}

type UpperChargeResponse = {
  id?: string;
  externalId?: string | null;
  status?: unknown;
  amountCents?: string | number;
  pix?: { emv?: string | null; qrCodeImage?: string | null } | null;
  paymentUrl?: string | null;
  expiresAt?: string | null;
  paidAt?: string | null;
  paidAmountCents?: string | number | null;
  payer?: { name?: string | null; document?: string | null } | null;
  idempotent?: boolean;
};

function parseUpperCharge(body: unknown): UpperCharge {
  const b = (body ?? {}) as UpperChargeResponse;
  return {
    id: b.id ?? "",
    externalId: b.externalId ?? null,
    status: parseStatus(b.status),
    amountCents: parseAmountCents(b.amountCents, "amountCents"),
    emv: b.pix?.emv ?? null,
    qrCodeImage: b.pix?.qrCodeImage ?? null,
    paymentUrl: b.paymentUrl ?? null,
    expiresAt: b.expiresAt ?? null,
    paidAt: b.paidAt ?? null,
    paidAmountCents: parseNullableAmountCents(b.paidAmountCents, "paidAmountCents"),
    payer: b.payer ? { name: b.payer.name ?? null, document: b.payer.document ?? null } : null,
    raw: body,
  };
}

type UpperErrorBody = { statusCode?: number; message?: string; code?: string | null };

function isRetryableStatus(status: number, code: string | null): boolean {
  if (status === 429 || status === 502) return true;
  if (status >= 500) return true;
  if (code === "RATE_LIMITED") return true;
  return false;
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

async function upperRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const key = apiKey();
  if (!key) {
    throw new UpperError("Upper não configurado: UPPER_API_KEY ausente.", {
      status: 0,
      code: "NOT_CONFIGURED",
      retryable: false,
    });
  }

  await acquireRateLimitSlot();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new UpperError(
      timedOut ? "Tempo esgotado ao chamar a Upper." : "Falha de rede ao chamar a Upper.",
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
    const errorBody = (parsed ?? {}) as UpperErrorBody;
    const code = errorBody.code ?? null;
    const message = errorBody.message || `Upper respondeu ${response.status}.`;
    // PG6-03: 401 / FEATURE_DISABLED block every charge; leave a trace for the
    // billing health monitor. Fire-and-forget, never changes the error thrown.
    const signal = upperErrorSignal(response.status, code);
    if (signal) void recordBillingSignal(signal, `${response.status} ${code ?? ""}`.trim());
    throw new UpperError(message, {
      status: response.status,
      code,
      retryable: isRetryableStatus(response.status, code),
    });
  }

  return parsed;
}

/** Creates (or, with a repeated externalId, fetches the existing) Pix charge. */
export async function createUpperCharge(input: CreateUpperChargeInput): Promise<UpperCharge> {
  const payload = {
    amountCents: input.amountCents,
    description: input.description,
    externalId: input.externalId,
    expiresIn: input.expiresIn,
    metadata: input.metadata,
  };
  try {
    const body = await upperRequest("POST", "/pix/charges", payload);
    return parseUpperCharge(body);
  } catch (error) {
    // Single automatic retry, only for retryable errors, only on create, with
    // the exact same externalId/body so Upper's idempotency keeps it safe.
    if (error instanceof UpperError && error.retryable) {
      const body = await upperRequest("POST", "/pix/charges", payload);
      return parseUpperCharge(body);
    }
    throw error;
  }
}

export async function getUpperCharge(externalId: string): Promise<UpperCharge> {
  const body = await upperRequest("GET", `/pix/charges/${encodeURIComponent(externalId)}`);
  return parseUpperCharge(body);
}

export async function cancelUpperCharge(externalId: string): Promise<UpperCharge> {
  const body = await upperRequest("DELETE", `/pix/charges/${encodeURIComponent(externalId)}`);
  return parseUpperCharge(body);
}
