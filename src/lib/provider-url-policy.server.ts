// SSRF guard for provider-account URLs the super admin types in, plus the
// fetch wrapper used for connection tests (Task 7,
// docs/.superpowers/sdd/2026-11-07-conta-propria-provedor). Admin-entered
// URLs must resolve only to the provider's own API — never an internal
// address, a redirect, or a lookalike host (sub.api.infobip.com.evil.io).

/** Generic failure shown for any connection-test error: no HTTP status,
 * network detail, or provider response ever reaches the client. Real detail
 * goes to console.error only. */
export const PROVIDER_TEST_FAILURE_MESSAGE =
  "Não foi possível conectar com essa conta. Confira as credenciais e o endereço.";

const INFOBIP_BASE_URL_MESSAGE =
  "URL base da Infobip inválida. Use o endereço https://xxxx.api.infobip.com do seu portal.";

/** `https://api.infobip.com` or `https://<sub>.api.infobip.com`, also in a
 * regional zone (`https://<sub>.api-us.infobip.com`), no path, no port, no
 * credentials. Returns the normalized origin (no trailing slash). */
export function assertInfobipBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(INFOBIP_BASE_URL_MESSAGE);
  }
  const host = url.hostname.toLowerCase();
  const hostOk = /^([a-z0-9-]+\.)?api(-[a-z0-9]+)?\.infobip\.com$/.test(host);
  const pathOk = url.pathname === "" || url.pathname === "/";
  if (
    url.protocol !== "https:" ||
    !hostOk ||
    !pathOk ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(INFOBIP_BASE_URL_MESSAGE);
  }
  return url.origin;
}

type ShortBrasilField = "shortcode_url" | "single_url" | "bulk_url";

const SHORT_BRASIL_FIELD_LABEL: Record<ShortBrasilField, string> = {
  shortcode_url: "URL da API Short Code",
  single_url: "URL de envio individual",
  bulk_url: "URL de envio em lote",
};

/** Hosts a Short Brasil platform account may point to, and whether https is
 * required for each (the legacy API at lp01-short.painelsms.com is http). */
const SHORT_BRASIL_HOSTS: Record<string, { requireHttps: boolean }> = {
  "api.shortcode.com.br": { requireHttps: true },
  "lp01-short.painelsms.com": { requireHttps: false },
};

/** `shortcode_url`/`single_url`/`bulk_url` must point at an allowlisted
 * Short Brasil host, with https required for `api.shortcode.com.br`. */
export function assertShortBrasilUrl(field: ShortBrasilField, value: string): string {
  const label = SHORT_BRASIL_FIELD_LABEL[field];
  const message = `${label}: use um endereço da Short Brasil (api.shortcode.com.br ou lp01-short.painelsms.com).`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  const host = url.hostname.toLowerCase();
  const hostPolicy = SHORT_BRASIL_HOSTS[host];
  if (!hostPolicy || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new Error(message);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !hostPolicy.requireHttps)) {
    throw new Error(message);
  }
  return url.href;
}

/** Fetch wrapper for connection tests: redirects are never followed (a 3xx
 * is treated as a failure, closing off redirect-based SSRF), and a timeout
 * is mandatory so a stalled host cannot hang the request. */
export async function providerFetch(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Redirecionamento bloqueado (HTTP ${response.status}).`);
  }
  return response;
}
