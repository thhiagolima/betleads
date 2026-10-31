import { resolveMetaApiVersion } from "@/lib/meta-api-version";

/**
 * Cliente da Graph API da Meta (MB2-02). A chave vai só no cabeçalho
 * `Authorization: Bearer …`, nunca na URL: nem nas chamadas que montamos nem nos
 * `paging.next` que a Meta devolve (eles trazem `access_token=` e são limpos antes
 * de seguir). Cada resposta devolve o uso informado pelos cabeçalhos de rate limit.
 */

const GRAPH_HOST = "graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 8 * 60_000;
const NOT_READY_RETRY_MS = 5 * 60_000;

const TIMEOUT_MESSAGE = "A Meta demorou demais para responder. Tente novamente.";
const NETWORK_MESSAGE = "Não foi possível acessar a API da Meta.";
const REPORT_FAILED_MESSAGE = "A Meta não conseguiu gerar o relatório de desempenho.";
const REPORT_NOT_READY_MESSAGE = "O relatório da Meta ainda não ficou pronto.";
const ABORTED_MESSAGE = "Leitura interrompida.";
const BAD_PAGING_MESSAGE = "A Meta devolveu um link de paginação inválido.";

type MetaApiErrorDetails = {
  code?: number | null;
  subcode?: number | null;
  status?: number | null;
  type?: string | null;
  path?: string | null;
  fbtraceId?: string | null;
  retryAfterMs?: number | null;
};

/**
 * Erro da Graph API (ou da chamada a ela). `code`/`subcode`/`type`/`fbtraceId` vêm
 * do corpo de erro da Meta; `path` é o caminho chamado sem a versão; `status` é o
 * HTTP (null em timeout/rede/erros locais). `retryAfterMs` só é preenchido em rate
 * limit, a partir dos cabeçalhos de uso.
 */
export class MetaApiError extends Error {
  code: number | null;
  subcode: number | null;
  status: number | null;
  type: string | null;
  path: string | null;
  fbtraceId: string | null;
  retryAfterMs: number | null;

  constructor(message: string, details: MetaApiErrorDetails = {}) {
    super(message);
    this.name = "MetaApiError";
    this.code = details.code ?? null;
    this.subcode = details.subcode ?? null;
    this.status = details.status ?? null;
    this.type = details.type ?? null;
    this.path = details.path ?? null;
    this.fbtraceId = details.fbtraceId ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/** Maior uso informado (0–100+, em %) e quanto falta para a Meta liberar de novo. */
export type MetaUsage = { maxPct: number; regainAfterMs: number | null };

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function parseHeaderJson(headers: Headers, name: string): unknown {
  const raw = headers.get(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PCT_FIELDS = ["call_count", "total_cputime", "total_time", "acc_id_util_pct"] as const;

function maxPctOf(entry: Record<string, unknown>) {
  let max = 0;
  for (const field of PCT_FIELDS) {
    const value = asNumber(entry[field]);
    if (value !== null && value > max) max = value;
  }
  return max;
}

/**
 * Lê `x-app-usage`, `x-business-use-case-usage` e `x-ad-account-usage`.
 * - `maxPct`: o maior entre `call_count`, `total_cputime`, `total_time` e
 *   `acc_id_util_pct` de todos os cabeçalhos;
 * - `regainAfterMs`: o maior entre `estimated_time_to_regain_access` (minutos, só
 *   vem acima de 0 quando a Meta já bloqueou) e `reset_time_duration` (segundos,
 *   considerado só quando a conta chegou a 100 %, porque ele vem preenchido mesmo
 *   abaixo do limite). Null quando nenhum indica espera.
 * Cabeçalho ausente ou malformado é ignorado.
 */
export function parseMetaUsageHeaders(headers: Headers): MetaUsage {
  let maxPct = 0;
  let regainAfterMs: number | null = null;
  const regain = (ms: number) => {
    if (ms > 0 && (regainAfterMs === null || ms > regainAfterMs)) regainAfterMs = ms;
  };

  const app = parseHeaderJson(headers, "x-app-usage");
  if (isRecord(app)) maxPct = Math.max(maxPct, maxPctOf(app));

  const business = parseHeaderJson(headers, "x-business-use-case-usage");
  if (isRecord(business)) {
    for (const entries of Object.values(business)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        maxPct = Math.max(maxPct, maxPctOf(entry));
        const minutes = asNumber(entry.estimated_time_to_regain_access);
        if (minutes !== null) regain(minutes * 60_000);
      }
    }
  }

  const account = parseHeaderJson(headers, "x-ad-account-usage");
  if (isRecord(account)) {
    const pct = maxPctOf(account);
    maxPct = Math.max(maxPct, pct);
    const seconds = asNumber(account.reset_time_duration);
    if (seconds !== null && pct >= 100) regain(seconds * 1000);
  }

  return { maxPct, regainAfterMs };
}

function mergeUsage(a: MetaUsage, b: MetaUsage): MetaUsage {
  const regains = [a.regainAfterMs, b.regainAfterMs].filter((v): v is number => v !== null);
  return {
    maxPct: Math.max(a.maxPct, b.maxPct),
    regainAfterMs: regains.length ? Math.max(...regains) : null,
  };
}

const EMPTY_USAGE: MetaUsage = { maxPct: 0, regainAfterMs: null };

/** Rate limit da Graph API: 4, 17, 32, 613 e a faixa 80000–80014. */
export function isMetaRateLimitCode(code: number | null): boolean {
  if (code === null) return false;
  return [4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014);
}

/** O caminho da Graph API sem o prefixo de versão (`/v21.0/act_1/ads` → `/act_1/ads`). */
export function graphPathOf(url: string | URL): string {
  try {
    return new URL(String(url)).pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  } catch {
    return String(url).split("?")[0];
  }
}

function graphUrl(path: string, params: Record<string, string> = {}) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const version = resolveMetaApiVersion(process.env.META_API_VERSION);
  const url = new URL(`https://${GRAPH_HOST}/${version}${normalized}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // A chave vai no cabeçalho: um `access_token` esquecido nos params é descartado.
  url.searchParams.delete("access_token");
  return url;
}

/**
 * O `paging.next` da Meta sem `access_token`. Só segue links do próprio host da
 * Graph API: o cabeçalho Authorization nunca vai para outro destino.
 */
function sanitizeNextUrl(next: string) {
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new MetaApiError(BAD_PAGING_MESSAGE);
  }
  if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) {
    throw new MetaApiError(BAD_PAGING_MESSAGE, { path: url.pathname });
  }
  url.searchParams.delete("access_token");
  return url;
}

type MetaErrorBody = {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    type?: unknown;
    fbtrace_id?: unknown;
  };
};

function errorFromBody(body: unknown, status: number, path: string, usage: MetaUsage) {
  const error =
    isRecord(body) && isRecord((body as MetaErrorBody).error)
      ? (body as Required<MetaErrorBody>).error
      : {};
  const code = typeof error.code === "number" ? error.code : null;
  return new MetaApiError(
    typeof error.message === "string" && error.message ? error.message : `Meta API HTTP ${status}`,
    {
      code,
      subcode: typeof error.error_subcode === "number" ? error.error_subcode : null,
      status,
      type: typeof error.type === "string" ? error.type : null,
      path,
      fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id : null,
      retryAfterMs: isMetaRateLimitCode(code) ? usage.regainAfterMs : null,
    },
  );
}

type RequestOptions = { timeoutMs?: number };

/** Uma chamada à Graph API com timeout (cobre também a leitura do corpo). */
async function request<T>(
  method: "GET" | "POST",
  url: URL,
  token: string,
  opts: RequestOptions = {},
  body?: URLSearchParams,
): Promise<{ data: T; usage: MetaUsage }> {
  const path = graphPathOf(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    response = await fetch(url, { method, headers, body, signal: controller.signal });
    text = await response.text();
  } catch {
    if (controller.signal.aborted) {
      throw new MetaApiError(TIMEOUT_MESSAGE, { type: "timeout", path });
    }
    throw new MetaApiError(NETWORK_MESSAGE, { type: "network", path });
  } finally {
    clearTimeout(timeout);
  }

  const usage = parseMetaUsageHeaders(response.headers);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MetaApiError(`Meta API HTTP ${response.status}`, {
      status: response.status,
      path,
    });
  }
  if (!response.ok || (isRecord(json) && json.error)) {
    throw errorFromBody(json, response.status, path, usage);
  }
  return { data: json as T, usage };
}

export async function metaGet<T>(
  path: string,
  token: string,
  params?: Record<string, string>,
  opts?: { timeoutMs?: number },
): Promise<{ data: T; usage: MetaUsage }> {
  return request<T>("GET", graphUrl(path, params), token, opts);
}

export async function metaPost<T>(
  path: string,
  token: string,
  params?: Record<string, string>,
  opts?: { timeoutMs?: number },
): Promise<{ data: T; usage: MetaUsage }> {
  const url = graphUrl(path);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key !== "access_token") body.set(key, value);
  }
  return request<T>("POST", url, token, opts, body);
}

type MetaPage<T> = { data?: T[]; paging?: { next?: string } };

/** Todas as páginas de uma listagem; o timeout vale para cada página. */
export async function metaGetAllPages<T>(
  path: string,
  token: string,
  params?: Record<string, string>,
  opts?: { timeoutMs?: number },
): Promise<{ rows: T[]; usage: MetaUsage }> {
  const first = await metaGet<MetaPage<T>>(path, token, params, opts);
  const rows = [...(first.data.data ?? [])];
  let usage = first.usage;
  let next = first.data.paging?.next;
  while (next) {
    const page = await request<MetaPage<T>>("GET", sanitizeNextUrl(next), token, opts);
    rows.push(...(page.data.data ?? []));
    usage = mergeUsage(usage, page.usage);
    next = page.data.paging?.next;
  }
  return { rows, usage };
}

export type MetaTokenInfo = {
  isValid: boolean;
  type: string | null;
  appId: string | null;
  userId: string | null;
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  scopes: string[];
};

/** Unix (s) → ISO; 0 ou ausente → null (a Meta usa 0 para "nunca expira"). */
function unixToIso(value: unknown) {
  const seconds = asNumber(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function idOf(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return null;
}

type DebugTokenData = {
  is_valid?: unknown;
  type?: unknown;
  app_id?: unknown;
  user_id?: unknown;
  expires_at?: unknown;
  data_access_expires_at?: unknown;
  scopes?: unknown;
};

const INVALID_TOKEN_CODES = new Set([190, 102, 463, 467]);

/**
 * `GET /debug_token?input_token=<token>`, autorizado pela própria chave. Uma chave
 * já inválida costuma derrubar a chamada inteira (OAuthException 190): isso vira
 * `isValid: false`. Os demais erros (timeout, rate limit, 5xx) sobem.
 */
export async function debugMetaToken(token: string): Promise<MetaTokenInfo> {
  let data: DebugTokenData;
  try {
    const result = await metaGet<{ data?: DebugTokenData }>("/debug_token", token, {
      input_token: token,
    });
    data = result.data.data ?? {};
  } catch (error) {
    if (
      error instanceof MetaApiError &&
      ((error.code !== null && INVALID_TOKEN_CODES.has(error.code)) ||
        (error.subcode !== null && INVALID_TOKEN_CODES.has(error.subcode)))
    ) {
      return {
        isValid: false,
        type: null,
        appId: null,
        userId: null,
        expiresAt: null,
        dataAccessExpiresAt: null,
        scopes: [],
      };
    }
    throw error;
  }
  return {
    isValid: data.is_valid === true,
    type: typeof data.type === "string" && data.type ? data.type : null,
    appId: idOf(data.app_id),
    userId: idOf(data.user_id),
    expiresAt: unixToIso(data.expires_at),
    dataAccessExpiresAt: unixToIso(data.data_access_expires_at),
    scopes: Array.isArray(data.scopes)
      ? data.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

const NOT_READY_TYPE = "not_ready";

/**
 * O relatório assíncrono não ficou pronto dentro de `maxWaitMs` (`type` "not_ready",
 * `retryAfterMs` 5 min). Não é falha da conta nem da chave: o worker trata como um
 * rate limit (espera sem gastar tentativa).
 */
export function isMetaReportNotReady(error: unknown): error is MetaApiError {
  return error instanceof MetaApiError && error.type === NOT_READY_TYPE;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AsyncStatus = { async_status?: string; async_percent_completion?: number | string | null };

/**
 * A Meta às vezes responde "Job Completed" antes de o relatório estar 100 %
 * pronto; ler nessa hora devolve dados parciais. Só conta como concluído com
 * `async_percent_completion` 100 ou ausente.
 */
function isReportCompleted(status: AsyncStatus) {
  if (status.async_status !== "Job Completed") return false;
  const pct = asNumber(status.async_percent_completion);
  return pct === null || pct >= 100;
}

/**
 * Insights assíncronos (MB2-07): `POST /{act}/insights` devolve `report_run_id`;
 * consulta `async_status` a cada `pollIntervalMs` até "Job Completed" com 100 % (ou
 * sem percentual) e então lê
 * `/{report_run_id}/insights` página a página. Antes de cada consulta chama
 * `onPoll` (o worker renova a trava do job); `false` interrompe a leitura.
 */
export async function loadMetaInsightsAsync<T>(
  adAccountPath: string,
  token: string,
  params: Record<string, string>,
  opts: { pollIntervalMs?: number; maxWaitMs?: number; onPoll?: () => Promise<boolean> } = {},
): Promise<{ rows: T[]; usage: MetaUsage }> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const account = adAccountPath.replace(/^\/+/, "");
  const insightsPath = `/${account}/insights`;

  const started = await metaPost<{ report_run_id?: string | number }>(insightsPath, token, params);
  let usage = mergeUsage(EMPTY_USAGE, started.usage);
  const reportRunId = idOf(started.data.report_run_id);
  if (!reportRunId) {
    throw new MetaApiError(REPORT_FAILED_MESSAGE, { path: insightsPath });
  }

  const startedAt = Date.now();
  for (;;) {
    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new MetaApiError(REPORT_NOT_READY_MESSAGE, {
        type: NOT_READY_TYPE,
        path: `/${reportRunId}`,
        retryAfterMs: NOT_READY_RETRY_MS,
      });
    }
    await sleep(Math.min(pollIntervalMs, remaining));
    if (opts.onPoll && !(await opts.onPoll())) {
      throw new MetaApiError(ABORTED_MESSAGE, { type: "aborted", path: `/${reportRunId}` });
    }
    const status = await metaGet<AsyncStatus>(`/${reportRunId}`, token, {
      fields: "async_status,async_percent_completion",
    });
    usage = mergeUsage(usage, status.usage);
    const state = status.data.async_status;
    if (isReportCompleted(status.data)) break;
    if (state === "Job Failed" || state === "Job Skipped") {
      throw new MetaApiError(REPORT_FAILED_MESSAGE, { path: `/${reportRunId}` });
    }
  }

  const resultParams: Record<string, string> = {};
  if (params.limit) resultParams.limit = params.limit;
  const result = await metaGetAllPages<T>(`/${reportRunId}/insights`, token, resultParams);
  return { rows: result.rows, usage: mergeUsage(usage, result.usage) };
}
