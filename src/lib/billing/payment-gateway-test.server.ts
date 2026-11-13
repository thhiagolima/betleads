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

import {
  effectivePlatformId,
  firstSpacePayError,
  isSpacePayPlatformNotFound,
} from "./spacepay-protocol";

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
