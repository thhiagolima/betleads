// "Testar conexão" of the Pix gateways (super admin, Admin → Faturamento →
// Gateways de pagamento). One read-only request per gateway with the given
// credentials; the result is a short pt-BR message that never echoes a token,
// a key or a response body.
//
// - Upper: GET {base}/v1/pix/charges/__connection_test__ with the API key.
//   No charge has that externalId, so a valid key gets 404; 401/403 means the
//   key was refused.
// - SpacePay: GET {base}/transactions?perPage=1 with the casino token (reads)
//   or, when there is none, the gateway token, plus the (undocumented, required)
//   X-Platform-Id header (platformId, else the gateway token itself). 2xx = accepted; 401/403 = token refused; 404 naming
//   the platformId = unknown Platform ID; 400 = the first data.errors entry
//   (sanitized, <=160 chars, tokens redacted).
// - PaganoPay: GET {base}/payments/fees and GET {base}/payments/balance with
//   both keys (read-only; no charge is created). Shows the fee and the
//   available balance; 401/403 = keys or IP refused.

import {
  effectivePlatformId,
  firstSpacePayError,
  isSpacePayPlatformNotFound,
} from "./spacepay-protocol";

import { paganoPayBase, paganoPayErrorDetail } from "./paganopay-pix.server";

export type GatewayTestResult = { ok: boolean; message: string };

export const GATEWAY_TEST_TIMEOUT_MS = 10_000;

const UPPER_DEFAULT_BASE = "https://api.uppersc.com.br/v1";
const SPACEPAY_DEFAULT_BASE = "https://integration.prod.spacedev.pro";

/** Same normalization as upper-pix.server: exactly one trailing /v1. */
export function upperTestBase(apiBase: string | null | undefined): string {
  const raw = (apiBase?.trim() || UPPER_DEFAULT_BASE).replace(/\/+$/, "");
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
}

export function spacePayTestBase(apiBase: string | null | undefined): string {
  return (apiBase?.trim() || SPACEPAY_DEFAULT_BASE).replace(/\/+$/, "");
}

function networkFailure(label: string, error: unknown): GatewayTestResult {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    ok: false,
    message: timedOut
      ? `Sem resposta da ${label} em 10 segundos. Confira a URL da API.`
      : `Não foi possível falar com a ${label}. Confira a URL da API.`,
  };
}

export async function testUpperConnection(creds: {
  apiKey: string;
  apiBase: string | null;
}): Promise<GatewayTestResult> {
  if (!creds.apiKey.trim()) return { ok: false, message: "Informe a API key da Upper." };
  let response: Response;
  try {
    response = await fetch(`${upperTestBase(creds.apiBase)}/pix/charges/__connection_test__`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${creds.apiKey.trim()}` },
      signal: AbortSignal.timeout(GATEWAY_TEST_TIMEOUT_MS),
    });
  } catch (error) {
    return networkFailure("Upper", error);
  }
  if (response.status === 404 || response.ok) {
    return { ok: true, message: "Conectado. A Upper aceitou a API key." };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: `A Upper recusou a API key (HTTP ${response.status}).` };
  }
  return { ok: false, message: `A Upper respondeu HTTP ${response.status}.` };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function testSpacePayConnection(creds: {
  gatewayToken: string;
  casinoToken: string | null;
  platformId?: string | null;
  apiBase: string | null;
}): Promise<GatewayTestResult> {
  const token = creds.casinoToken?.trim() || creds.gatewayToken.trim();
  if (!token) return { ok: false, message: "Informe o token do gateway SpacePay." };
  const platformId = effectivePlatformId(creds) ?? token;
  const which = creds.casinoToken?.trim() ? "o token do cassino" : "o token do gateway";
  let response: Response;
  try {
    response = await fetch(`${spacePayTestBase(creds.apiBase)}/transactions?perPage=1`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Platform-Id": platformId,
      },
      signal: AbortSignal.timeout(GATEWAY_TEST_TIMEOUT_MS),
    });
  } catch (error) {
    return networkFailure("SpacePay", error);
  }
  if (response.ok) return { ok: true, message: `Conectado. A SpacePay aceitou ${which}.` };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: `A SpacePay recusou ${which} (HTTP ${response.status}).` };
  }
  const body = await readJson(response);
  if (isSpacePayPlatformNotFound(response.status, body)) {
    return { ok: false, message: "Platform ID não encontrado na SpacePay." };
  }
  if (response.status === 400) {
    const detail = firstSpacePayError(body, [creds.gatewayToken, creds.casinoToken]);
    if (detail) return { ok: false, message: `A SpacePay recusou: ${detail}` };
  }
  return { ok: false, message: `A SpacePay respondeu HTTP ${response.status}.` };
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The body's `data` object when there is one, else the body itself. */
function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  return v.data && typeof v.data === "object" && !Array.isArray(v.data)
    ? (v.data as Record<string, unknown>)
    : v;
}

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

/** Pix cash-in fee as "1,99% + R$ 0,50", from the (loosely documented) /payments/fees body. */
export function describePaganoPayFee(body: unknown): string | null {
  const data = recordOf(body);
  for (const candidate of [data.pix, data.cashIn, data.cash_in, data.pixIn, data.deposit, data]) {
    if (!candidate || typeof candidate !== "object") continue;
    const r = candidate as Record<string, unknown>;
    const pct = num(r.percentageFee ?? r.percentage_fee);
    const fixed = num(r.fixedFee ?? r.fixed_fee);
    if (pct === null && fixed === null) continue;
    const parts: string[] = [];
    if (pct !== null) parts.push(`${pct.toLocaleString("pt-BR")}%`);
    if (fixed !== null) parts.push(brl(fixed));
    return parts.join(" + ");
  }
  return null;
}

export async function testPaganoPayConnection(creds: {
  publicKey: string;
  secretKey: string;
  apiBase: string | null;
}): Promise<GatewayTestResult> {
  const publicKey = creds.publicKey.trim();
  const secretKey = creds.secretKey.trim();
  if (!publicKey || !secretKey) {
    return { ok: false, message: "Informe a chave pública e a chave secreta da PaganoPay." };
  }
  const base = paganoPayBase(creds.apiBase);
  const get = (path: string) =>
    fetch(`${base}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Public-Key": publicKey,
        "X-API-Secret-Key": secretKey,
      },
      signal: AbortSignal.timeout(GATEWAY_TEST_TIMEOUT_MS),
    });

  let feesResponse: Response;
  try {
    feesResponse = await get("/payments/fees");
  } catch (error) {
    return networkFailure("PaganoPay", error);
  }
  const feesBody = await readJson(feesResponse);
  if (!feesResponse.ok) {
    const detail = paganoPayErrorDetail(feesBody, [publicKey, secretKey]);
    const suffix = detail ? `: ${detail}` : "";
    if (feesResponse.status === 401 || feesResponse.status === 403) {
      return {
        ok: false,
        message: `A PaganoPay recusou as chaves (HTTP ${feesResponse.status}${suffix}).`,
      };
    }
    return { ok: false, message: `A PaganoPay respondeu HTTP ${feesResponse.status}${suffix}.` };
  }

  const parts = ["Conectado. A PaganoPay aceitou as chaves."];
  const fee = describePaganoPayFee(feesBody);
  if (fee) parts.push(`Taxa do Pix: ${fee}.`);
  try {
    const balanceResponse = await get("/payments/balance");
    if (balanceResponse.ok) {
      const available = num(recordOf(await readJson(balanceResponse)).available);
      if (available !== null) parts.push(`Saldo disponível: ${brl(available)}.`);
    }
  } catch {
    // The balance is a nice-to-have; the keys were already accepted.
  }
  return { ok: true, message: parts.join(" ") };
}
