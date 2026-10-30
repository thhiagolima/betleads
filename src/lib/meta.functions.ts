import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveMetaApiVersion } from "@/lib/meta-api-version";
import {
  INSIGHT_FIELDS,
  catalogRow,
  catalogRowsFromInsights,
  insightRow,
  syncWindows,
  type MetaAd,
  type MetaInsight,
} from "@/lib/meta-sync-rows";
import { isBillingLockedError } from "@/lib/billing/billing-locked-error";
import { decryptMetaToken, encryptMetaToken, metaTokenHint } from "@/lib/meta-token.server";
import {
  TENANT_BLOCKED_MESSAGE,
  assertTenantCanOperate,
  assertTenantNotDemo,
  listDemoTenantIds,
  requireTenantAdmin,
  resolveCurrentTenantId,
} from "@/lib/tenant-access.server";

const syncSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
});
const systemTokenSchema = z.object({
  accessToken: z.string().trim().min(40).max(1000),
});
const metaConnectionSchema = z.object({
  connectionId: z.string().uuid(),
});
const metaAccountSelectionSchema = z.object({
  accountIds: z.array(z.string().uuid()).max(200),
});

/** D4: conta recém-marcada importa os últimos 90 dias (em blocos de 30, no worker). */
const META_BACKFILL_DAYS = 90;
/** MB1-06: a lista de contas de cada chave é relida da Meta uma vez por dia. */
const DISCOVERY_STALE_MS = 24 * 60 * 60 * 1000;
/** Quantas chaves a redescoberta lê por tick, para não alongar o worker. */
const DISCOVERY_PER_TICK = 10;
/**
 * Uma chave cuja redescoberta foi tentada há menos disto fica de fora: a tentativa
 * (com ou sem sucesso) é gravada em `permissions_checked_at`, então uma chave que
 * falha sempre não passa à frente das outras a cada tick.
 */
const DISCOVERY_RETRY_MS = 60 * 60 * 1000;
/**
 * Orçamento de tempo de um tick. O cron chama o worker com timeout HTTP de 55 s;
 * passados 40 s o tick não começa job, bloco de backfill nem redescoberta nova (o
 * que estiver em andamento termina), e os jobs não começados voltam para a fila.
 */
const TICK_BUDGET_MS = 40_000;
/** Tamanho da página nas leituras de acessos (o limite do PostgREST). */
const ACCESS_PAGE_SIZE = 1000;
/**
 * Nova tentativa depois de um rate limit da Meta: 15 min × 2^(tentativa-1)
 * (15, 30, 60 min), em vez dos 2^n min dos demais erros de leitura.
 */
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

type MetaAccountForSync = {
  id: string;
  tenant_id: string;
  // Conexão preferida (MB1): a chave que o worker tenta primeiro.
  connection_id: string;
  meta_ad_account_id: string;
  account_id: string | null;
  name: string | null;
  currency: string | null;
  timezone_name: string | null;
};

type MetaConnectionToken = {
  id?: string;
  tenant_id: string;
  // Só o token cifrado: o `access_token` em texto puro das conexões antigas não é
  // mais lido (MB0-03).
  encrypted_access_token: string | null;
  status?: string;
  token_validated_at?: string | null;
};

/** Um acesso ativo da conta por uma chave conectada da mesma casa (MB1-05). */
type MetaAccessCandidate = {
  accessId: string;
  connectionId: string;
  connection: MetaConnectionToken;
};

const LEGACY_CONNECTION_MESSAGE =
  "Conexão antiga: reconecte usando a chave de acesso do Usuário do Sistema.";
const NO_CONNECTION_MESSAGE = "Nenhuma chave conectada alcança esta conta.";
const ACCOUNT_GONE_MESSAGE = "A conta foi removida ou deixou de estar selecionada.";
const ADS_READ_LOST_MESSAGE = "A chave perdeu a permissão ads_read.";
const EMPTY_DISCOVERY_MESSAGE =
  "A Meta não devolveu nenhuma conta para esta chave. Teste o acesso.";
const APP_ACCESS_TIER_MESSAGE =
  "O app da Meta não tem o nível de acesso necessário (Standard Access).";

/**
 * Põe a conexão em erro. Nunca ressuscita uma chave desconectada (`disabled`): o
 * filtro deixa o update sem efeito se ela foi desconectada no meio do caminho.
 */
async function markConnectionError(
  tenantId: string,
  connectionId: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const { error } = await (supabaseAdmin as any)
    .from("meta_connections")
    .update({ status: "error", last_error: message.slice(0, 1000), ...extra })
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .neq("status", "disabled");
  if (error) console.error("[meta-sync connection]", connectionId, error.message);
}

/** O token da conexão, só a partir da versão cifrada. Sem ela, pede reconexão. */
async function connectionToken(connection: { encrypted_access_token?: string | null } | null) {
  if (!connection?.encrypted_access_token) throw new Error(LEGACY_CONNECTION_MESSAGE);
  return decryptMetaToken(connection.encrypted_access_token);
}

type MetaAdAccount = {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  business?: { id?: string; name?: string };
};

type MetaPermission = { permission: string; status: string };
type MetaApp = { id: string; name?: string };
type MetaUser = { id: string; name?: string };

/**
 * Erro devolvido pela Graph API, com o código da Meta e o caminho chamado (sem a
 * versão). O worker usa os dois para separar o erro da chave do erro de acesso a
 * uma conta (`metaErrorLevel`). A tabela completa de retentáveis é da MB2.
 */
export class MetaApiError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly status: number;
  readonly path: string | null;

  constructor(
    message: string,
    details: {
      code?: number | null;
      subcode?: number | null;
      status: number;
      path?: string | null;
    },
  ) {
    super(message);
    this.name = "MetaApiError";
    this.code = details.code ?? null;
    this.subcode = details.subcode ?? null;
    this.status = details.status;
    this.path = details.path ?? null;
  }
}

type MetaErrorBody = {
  error?: { message?: string; code?: unknown; error_subcode?: unknown };
};

/** O caminho da Graph API sem o prefixo de versão (`/v21.0/act_1/ads` → `/act_1/ads`). */
function graphPath(url: string | URL) {
  try {
    return new URL(String(url)).pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  } catch {
    return null;
  }
}

function metaApiError(json: MetaErrorBody, status: number, path: string | null) {
  const body = json.error ?? {};
  return new MetaApiError(body.message ?? `Meta API HTTP ${status}`, {
    code: typeof body.code === "number" ? body.code : null,
    subcode: typeof body.error_subcode === "number" ? body.error_subcode : null,
    status,
    path,
  });
}

const TOKEN_ERROR_CODES = new Set([190, 102, 463, 467]);

/**
 * Nível de acesso do app (270–279, ex.: "requires Standard Access"): vale para o app
 * inteiro, mesmo vindo de uma chamada `act_…`. Nunca revoga o acesso de uma conta.
 */
function isAppAccessTierCode(code: number | null) {
  return code !== null && code >= 270 && code <= 279;
}

/** Rate limit da Graph API: 4, 17, 32, 613 e a faixa 80000–80014. */
function isRateLimitCode(code: number | null) {
  if (code === null) return false;
  return [4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014);
}

/** Código de permissão da Graph API: 10 ou a faixa 200–299. */
function isPermissionCode(code: number | null) {
  return code === 10 || (code !== null && code >= 200 && code <= 299);
}

/**
 * Em que nível o erro está:
 * - `token`: a chave inteira não serve mais (190/102/463/467 no código ou subcódigo,
 *   conexão antiga sem token cifrado, erro de permissão numa chamada `/me…`, que
 *   não depende de conta nenhuma, ou nível de acesso do app — 270–279 — em qualquer
 *   chamada, porque vale para o app inteiro);
 * - `account`: a chave perdeu o acesso a esta conta ("Object with ID 'act_…' does
 *   not exist…", código 100 / subcódigo 33);
 * - `account_permission`: erro de permissão (10, 200–299) numa chamada `act_…`. Só
 *   vira `account` depois de confirmar que a chave ainda tem `ads_read`
 *   (`GET /me/permissions`); sem ela, é erro da chave;
 * - `null`: leitura (rate limit, timeout, versão da API descontinuada — 2635 — ou
 *   erro desconhecido). Volta para a regra de nova tentativa, sem revogar nada nem
 *   trocar de chave.
 */
export type MetaErrorLevel = "token" | "account" | "account_permission" | null;

export function metaErrorLevel(error: unknown): MetaErrorLevel {
  if (error instanceof MetaApiError) {
    const { code, subcode, path } = error;
    if (code !== null && TOKEN_ERROR_CODES.has(code)) return "token";
    if (subcode !== null && TOKEN_ERROR_CODES.has(subcode)) return "token";
    if (isAppAccessTierCode(code)) return "token";
    const mePath = path === "/me" || Boolean(path?.startsWith("/me/"));
    if (isPermissionCode(code) && mePath) return "token";
    if (code === 100 && subcode === 33) return "account";
    if (isPermissionCode(code) && path?.startsWith("/act_")) return "account_permission";
    return null;
  }
  if (errorMessage(error) === LEGACY_CONNECTION_MESSAGE) return "token";
  return null;
}

/** Mensagem gravada para o erro: o de nível de acesso do app vira texto da operação. */
function metaErrorMessage(error: unknown) {
  if (error instanceof MetaApiError && isAppAccessTierCode(error.code)) {
    return APP_ACCESS_TIER_MESSAGE;
  }
  return errorMessage(error);
}

function metaApiVersion() {
  return resolveMetaApiVersion(process.env.META_API_VERSION);
}

function accountPath(id: string) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

/** Uma chamada à Graph API (primeira página ou `paging.next`), com timeout. */
async function fetchMetaUrl<T>(url: string | URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A Meta demorou demais para responder. Tente novamente.");
    }
    throw new Error("Não foi possível acessar a API da Meta.");
  } finally {
    clearTimeout(timeout);
  }
  const json = (await response.json().catch(() => ({}))) as T &
    MetaErrorBody & { paging?: { next?: string } };
  if (!response.ok || json.error) throw metaApiError(json, response.status, graphPath(url));
  return json as T & { paging?: { next?: string } };
}

async function fetchMetaJson<T>(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return fetchMetaUrl<T>(url);
}

/** Todas as páginas de uma listagem da Graph API. */
async function fetchMetaPages<T>(path: string, params: Record<string, string>) {
  const first = await fetchMetaJson<{ data?: T[] }>(path, params);
  const rows = [...(first.data ?? [])];
  let next = first.paging?.next;
  while (next) {
    const page = await fetchMetaUrl<{ data?: T[] }>(next);
    rows.push(...(page.data ?? []));
    next = page.paging?.next;
  }
  return rows;
}

async function loadInsights(
  accessToken: string,
  adAccountId: string,
  window: { since: string; until: string },
) {
  return fetchMetaPages<MetaInsight>(`/${accountPath(adAccountId)}/insights`, {
    access_token: accessToken,
    fields: INSIGHT_FIELDS,
    level: "ad",
    time_increment: "1",
    limit: "500",
    time_range: JSON.stringify(window),
  });
}

async function loadActiveAds(accessToken: string, adAccountId: string) {
  return fetchMetaPages<MetaAd>(`/${accountPath(adAccountId)}/ads`, {
    access_token: accessToken,
    fields:
      "id,name,status,effective_status,campaign{id,name,status,effective_status},adset{id,name,status,effective_status},creative{id,name,thumbnail_url,image_url,effective_object_story_id}",
    effective_status: JSON.stringify(["ACTIVE"]),
    limit: "500",
  });
}

async function loadAllAdAccounts(accessToken: string) {
  return fetchMetaPages<MetaAdAccount>("/me/adaccounts", {
    access_token: accessToken,
    limit: "200",
    fields: "id,account_id,name,currency,timezone_name,account_status,business{id,name}",
  });
}

/** Uma conta como os RPCs `meta_connect_token`/`meta_upsert_connection_accounts` esperam. */
function accountPayload(account: MetaAdAccount) {
  return {
    meta_ad_account_id: account.id,
    account_id: account.account_id ?? null,
    name: account.name ?? account.id,
    business_id: account.business?.id ?? null,
    business_name: account.business?.name ?? null,
    currency: account.currency ?? null,
    timezone_name: account.timezone_name ?? null,
    account_status: account.account_status ?? null,
    raw: account,
  };
}

function discoveryCounts(data: unknown) {
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    accountsTotal: Number(result.accounts_total ?? 0),
    accountsNew: Number(result.accounts_new ?? 0),
    accountsRevoked: Number(result.accounts_revoked ?? 0),
    businesses: Number(result.businesses ?? 0),
  };
}

/** Grava a lista de contas que a chave alcança agora (contas, acessos e revogações). */
async function upsertConnectionAccounts(
  tenantId: string,
  connectionId: string,
  adAccounts: MetaAdAccount[],
) {
  const { data, error } = await (supabaseAdmin as any).rpc("meta_upsert_connection_accounts", {
    p_tenant_id: tenantId,
    p_connection_id: connectionId,
    p_accounts: adAccounts.map(accountPayload),
  });
  if (error) throw new Error(error.message);
  return discoveryCounts(data);
}

function embedded<T>(value: T | T[] | null | undefined): T | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

async function resolveTenantId(client: unknown) {
  const supabase = client as {
    rpc: (name: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  return resolveCurrentTenantId(supabase);
}

// Corpo das server functions que mexem na conexão, fora do createServerFn para ser
// testável (o compilador do TanStack Start troca o handler por um stub fora do servidor).
type TenantRpcClient = Parameters<typeof requireTenantAdmin>[0];
type MetaActionContext = { supabase: TenantRpcClient; userId: string };

const META_ADMIN_MESSAGE = "Apenas administradores da casa podem alterar a conexão com a Meta.";

/**
 * A casa ativa, só para o admin dela ou o super admin (D3). Conectar, escolher
 * contas, testar, desconectar e "Atualizar agora" passam por aqui; o resumo e o
 * histórico de sincronização continuam abertos a qualquer membro.
 */
async function requireMetaAdmin(client: TenantRpcClient, message = META_ADMIN_MESSAGE) {
  const tenantId = await resolveTenantId(client);
  return requireTenantAdmin(client, tenantId, message);
}

export const connectMetaSystemUserToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => systemTokenSchema.parse(input))
  .handler(async ({ data, context }) => connectMetaSystemUserTokenFor(context, data));

/**
 * Conecta uma chave (MB1-02). Uma conexão por token (app + Usuário do Sistema, D1):
 * reconectar o mesmo Usuário do Sistema só troca a chave. A conexão, as contas, os
 * acessos, a auditoria e `marketing_integrations` são gravados numa transação só,
 * dentro de `meta_connect_token`.
 */
export async function connectMetaSystemUserTokenFor(
  context: MetaActionContext,
  data: z.infer<typeof systemTokenSchema>,
) {
  const tenantId = await requireMetaAdmin(context.supabase);
  await assertTenantNotDemo(tenantId);
  const token = data.accessToken;
  const [metaUser, metaApp, permissions, adAccounts] = await Promise.all([
    fetchMetaJson<MetaUser>("/me", { access_token: token, fields: "id,name" }),
    fetchMetaJson<MetaApp>("/app", { access_token: token, fields: "id,name" }),
    fetchMetaJson<{ data?: MetaPermission[] }>("/me/permissions", { access_token: token }),
    loadAllAdAccounts(token),
  ]);
  const granted = (permissions.data ?? [])
    .filter((item) => item.status === "granted")
    .map((item) => item.permission);
  if (!granted.includes("ads_read")) throw new Error("O token não possui a permissão ads_read.");
  if (adAccounts.length === 0)
    throw new Error("O usuário do sistema não possui contas de anúncios atribuídas.");

  const encrypted = await encryptMetaToken(token);
  const { data: result, error } = await (supabaseAdmin as any).rpc("meta_connect_token", {
    p_tenant_id: tenantId,
    p_actor: context.userId,
    p_connection: {
      meta_user_id: metaUser.id,
      meta_user_name: metaUser.name ?? "Usuário do sistema Meta",
      app_id: metaApp.id,
      app_name: metaApp.name ?? null,
      encrypted_access_token: encrypted,
      token_hint: metaTokenHint(token),
      scopes: granted,
      label: metaUser.name ?? metaApp.name ?? "Conta Meta",
    },
    p_accounts: adAccounts.map(accountPayload),
  });
  if (error) throw new Error(error.message);
  const counts = discoveryCounts(result);

  return {
    connectionId: String((result as { connection_id?: unknown } | null)?.connection_id ?? ""),
    created: Boolean((result as { created?: unknown } | null)?.created),
    accountsTotal: counts.accountsTotal,
    accountsNew: counts.accountsNew,
    businesses: counts.businesses,
    userName: metaUser.name ?? null,
    app: { id: metaApp.id, name: metaApp.name ?? null },
    permissions: granted,
    accounts: adAccounts.map((account) => ({
      id: account.id,
      name: account.name ?? account.id,
      businessName: account.business?.name ?? null,
      currency: account.currency ?? null,
      selected: false,
    })),
  };
}

export const updateMetaAccountSelection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaAccountSelectionSchema.parse(input))
  .handler(async ({ data, context }) => updateMetaAccountSelectionFor(context, data));

/**
 * Salva as contas marcadas (MB1-03). O RPC faz o diff numa transação e cria o run de
 * backfill (90 dias) para as recém-marcadas.
 */
export async function updateMetaAccountSelectionFor(
  context: MetaActionContext,
  data: z.infer<typeof metaAccountSelectionSchema>,
) {
  const tenantId = await requireMetaAdmin(context.supabase);
  await assertTenantNotDemo(tenantId);
  const { data: result, error } = await (supabaseAdmin as any).rpc("meta_select_accounts", {
    p_tenant_id: tenantId,
    p_actor: context.userId,
    p_account_ids: data.accountIds,
    p_backfill_days: META_BACKFILL_DAYS,
  });
  if (error) throw new Error(error.message);
  const row = (result ?? {}) as Record<string, unknown>;
  return {
    selected: Number(row.selected ?? 0),
    added: Number(row.added ?? 0),
    removed: Number(row.removed ?? 0),
    backfillRunId: row.backfill_run_id ? String(row.backfill_run_id) : null,
  };
}

export const validateMetaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaConnectionSchema.parse(input))
  .handler(async ({ data, context }) => validateMetaConnectionFor(context, data));

export async function validateMetaConnectionFor(
  context: MetaActionContext,
  data: z.infer<typeof metaConnectionSchema>,
) {
  const tenantId = await requireMetaAdmin(context.supabase);
  await assertTenantNotDemo(tenantId);
  const { data: connection, error: connectionError } = await (supabaseAdmin as any)
    .from("meta_connections")
    .select("id,encrypted_access_token,app_id,status")
    .eq("tenant_id", tenantId)
    .eq("id", data.connectionId)
    .maybeSingle();
  if (connectionError) throw new Error(connectionError.message);
  if (!connection || connection.status === "disabled")
    throw new Error("Conexão Meta não encontrada.");

  const token = await connectionToken(connection);

  let granted: string[];
  let adAccounts: MetaAdAccount[];
  try {
    const [metaApp, permissions, accounts] = await Promise.all([
      fetchMetaJson<MetaApp>("/app", { access_token: token, fields: "id,name" }),
      fetchMetaJson<{ data?: MetaPermission[] }>("/me/permissions", { access_token: token }),
      loadAllAdAccounts(token),
    ]);
    granted = (permissions.data ?? [])
      .filter((item) => item.status === "granted")
      .map((item) => item.permission);
    if (!granted.includes("ads_read")) throw new Error("A permissão ads_read não está ativa.");
    if (connection.app_id && connection.app_id !== metaApp.id) {
      throw new Error("O token foi emitido por outro app Meta.");
    }
    // Sem filtro por BM (D1): a chave vale por todas as contas que alcança.
    if (accounts.length === 0) {
      throw new Error("O token não possui mais acesso a nenhuma conta de anúncio.");
    }
    adAccounts = accounts;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível validar a conexão.";
    await markConnectionError(tenantId, connection.id, message, {
      permissions_checked_at: new Date().toISOString(),
    });
    throw new Error(message);
  }

  // A conexão volta a `connected` antes da redescoberta: o RPC só move a preferência
  // de uma conta para uma chave conectada. Uma chave desconectada no meio do teste
  // continua desconectada (o RPC abaixo então recusa).
  const checkedAt = new Date().toISOString();
  const { error: updateError } = await (supabaseAdmin as any)
    .from("meta_connections")
    .update({
      scopes: granted,
      token_validated_at: checkedAt,
      permissions_checked_at: checkedAt,
      status: "connected",
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("tenant_id", tenantId)
    .neq("status", "disabled");
  if (updateError) throw new Error(updateError.message);
  const counts = await upsertConnectionAccounts(tenantId, connection.id, adAccounts);
  await (supabaseAdmin as any).from("meta_connection_audit").insert({
    tenant_id: tenantId,
    connection_id: connection.id,
    actor_user_id: context.userId,
    action: "validated",
    metadata: { accessible_accounts: adAccounts.length, ...counts },
  });
  return {
    ok: true,
    accounts: adAccounts.length,
    accountsNew: counts.accountsNew,
    accountsRevoked: counts.accountsRevoked,
    permissions: granted,
  };
}

export const disconnectMetaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaConnectionSchema.parse(input))
  .handler(async ({ data, context }) => disconnectMetaConnectionFor(context, data));

/**
 * Desconecta uma chave (MB1-04): apaga o token e os acessos dela. Uma conta que
 * outra chave conectada alcança passa para ela e continua sincronizando.
 */
export async function disconnectMetaConnectionFor(
  context: MetaActionContext,
  data: z.infer<typeof metaConnectionSchema>,
) {
  const tenantId = await requireMetaAdmin(context.supabase);
  await assertTenantNotDemo(tenantId);
  const { data: result, error } = await (supabaseAdmin as any).rpc("meta_disconnect_connection", {
    p_tenant_id: tenantId,
    p_actor: context.userId,
    p_connection_id: data.connectionId,
  });
  if (error) throw new Error(error.message);
  const row = (result ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    accountsMoved: Number(row.accounts_moved ?? 0),
    accountsStopped: Number(row.accounts_stopped ?? 0),
  };
}

export const getMetaConnectionSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getMetaConnectionSummaryFor(context));

/** As chaves e as contas da casa, cada conta com as chaves que a alcançam. */
export async function getMetaConnectionSummaryFor(context: { supabase: unknown }) {
  const tenantId = await resolveTenantId(context.supabase);

  const [connectionsRes, accountsRes, accessRows] = await Promise.all([
    supabaseAdmin
      .from("meta_connections")
      .select(
        "id, meta_user_id, meta_user_name, scopes, token_expires_at, status, last_error, connected_at, last_sync_at, auth_type, token_hint, token_validated_at, permissions_checked_at, app_id, app_name, business_id, connection_label, accounts_discovered_at",
      )
      .eq("tenant_id", tenantId)
      .neq("status", "disabled")
      .order("connected_at", { ascending: false }),
    supabaseAdmin
      .from("meta_ad_accounts")
      .select(
        "id, connection_id, meta_ad_account_id, account_id, name, business_id, business_name, currency, timezone_name, account_status, selected, last_sync_at, sync_status, last_attempt_at, last_success_at, last_error, last_row_count",
      )
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    // Em páginas de 1000 (o limite do PostgREST), em ordem estável.
    readAllPages<{ account_id: string; connection_id: string }>((from, to) =>
      (supabaseAdmin as any)
        .from("meta_ad_account_access")
        .select("account_id,connection_id")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  if (connectionsRes.error) throw new Error(connectionsRes.error.message);
  if (accountsRes.error) throw new Error(accountsRes.error.message);

  const accessByAccount = new Map<string, string[]>();
  for (const row of accessRows) {
    accessByAccount.set(row.account_id, [
      ...(accessByAccount.get(row.account_id) ?? []),
      row.connection_id,
    ]);
  }

  return {
    connections: connectionsRes.data ?? [],
    accounts: (accountsRes.data ?? []).map((account) => ({
      ...account,
      access_connection_ids: accessByAccount.get(account.id) ?? [],
    })),
  };
}

/**
 * As chaves que podem ler a conta, na ordem de tentativa (MB1-05): a preferida
 * primeiro, depois as demais pela validação mais recente. Só acessos ativos por
 * conexões conectadas da mesma casa da conta.
 */
async function loadAccessCandidates(tenantId: string, account: MetaAccountForSync) {
  const { data, error } = await (supabaseAdmin as any)
    .from("meta_ad_account_access")
    .select(
      "id,connection_id,meta_connections!inner(id,tenant_id,encrypted_access_token,status,token_validated_at)",
    )
    .eq("account_id", account.id)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .eq("meta_connections.status", "connected")
    .eq("meta_connections.tenant_id", tenantId);
  if (error) throw new Error(error.message);
  const candidates: MetaAccessCandidate[] = [];
  for (const row of (data ?? []) as Array<{
    id: string;
    connection_id: string;
    meta_connections: MetaConnectionToken | MetaConnectionToken[] | null;
  }>) {
    const connection = embedded(row.meta_connections);
    if (!connection || connection.tenant_id !== tenantId) continue;
    candidates.push({ accessId: row.id, connectionId: row.connection_id, connection });
  }
  return candidates.sort((a, b) => {
    if (a.connectionId === account.connection_id) return -1;
    if (b.connectionId === account.connection_id) return 1;
    return String(b.connection.token_validated_at ?? "").localeCompare(
      String(a.connection.token_validated_at ?? ""),
    );
  });
}

/** Erro que não adianta repetir: nenhuma chave restou para ler a conta. */
class MetaSyncPermanentError extends Error {}

/**
 * O job parou entre dois blocos sem falhar: `lock` (outro worker pegou o job; ele
 * fica com o job) ou `budget` (o tick passou do orçamento; o job volta para a fila).
 */
class MetaJobInterrupted extends Error {
  constructor(readonly reason: "lock" | "budget") {
    super(reason === "lock" ? "Lock do job perdido." : "Orçamento do tick esgotado.");
  }
}

/** `ads_read` de cada chave, lido no máximo uma vez por tick. */
type AdsReadCache = Map<string, Promise<boolean>>;

/** A chave ainda tem `ads_read`? Uma chamada a `/me/permissions` por chave e tick. */
function keyHasAdsRead(cache: AdsReadCache, connectionId: string, token: string) {
  let pending = cache.get(connectionId);
  if (!pending) {
    pending = fetchMetaJson<{ data?: MetaPermission[] }>("/me/permissions", {
      access_token: token,
    }).then((permissions) =>
      (permissions.data ?? []).some(
        (item) => item.permission === "ads_read" && item.status === "granted",
      ),
    );
    cache.set(connectionId, pending);
  }
  return pending;
}

/**
 * Lê a conta com um token: catálogo de anúncios ativos e insights da janela, em
 * blocos de até 30 dias (do mais antigo ao mais recente). Cada bloco é substituído
 * numa transação; uma falha no meio mantém os blocos anteriores e falha o job.
 * `beforeChunk` roda antes de cada bloco depois do primeiro e pode interromper o
 * job (`MetaJobInterrupted`).
 */
async function importMetaAccount(
  tenantId: string,
  account: MetaAccountForSync,
  days: number,
  token: string,
  beforeChunk: () => Promise<void>,
) {
  const now = new Date().toISOString();
  const activeAds: MetaAd[] = await loadActiveAds(token, account.meta_ad_account_id);
  if (activeAds.length > 0) {
    const { error } = await (supabaseAdmin as any).from("meta_ads").upsert(
      activeAds.map((ad) => catalogRow(tenantId, account.meta_ad_account_id, ad, now)),
      { onConflict: "tenant_id,ad_account_id,ad_id" },
    );
    if (error) throw new Error(error.message);
  }
  const knownAdIds = new Set(activeAds.map((ad) => ad.id));

  let imported = 0;
  const windows = syncWindows(account.timezone_name, days);
  for (const [index, window] of windows.entries()) {
    if (index > 0) await beforeChunk();
    const insights = await loadInsights(token, account.meta_ad_account_id, window);
    const missingCatalog = catalogRowsFromInsights(
      tenantId,
      account.meta_ad_account_id,
      insights,
      knownAdIds,
      now,
    );
    if (missingCatalog.length > 0) {
      // Anúncio pausado ou encerrado que teve entrega: entra no catálogo sem apagar
      // a miniatura de quem já está lá.
      const { error } = await (supabaseAdmin as any).from("meta_ads").upsert(missingCatalog, {
        onConflict: "tenant_id,ad_account_id,ad_id",
        ignoreDuplicates: true,
      });
      if (error) throw new Error(error.message);
      missingCatalog.forEach((row) => knownAdIds.add(row.ad_id));
    }

    // O bloco inteiro é substituído numa transação: o que a Meta não devolve mais sai,
    // e uma falha antes deste ponto não zera o gasto já importado.
    const { data: replaced, error: replaceError } = await (supabaseAdmin as any).rpc(
      "replace_meta_ad_metrics",
      {
        p_tenant_id: tenantId,
        p_ad_account_id: account.meta_ad_account_id,
        p_since: window.since,
        p_until: window.until,
        p_rows: insights.map((row) => insightRow(row, account.currency)),
      },
    );
    if (replaceError) throw new Error(replaceError.message);
    imported += Number(replaced ?? 0);
  }
  return imported;
}

/**
 * Sincroniza a conta tentando as chaves na ordem de `loadAccessCandidates`. Erro de
 * acesso à conta (`metaErrorLevel`: `account`, ou `account_permission` com a chave
 * ainda com `ads_read`) revoga só aquele acesso; erro da chave (inclusive a perda de
 * `ads_read`) põe a conexão em erro; nos dois casos tenta a próxima chave. Erro de
 * leitura (timeout, rate limit, versão da API) para aqui e volta para a regra de
 * nova tentativa do job.
 */
async function syncMetaAccount(
  tenantId: string,
  account: MetaAccountForSync,
  days: number,
  beforeChunk: () => Promise<void>,
  adsReadCache: AdsReadCache,
) {
  await (supabaseAdmin as any)
    .from("meta_ad_accounts")
    .update({
      sync_status: "syncing",
      last_attempt_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", account.id)
    .eq("tenant_id", tenantId);

  const candidates = await loadAccessCandidates(tenantId, account);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    let imported: number;
    let token: string | null = null;
    try {
      token = await connectionToken(candidate.connection);
      imported = await importMetaAccount(tenantId, account, days, token, beforeChunk);
    } catch (error) {
      let level = metaErrorLevel(error);
      let failure: unknown = error;
      if (level === "account_permission" && token) {
        // Erro de permissão na conta: só revoga o acesso se a chave ainda tem
        // `ads_read`. Sem ela o problema é da chave, não desta conta.
        try {
          if (await keyHasAdsRead(adsReadCache, candidate.connectionId, token)) {
            level = "account";
          } else {
            level = "token";
            failure = new Error(ADS_READ_LOST_MESSAGE);
          }
        } catch (checkError) {
          // A própria leitura das permissões falhou: erro da chave, ou leitura
          // (volta para a regra de nova tentativa sem revogar nada).
          if (metaErrorLevel(checkError) !== "token") throw error;
          level = "token";
          failure = checkError;
        }
      }
      if (level !== "token" && level !== "account") throw error;
      lastError = failure;
      const message = metaErrorMessage(failure).slice(0, 1000);
      if (level === "account") {
        // Sob a trava da casa: revoga o acesso e, se a chave era a preferida, passa a
        // conta para outra chave conectada (ou a desmarca com o aviso padrão). Falha
        // nessa contabilidade é registrada e não para o job: tenta a próxima chave.
        const { error: revokeError } = await (supabaseAdmin as any).rpc(
          "meta_revoke_account_access",
          {
            p_tenant_id: tenantId,
            p_account_id: account.id,
            p_connection_id: candidate.connectionId,
            p_error: message,
          },
        );
        if (revokeError) {
          console.error("[meta-sync revoke]", account.id, revokeError.message);
        }
      } else {
        await markConnectionError(tenantId, candidate.connectionId, message);
      }
      continue;
    }

    const now = new Date().toISOString();
    await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .update({
        last_sync_at: now,
        last_success_at: now,
        sync_status: imported > 0 ? "healthy" : "warning",
        last_error: imported > 0 ? null : "A Meta não retornou dados para o período selecionado.",
        last_row_count: imported,
      })
      .eq("id", account.id)
      .eq("tenant_id", tenantId);
    // Sob a trava da casa: só se o acesso segue ativo e a chave segue conectada,
    // marca o sucesso do acesso e da chave e torna esta chave a preferida da conta.
    // Se a chave foi desconectada (ou o acesso revogado) no meio, nada muda; os
    // dados já foram importados e o job termina normalmente.
    const { data: applied, error: successError } = await (supabaseAdmin as any).rpc(
      "meta_record_account_sync_success",
      {
        p_tenant_id: tenantId,
        p_account_id: account.id,
        p_connection_id: candidate.connectionId,
      },
    );
    if (successError) {
      console.error("[meta-sync success]", account.id, successError.message);
    } else if (applied !== true) {
      console.warn(
        "[meta-sync success]",
        account.id,
        "chave desconectada ou acesso revogado durante a leitura",
      );
    }
    return { imported, connectionId: candidate.connectionId };
  }
  throw new MetaSyncPermanentError(lastError ? metaErrorMessage(lastError) : NO_CONNECTION_MESSAGE);
}

/**
 * O PostgREST corta a resposta em 1000 linhas: lê em páginas (a consulta precisa de
 * ordem estável) até a última vir incompleta.
 */
async function readAllPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  for (let from = 0; ; from += ACCESS_PAGE_SIZE) {
    const { data, error } = await page(from, from + ACCESS_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as T[];
    rows.push(...chunk);
    if (chunk.length < ACCESS_PAGE_SIZE) return rows;
  }
}

/**
 * Contas elegíveis para sincronizar: marcadas e com ao menos um acesso ativo por
 * uma conexão conectada da mesma casa. Sem `tenantId`, de todas as casas.
 */
async function loadEligibleAccounts(tenantId?: string) {
  // Em páginas; sem casa, a leitura é de todas as casas.
  const rows = await readAllPages<unknown>((from, to) => {
    let query = (supabaseAdmin as any)
      .from("meta_ad_account_access")
      .select(
        "id,account_id,tenant_id,meta_ad_accounts!inner(tenant_id,selected),meta_connections!inner(tenant_id,status)",
      )
      .eq("status", "active")
      .eq("meta_ad_accounts.selected", true)
      .eq("meta_connections.status", "connected");
    if (tenantId) {
      query = query
        .eq("tenant_id", tenantId)
        .eq("meta_ad_accounts.tenant_id", tenantId)
        .eq("meta_connections.tenant_id", tenantId);
    }
    return query.order("id", { ascending: true }).range(from, to);
  });
  const accounts = new Map<string, { id: string; tenant_id: string }>();
  for (const row of rows as Array<{
    account_id: string;
    tenant_id: string;
    meta_ad_accounts: { tenant_id: string } | { tenant_id: string }[] | null;
    meta_connections: { tenant_id: string } | { tenant_id: string }[] | null;
  }>) {
    // A conta e a conexão precisam ser da casa do acesso.
    if (embedded(row.meta_ad_accounts)?.tenant_id !== row.tenant_id) continue;
    if (embedded(row.meta_connections)?.tenant_id !== row.tenant_id) continue;
    accounts.set(row.account_id, { id: row.account_id, tenant_id: row.tenant_id });
  }
  return [...accounts.values()];
}

async function createMetaSyncRun({
  tenantId,
  days,
  triggerType,
  requestedByUserId,
}: {
  tenantId: string;
  days: number;
  triggerType: "manual" | "scheduled";
  requestedByUserId?: string | null;
}) {
  // O backfill (criado por `meta_select_accounts`) corre fora da regra "um run ativo
  // por casa": não é reaproveitado e não bloqueia o manual nem o agendado.
  const { data: active } = await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
    .eq("tenant_id", tenantId)
    .in("status", ["queued", "running"])
    .neq("trigger_type", "backfill")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) return { ...active, reused: true };

  const accounts = await loadEligibleAccounts(tenantId);
  if (!accounts.length) throw new Error("Nenhuma conta Meta selecionada para sincronizar.");

  const { data: run, error: runError } = await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .insert({
      tenant_id: tenantId,
      requested_by_user_id: requestedByUserId ?? null,
      trigger_type: triggerType,
      days,
      total_accounts: accounts.length,
      status: "queued",
    })
    .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
    .single();
  if (runError) {
    if (runError.code === "23505") {
      const { data: concurrent } = await (supabaseAdmin as any)
        .from("meta_sync_runs")
        .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
        .eq("tenant_id", tenantId)
        .in("status", ["queued", "running"])
        .neq("trigger_type", "backfill")
        .single();
      if (concurrent) return { ...concurrent, reused: true };
    }
    throw new Error(runError.message);
  }

  const { error: jobsError } = await (supabaseAdmin as any).from("meta_sync_jobs").insert(
    accounts.map((account) => ({
      run_id: run.id,
      tenant_id: tenantId,
      account_id: account.id,
      days,
    })),
  );
  if (jobsError) {
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({
        status: "failed",
        error_summary: jobsError.message,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw new Error(jobsError.message);
  }
  return { ...run, reused: false };
}

export const enqueueMetaSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => syncSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => enqueueMetaSyncFor(context, data));

export async function enqueueMetaSyncFor(
  context: MetaActionContext,
  data: z.infer<typeof syncSchema>,
) {
  const tenantId = await requireMetaAdmin(
    context.supabase,
    "Apenas administradores da casa podem sincronizar a Meta.",
  );
  await assertTenantNotDemo(tenantId);
  // Casa suspensa ou bloqueada por cobrança não sincroniza, nem pelo super admin:
  // `claim_meta_sync_jobs` nunca pega os jobs dela, e o run ficaria `queued` para
  // sempre, travando (índice `meta_sync_runs_one_active_tenant`) as próximas
  // sincronizações da casa. Sem o ator, o guard recusa tudo o que o claim recusa.
  await assertTenantCanOperate(tenantId);
  return createMetaSyncRun({
    tenantId,
    days: data.days,
    triggerType: "manual",
    requestedByUserId: context.userId,
  });
}

export const getMetaSyncRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    // Inclui os runs de backfill (`trigger_type = 'backfill'`).
    const { data, error } = await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .select(
        "id,trigger_type,days,status,total_accounts,processed_accounts,successful_accounts,failed_accounts,rows_imported,started_at,finished_at,error_summary,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

function isPermanentMetaError(message: string) {
  return /token|permiss|oauth|ads_read|outro app|não possui mais acesso|conexão antiga/i.test(
    message,
  );
}

async function refreshMetaSyncRun(runId: string) {
  const { data: jobs, error } = await (supabaseAdmin as any)
    .from("meta_sync_jobs")
    .select("status,rows_imported,last_error")
    .eq("run_id", runId);
  if (error) throw new Error(error.message);
  const completed = jobs.filter((job: { status: string }) => job.status === "completed");
  const failed = jobs.filter((job: { status: string }) => job.status === "failed");
  const processed = completed.length + failed.length;
  const pending = jobs.length - processed;
  const status =
    pending > 0
      ? "running"
      : failed.length === 0
        ? "completed"
        : completed.length > 0
          ? "partial"
          : "failed";
  const now = new Date().toISOString();
  await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .update({
      status,
      processed_accounts: processed,
      successful_accounts: completed.length,
      failed_accounts: failed.length,
      rows_imported: jobs.reduce(
        (total: number, job: { rows_imported: number }) => total + (job.rows_imported ?? 0),
        0,
      ),
      finished_at: pending === 0 ? now : null,
      error_summary:
        failed
          .map((job: { last_error?: string | null }) => job.last_error)
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ") || null,
    })
    .eq("id", runId);
}

/**
 * Recusa de `assertTenantCanOperate` (casa suspensa/cancelada ou bloqueio de
 * cobrança), diferente de uma falha de leitura do banco.
 */
function isTenantOperateBlock(error: unknown) {
  if (isBillingLockedError(error)) return true;
  return error instanceof Error && error.message === TENANT_BLOCKED_MESSAGE;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redescoberta diária (MB1-06): relê `/me/adaccounts` das chaves conectadas cuja
 * lista tem mais de 24 h e grava contas novas (não marcadas) e acessos revogados.
 * O erro numa chave é registrado e não para as outras; erro da chave (ou lista
 * vazia) põe a conexão em erro. Cada tentativa grava `permissions_checked_at`: a
 * chave tentada na última hora fica de fora, e as tentadas há mais tempo vêm antes.
 */
async function rediscoverMetaAccounts(demoTenantIds: Set<string>, overBudget: () => boolean) {
  const { data, error } = await (supabaseAdmin as any)
    .from("meta_connections")
    .select("id,tenant_id,encrypted_access_token,accounts_discovered_at,permissions_checked_at")
    .eq("status", "connected")
    .eq("auth_type", "system_user_token");
  if (error) {
    console.error("[meta-sync discover]", error.message);
    return 0;
  }
  const staleBefore = Date.now() - DISCOVERY_STALE_MS;
  const retryBefore = Date.now() - DISCOVERY_RETRY_MS;
  const olderThan = (value: string | null, limit: number) => !value || Date.parse(value) < limit;
  const stale = (
    (data ?? []) as Array<
      MetaConnectionToken & {
        id: string;
        accounts_discovered_at: string | null;
        permissions_checked_at: string | null;
      }
    >
  )
    .filter(
      (connection) =>
        !demoTenantIds.has(connection.tenant_id) &&
        olderThan(connection.accounts_discovered_at, staleBefore) &&
        olderThan(connection.permissions_checked_at, retryBefore),
    )
    // A tentativa mais antiga (ou nenhuma) primeiro; depois a lista mais antiga.
    .sort(
      (a, b) =>
        String(a.permissions_checked_at ?? "").localeCompare(
          String(b.permissions_checked_at ?? ""),
        ) ||
        String(a.accounts_discovered_at ?? "").localeCompare(
          String(b.accounts_discovered_at ?? ""),
        ),
    );

  let attempted = 0;
  let discovered = 0;
  for (const connection of stale) {
    if (attempted >= DISCOVERY_PER_TICK || overBudget()) break;
    try {
      await assertTenantCanOperate(connection.tenant_id);
    } catch (blockError) {
      if (!isTenantOperateBlock(blockError)) {
        console.error("[meta-sync discover]", connection.tenant_id, errorMessage(blockError));
      }
      continue;
    }
    attempted += 1;
    // Registra a tentativa antes de chamar a Meta: se ela falhar, a chave espera 1 h.
    await (supabaseAdmin as any)
      .from("meta_connections")
      .update({ permissions_checked_at: new Date().toISOString() })
      .eq("id", connection.id)
      .eq("tenant_id", connection.tenant_id)
      .neq("status", "disabled");
    try {
      const token = await connectionToken(connection);
      const adAccounts = await loadAllAdAccounts(token);
      if (adAccounts.length === 0) {
        // Lista vazia é um problema da chave, não um "a chave perdeu todas as contas":
        // nada é revogado (o RPC também recusa a lista vazia).
        console.error("[meta-sync discover]", connection.id, EMPTY_DISCOVERY_MESSAGE);
        await markConnectionError(connection.tenant_id, connection.id, EMPTY_DISCOVERY_MESSAGE);
        continue;
      }
      await upsertConnectionAccounts(connection.tenant_id, connection.id, adAccounts);
      discovered += 1;
    } catch (discoverError) {
      const message = metaErrorMessage(discoverError);
      console.error("[meta-sync discover]", connection.id, message);
      if (metaErrorLevel(discoverError) === "token") {
        await markConnectionError(connection.tenant_id, connection.id, message);
      }
    }
  }
  return discovered;
}

async function enqueueScheduledMetaSyncs(demoTenantIds: Set<string>) {
  let accounts: Array<{ tenant_id: string }> = [];
  try {
    accounts = await loadEligibleAccounts();
  } catch (error) {
    console.error("[meta-sync schedule]", "accounts", errorMessage(error));
  }
  // Demo tenants never get a scheduled sync (claim_meta_sync_jobs skips them too).
  const tenantIds: string[] = Array.from(
    new Set<string>(accounts.map((account) => account.tenant_id)),
  ).filter((tenantId) => !demoTenantIds.has(tenantId));
  const since = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  let enqueued = 0;
  for (const tenantId of tenantIds) {
    // Um backfill recente não substitui o agendado.
    const { data: recent } = await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .select("id")
      .eq("tenant_id", tenantId)
      .neq("trigger_type", "backfill")
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) continue;
    try {
      // Casa suspensa ou bloqueada por cobrança não ganha sincronização agendada.
      await assertTenantCanOperate(tenantId);
    } catch (error) {
      if (!isTenantOperateBlock(error)) {
        console.error("[meta-sync schedule]", tenantId, errorMessage(error));
      }
      continue;
    }
    try {
      const run = await createMetaSyncRun({ tenantId, days: 7, triggerType: "scheduled" });
      if (!run.reused) enqueued += 1;
    } catch {
      // Uma operação sem contas elegíveis não deve bloquear as demais.
    }
  }
  return enqueued;
}

type ClaimedMetaJob = {
  id: string;
  run_id: string;
  tenant_id: string;
  account_id: string;
  days: number;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
};

/**
 * Um tick do worker, nesta ordem: claim → jobs → agendamento → redescoberta. O que
 * chama a Meta respeita o orçamento `TICK_BUDGET_MS` (o cron corta o tick em 55 s):
 *
 * - um job não começado depois de 40 s volta para a fila (`queued`, sem gastar a
 *   tentativa); entre blocos de um backfill, o job também volta para a fila se o
 *   tick passou do orçamento. Como o job não guarda em que bloco parou (sem coluna
 *   para isso, e sem mudar o schema), o primeiro job do tick nunca é interrompido
 *   pelo orçamento — é ele que garante progresso: um backfill devolvido volta como
 *   primeiro do claim seguinte (ordem `next_attempt_at, created_at`) e roda inteiro;
 * - quando o primeiro job é um backfill (mais de um bloco de 30 dias), ele é o
 *   único job do tick: os demais voltam para a fila na hora;
 * - a redescoberta não começa chave nova depois de 40 s.
 *
 * `now` só existe para os testes controlarem o relógio do orçamento.
 */
export async function processMetaSyncQueue(
  limit = 2,
  { now = Date.now }: { now?: () => number } = {},
) {
  const startedAt = now();
  const overBudget = () => now() - startedAt >= TICK_BUDGET_MS;
  const demoTenantIds = new Set(await listDemoTenantIds());
  const workerId = `meta-${crypto.randomUUID()}`;
  const { data: claimedData, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_meta_sync_jobs",
    { p_limit: Math.max(1, Math.min(limit, 10)), p_worker_id: workerId },
  );
  if (claimError) throw new Error(claimError.message);
  const claimed = (claimedData ?? []) as ClaimedMetaJob[];

  // O claim já pula casa suspensa/cancelada e `frozen`/`locked_manual`; o bloqueio
  // que depende de BILLING_ENFORCEMENT_ENABLED (`locked_unpaid`,
  // `awaiting_first_payment`) só é visto aqui. Os jobs da casa bloqueada voltam
  // para a fila em 1 h sem gastar tentativa. Uma falha ao ler a casa não é
  // bloqueio: registra e processa o job normalmente.
  const tenantBlocked = new Map<string, boolean>();
  for (const tenantId of new Set<string>(claimed.map((job) => job.tenant_id))) {
    try {
      await assertTenantCanOperate(tenantId);
      tenantBlocked.set(tenantId, false);
    } catch (error) {
      const blocked = isTenantOperateBlock(error);
      if (!blocked) console.error("[meta-sync tenant]", tenantId, errorMessage(error));
      tenantBlocked.set(tenantId, blocked);
    }
  }
  const parkedJobs = claimed.filter((job) => tenantBlocked.get(job.tenant_id));
  const parkUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (const job of parkedJobs) {
    await (supabaseAdmin as any)
      .from("meta_sync_jobs")
      .update({
        status: "retry",
        next_attempt_at: parkUntil,
        attempt_count: Math.max(0, job.attempt_count - 1),
        locked_at: null,
      })
      .eq("id", job.id)
      .eq("worker_id", workerId);
  }
  for (const runId of new Set<string>(parkedJobs.map((job) => job.run_id))) {
    await refreshMetaSyncRun(runId);
  }
  const runnableJobs = claimed.filter((job) => !tenantBlocked.get(job.tenant_id));

  // Job devolvido à fila sem ter sido concluído (orçamento do tick): volta a
  // `queued` com o lock solto e sem gastar a tentativa, como o da casa bloqueada.
  // Só se este worker ainda é o dono.
  const releaseJob = async (job: ClaimedMetaJob) => {
    await (supabaseAdmin as any)
      .from("meta_sync_jobs")
      .update({
        status: "queued",
        locked_at: null,
        attempt_count: Math.max(0, job.attempt_count - 1),
      })
      .eq("id", job.id)
      .eq("worker_id", workerId);
  };

  const claimedRunIds = [...new Set(runnableJobs.map((job) => job.run_id))];
  for (const runId of claimedRunIds) {
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({ status: "running" })
      .eq("id", runId);
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({ started_at: new Date().toISOString() })
      .eq("id", runId)
      .is("started_at", null);
  }

  // O primeiro job sempre roda até o fim; os seguintes só começam dentro do
  // orçamento e são conferidos de novo entre os blocos (devolvidos se estourar).
  const adsReadCache: AdsReadCache = new Map();
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let released = 0;
  const tenantsToReconcile = new Set<string>();
  for (const [index, job] of runnableJobs.entries()) {
    const firstJob = index === 0;
    if (!firstJob && overBudget()) {
      await releaseJob(job);
      released += 1;
      continue;
    }

    // Os jobs reclamados rodam em sequência: renova o lock antes de cada um, senão um
    // job lento deixa o lock do próximo vencer (10 min) e outro worker o pega junto.
    // Sem linha renovada, outro worker já reclamou o job: ele fica com ele.
    const renewLock = async () => {
      const { data: renewed, error: renewError } = await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({ locked_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("worker_id", workerId)
        .eq("status", "running")
        .select("id");
      if (renewError) {
        console.error("[meta-sync lock]", job.id, renewError.message);
        return true;
      }
      return Boolean(renewed?.length);
    };
    if (!(await renewLock())) continue;

    // A conta precisa ser da casa do job; as chaves vêm só de acessos da mesma casa
    // (`loadAccessCandidates`), nunca de uma conexão de outra casa.
    const { data: account, error: accountError } = await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .select(
        "id,tenant_id,connection_id,meta_ad_account_id,account_id,name,currency,timezone_name,selected",
      )
      .eq("id", job.account_id)
      .eq("tenant_id", job.tenant_id)
      .eq("selected", true)
      .maybeSingle();
    let usedConnectionId: string | null = account?.connection_id ?? null;
    try {
      if (accountError) throw new Error(accountError.message);
      if (!account) throw new MetaSyncPermanentError(ACCOUNT_GONE_MESSAGE);
      await (supabaseAdmin as any).from("meta_connection_audit").insert({
        tenant_id: job.tenant_id,
        connection_id: account.connection_id,
        actor_user_id: null,
        action: "sync_started",
        metadata: { run_id: job.run_id, account_id: job.account_id, attempt: job.attempt_count },
      });
      // Entre os blocos de um backfill: renova o lock (perdido → outro worker fica com
      // o job) e confere o orçamento do tick (só para os jobs depois do primeiro).
      const outcome = await syncMetaAccount(
        job.tenant_id,
        account as MetaAccountForSync,
        job.days,
        async () => {
          if (!(await renewLock())) throw new MetaJobInterrupted("lock");
          if (!firstJob && overBudget()) throw new MetaJobInterrupted("budget");
        },
        adsReadCache,
      );
      usedConnectionId = outcome.connectionId;
      await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({
          status: "completed",
          rows_imported: outcome.imported,
          finished_at: new Date().toISOString(),
          locked_at: null,
        })
        .eq("id", job.id)
        .eq("worker_id", workerId);
      await (supabaseAdmin as any).from("meta_connection_audit").insert({
        tenant_id: job.tenant_id,
        connection_id: outcome.connectionId,
        actor_user_id: null,
        action: "sync_succeeded",
        metadata: {
          run_id: job.run_id,
          account_id: job.account_id,
          rows_imported: outcome.imported,
        },
      });
      tenantsToReconcile.add(job.tenant_id);
      completed += 1;
    } catch (error) {
      if (error instanceof MetaJobInterrupted) {
        if (error.reason === "lock") {
          // Outro worker reclamou o job: ele termina. Nada é gravado aqui.
          console.warn("[meta-sync lock]", job.id, "lock perdido entre blocos");
          continue;
        }
        // Os blocos já gravados ficam; o próximo tick recomeça do primeiro bloco
        // (cada bloco substitui a própria janela numa transação).
        await releaseJob(job);
        await (supabaseAdmin as any)
          .from("meta_ad_accounts")
          .update({ sync_status: "queued" })
          .eq("id", job.account_id)
          .eq("tenant_id", job.tenant_id);
        released += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : "Erro desconhecido ao sincronizar.";
      // Um erro da Graph API que chegou aqui já foi classificado como leitura por
      // `metaErrorLevel` (os de chave/conta trocam de chave e terminam em
      // MetaSyncPermanentError): segue a regra de nova tentativa, sem olhar o texto.
      const permanent =
        error instanceof MetaSyncPermanentError ||
        (!(error instanceof MetaApiError) && isPermanentMetaError(message));
      const canRetry = job.attempt_count < job.max_attempts && !permanent;
      // Rate limit da Meta espera mais (15, 30, 60 min); os demais, 2^n min.
      const retryDelayMs =
        error instanceof MetaApiError && isRateLimitCode(error.code)
          ? RATE_LIMIT_BACKOFF_MS * Math.pow(2, Math.max(0, job.attempt_count - 1))
          : Math.pow(2, job.attempt_count) * 60_000;
      const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
      await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({
          status: canRetry ? "retry" : "failed",
          next_attempt_at: canRetry ? retryAt : job.next_attempt_at,
          last_error: message.slice(0, 1000),
          finished_at: canRetry ? null : new Date().toISOString(),
          locked_at: null,
        })
        .eq("id", job.id)
        .eq("worker_id", workerId);
      if (account) {
        // A saúde de leitura fica na conta; a da chave e a do acesso já foram gravadas.
        await (supabaseAdmin as any)
          .from("meta_ad_accounts")
          .update({
            sync_status: canRetry ? "queued" : "error",
            last_error: message.slice(0, 1000),
          })
          .eq("id", account.id)
          .eq("tenant_id", job.tenant_id);
      }
      if (usedConnectionId) {
        await (supabaseAdmin as any).from("meta_connection_audit").insert({
          tenant_id: job.tenant_id,
          connection_id: usedConnectionId,
          actor_user_id: null,
          action: "sync_failed",
          metadata: {
            run_id: job.run_id,
            account_id: job.account_id,
            retry_scheduled: canRetry,
            attempt: job.attempt_count,
          },
        });
      }
      if (canRetry) retried += 1;
      else failed += 1;
    }
    await refreshMetaSyncRun(job.run_id);
  }

  let reconciled = 0;
  let reconciliationFailed = 0;
  for (const tenantId of tenantsToReconcile) {
    const { error } = await (supabaseAdmin as any).rpc("reconcile_meta_attributions", {
      p_tenant_id: tenantId,
    });
    if (error) {
      console.error("[meta-sync reconcile]", tenantId, error.message);
      reconciliationFailed += 1;
    } else {
      reconciled += 1;
    }
  }

  const { data: pendingReconciled, error: pendingError } = await (supabaseAdmin as any).rpc(
    "reconcile_pending_meta_attributions",
  );
  if (pendingError) console.error("[meta-sync reconcile pending]", pendingError.message);

  // Agendamento (só banco) e redescoberta (chama a Meta, dentro do orçamento) vêm
  // depois dos jobs: os jobs agendados agora são reclamados no próximo tick.
  const scheduled = await enqueueScheduledMetaSyncs(demoTenantIds);
  let discovered = 0;
  try {
    discovered = await rediscoverMetaAccounts(demoTenantIds, overBudget);
  } catch (error) {
    console.error("[meta-sync discover]", errorMessage(error));
  }

  return {
    workerId,
    discovered,
    scheduled,
    pendingReconciled: Number(pendingReconciled ?? 0),
    claimed: claimed.length,
    parked: parkedJobs.length,
    released,
    completed,
    retried,
    failed,
    reconciled,
    reconciliationFailed,
  };
}
