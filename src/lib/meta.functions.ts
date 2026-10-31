import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { brtHour } from "@/lib/home-dashboard";
import {
  MetaApiError,
  debugMetaToken,
  isMetaRateLimitCode,
  isMetaReportNotReady,
  loadMetaInsightsAsync,
  metaGet,
  metaGetAllPages,
  type MetaTokenInfo,
  type MetaUsage,
} from "@/lib/meta-graph.server";
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
const metaConnectionRenameSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
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
 * Espera depois de um rate limit da Meta (base de 15 min, dobrando). Nas 3 primeiras
 * vezes de um job (MB2-01) a espera é 15 min × 2^rate_limited_count (ou o tempo que a
 * Meta pede, se maior), limitada a 60 min, mais 0–20 % de folga aleatória, sem gastar
 * tentativa; depois, 15 min × 2^(tentativa-1) pela regra normal de tentativas. O
 * teto existe porque o job estacionado em `retry` mantém o run ativo, e run ativo
 * impede o agendado da casa: sem ele uma casa ficaria horas sem sincronizar.
 */
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** Quantas vezes um job pode voltar para a fila por rate limit sem gastar tentativa. */
const RATE_LIMIT_PARK_MAX = 3;
/** Teto da espera de cada volta por rate limit (antes da folga). */
const RATE_LIMIT_PARK_MAX_DELAY_MS = 60 * 60_000;
/** Folga aleatória máxima somada à espera do rate limit (fração da espera). */
const RATE_LIMIT_JITTER = 0.2;
/**
 * Uso da cota da Meta (`x-business-use-case-usage` e afins) a partir do qual o tick
 * termina o job em andamento e devolve os demais para a fila (MB2-01).
 */
const USAGE_RELEASE_PCT = 90;
/** Blocos com mais dias que isto são lidos pelo relatório assíncrono (MB2-07). */
const ASYNC_INSIGHTS_MIN_DAYS = 7;
/** MB2-03: a chave é conferida (`debug_token`) uma vez por dia; em erro, a cada 6 h. */
const HEALTH_STALE_MS = 24 * 60 * 60 * 1000;
const HEALTH_ERROR_STALE_MS = 6 * 60 * 60 * 1000;
/** Quantas chaves a checagem de saúde confere por tick. */
const HEALTH_PER_TICK = 10;
/** MB2-06: o agendado de 28 dias roda entre 3 h e 5 h (Brasília), uma vez por dia. */
const DAILY_SYNC_DAYS = 28;
const DAILY_SYNC_HOURS = new Set([3, 4, 5]);
const DAILY_SYNC_SPACING_MS = 20 * 60 * 60 * 1000;
/** Fora disso, um agendado de 3 dias a cada hora (55 min, para não escorregar). */
const HOURLY_SYNC_DAYS = 3;
const HOURLY_SYNC_SPACING_MS = 55 * 60_000;

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
const INVALID_TOKEN_MESSAGE = "A chave de acesso é inválida ou expirou.";
const NOT_SYSTEM_USER_MESSAGE =
  "Use a chave de um Usuário do Sistema: chaves de usuário comum expiram em até 60 dias.";
const OTHER_APP_MESSAGE = "A chave foi gerada por outro app da Meta.";
const TOKEN_REVOKED_MESSAGE = "A chave foi revogada ou expirou. Gere uma nova no Business Manager.";

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

// O cliente da Graph API (token só no cabeçalho, timeout, paginação, uso da cota e
// relatório assíncrono) é o `meta-graph.server`; o erro dele segue exportado daqui.
export { MetaApiError };

const TOKEN_ERROR_CODES = new Set([190, 102, 463, 467]);

/**
 * Nível de acesso do app (270–279, ex.: "requires Standard Access"): vale para o app
 * inteiro, mesmo vindo de uma chamada `act_…`. Nunca revoga o acesso de uma conta.
 */
function isAppAccessTierCode(code: number | null) {
  return code !== null && code >= 270 && code <= 279;
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

function accountPath(id: string) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

/** Recebe o uso da cota informado em cada resposta da Meta (MB2-01). */
type UsageSink = (usage: MetaUsage) => void;
const ignoreUsage: UsageSink = () => {};

/** Um objeto da Graph API. O token vai só no cabeçalho (`meta-graph.server`). */
async function getMeta<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
  onUsage: UsageSink = ignoreUsage,
) {
  const { data, usage } = await metaGet<T>(path, token, params);
  onUsage(usage);
  return data;
}

/** Todas as páginas de uma listagem da Graph API. */
async function getMetaPages<T>(
  path: string,
  token: string,
  params: Record<string, string>,
  onUsage: UsageSink = ignoreUsage,
) {
  const { rows, usage } = await metaGetAllPages<T>(path, token, params);
  onUsage(usage);
  return rows;
}

/** Dias corridos de uma janela `{ since, until }` (as duas pontas contam). */
function windowDays(window: { since: string; until: string }) {
  return Math.round((Date.parse(window.until) - Date.parse(window.since)) / 86_400_000) + 1;
}

/**
 * Insights da janela por anúncio e dia. Janela de até 7 dias: leitura direta. Maior
 * (blocos de backfill e o agendado de 28 dias): relatório assíncrono da Meta
 * (MB2-07), com `onPoll` renovando o lock do job a cada consulta; lock perdido
 * interrompe a leitura (`MetaJobInterrupted("lock")`).
 */
async function loadInsights(
  accessToken: string,
  adAccountId: string,
  window: { since: string; until: string },
  hooks: Pick<JobHooks, "onPoll" | "onUsage">,
) {
  const params = {
    fields: INSIGHT_FIELDS,
    level: "ad",
    time_increment: "1",
    limit: "500",
    time_range: JSON.stringify(window),
  };
  if (windowDays(window) <= ASYNC_INSIGHTS_MIN_DAYS) {
    return getMetaPages<MetaInsight>(
      `/${accountPath(adAccountId)}/insights`,
      accessToken,
      params,
      hooks.onUsage,
    );
  }
  try {
    const { rows, usage } = await loadMetaInsightsAsync<MetaInsight>(
      `/${accountPath(adAccountId)}`,
      accessToken,
      params,
      { onPoll: hooks.onPoll },
    );
    hooks.onUsage(usage);
    return rows;
  } catch (error) {
    if (error instanceof MetaApiError && error.type === "aborted") {
      throw new MetaJobInterrupted("lock");
    }
    throw error;
  }
}

async function loadActiveAds(accessToken: string, adAccountId: string, onUsage: UsageSink) {
  return getMetaPages<MetaAd>(
    `/${accountPath(adAccountId)}/ads`,
    accessToken,
    {
      fields:
        "id,name,status,effective_status,campaign{id,name,status,effective_status},adset{id,name,status,effective_status},creative{id,name,thumbnail_url,image_url,effective_object_story_id}",
      effective_status: JSON.stringify(["ACTIVE"]),
      limit: "500",
    },
    onUsage,
  );
}

async function loadAllAdAccounts(accessToken: string) {
  return getMetaPages<MetaAdAccount>("/me/adaccounts", accessToken, {
    limit: "200",
    fields: "id,account_id,name,currency,timezone_name,account_status,business{id,name}",
  });
}

function grantedPermissions(permissions: { data?: MetaPermission[] }) {
  return (permissions.data ?? [])
    .filter((item) => item.status === "granted")
    .map((item) => item.permission);
}

/** Validade e expiração da chave, como `meta_connections` guarda (MB2-03). */
function tokenInfoColumns(info: MetaTokenInfo) {
  return {
    token_type: info.type,
    token_expires_at: info.expiresAt,
    data_access_expires_at: info.dataAccessExpiresAt,
  };
}

/** A chave foi recusada pela Meta (inválida, sem ads_read, outro app...), não um erro de leitura. */
class MetaKeyRejected extends Error {}

/**
 * Validade da chave desconhecida: o `debug_token` falhou sem ser por causa da chave.
 * Tipo e expirações ficam nulos e nada é recusado por eles.
 */
const UNKNOWN_TOKEN_INFO: MetaTokenInfo = {
  isValid: true,
  type: null,
  appId: null,
  userId: null,
  expiresAt: null,
  dataAccessExpiresAt: null,
  scopes: [],
};

/**
 * O resultado de chamadas paralelas à Meta, em ordem fixa: a chave inválida no
 * `debug_token` vem antes de qualquer outra falha; depois, um erro da chave em
 * qualquer chamada; por fim, o primeiro erro de leitura. Sem falha, os valores.
 *
 * O `debug_token` autorizado pela própria chave pode ser recusado pela Meta para um
 * Usuário do Sistema que não é admin do app (ela documenta chave de app ou de
 * desenvolvedor; ex.: #100 "must provide an app access token"). Uma falha dele que
 * não é da chave (essa, timeout, instabilidade) não recusa nada: a validade fica
 * desconhecida (`UNKNOWN_TOKEN_INFO`) e as demais chamadas decidem.
 */
function settledMetaCalls<T extends unknown[]>(
  debug: PromiseSettledResult<MetaTokenInfo>,
  rest: { [K in keyof T]: PromiseSettledResult<T[K]> },
): { info: MetaTokenInfo; values: T } {
  if (debug.status === "fulfilled" && !debug.value.isValid) {
    throw new MetaKeyRejected(INVALID_TOKEN_MESSAGE);
  }
  let info: MetaTokenInfo;
  if (debug.status === "rejected" && metaErrorLevel(debug.reason) !== "token") {
    console.warn("[meta-connect debug_token]", metaErrorMessage(debug.reason));
    info = UNKNOWN_TOKEN_INFO;
  } else if (debug.status === "fulfilled") {
    info = debug.value;
  } else {
    throw new MetaKeyRejected(INVALID_TOKEN_MESSAGE);
  }
  const failures = (rest as PromiseSettledResult<unknown>[]).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  const keyFailure = failures.find((reason) => metaErrorLevel(reason) === "token");
  if (keyFailure !== undefined) throw new MetaKeyRejected(metaErrorMessage(keyFailure));
  if (failures.length > 0) throw failures[0];
  return {
    info,
    values: (rest as PromiseSettledResult<unknown>[]).map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    ) as T,
  };
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
  const [debug, ...rest] = await Promise.allSettled([
    debugMetaToken(token),
    getMeta<MetaUser>("/me", token, { fields: "id,name" }),
    getMeta<MetaApp>("/app", token, { fields: "id,name" }),
    getMeta<{ data?: MetaPermission[] }>("/me/permissions", token),
    loadAllAdAccounts(token),
  ]);
  // MB2-03: só chave válida, que não seja de usuário comum com expiração, do mesmo app
  // que `/app` devolve.
  const { info, values } = settledMetaCalls<
    [MetaUser, MetaApp, { data?: MetaPermission[] }, MetaAdAccount[]]
  >(
    debug as PromiseSettledResult<MetaTokenInfo>,
    rest as [
      PromiseSettledResult<MetaUser>,
      PromiseSettledResult<MetaApp>,
      PromiseSettledResult<{ data?: MetaPermission[] }>,
      PromiseSettledResult<MetaAdAccount[]>,
    ],
  );
  const [metaUser, metaApp, permissions, adAccounts] = values;
  // Recusa a chave de usuário comum que expira. Tipo ausente ou desconhecido, ou chave
  // sem expiração, é aceito: o `type` do `debug_token` não é documentado para o
  // Usuário do Sistema. O app só é comparado quando a Meta o informa.
  if (info.type === "USER" && info.expiresAt !== null) throw new Error(NOT_SYSTEM_USER_MESSAGE);
  if (info.appId !== null && info.appId !== metaApp.id) throw new Error(OTHER_APP_MESSAGE);
  const granted = grantedPermissions(permissions);
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
      // `token_expires_at` nulo: a chave não expira (Usuário do Sistema).
      ...tokenInfoColumns(info),
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
  let info: MetaTokenInfo;
  try {
    const [debug, ...rest] = await Promise.allSettled([
      debugMetaToken(token),
      getMeta<MetaApp>("/app", token, { fields: "id,name" }),
      getMeta<{ data?: MetaPermission[] }>("/me/permissions", token),
      loadAllAdAccounts(token),
    ]);
    const settled = settledMetaCalls<[MetaApp, { data?: MetaPermission[] }, MetaAdAccount[]]>(
      debug as PromiseSettledResult<MetaTokenInfo>,
      rest as [
        PromiseSettledResult<MetaApp>,
        PromiseSettledResult<{ data?: MetaPermission[] }>,
        PromiseSettledResult<MetaAdAccount[]>,
      ],
    );
    info = settled.info;
    const [metaApp, permissions, accounts] = settled.values;
    granted = grantedPermissions(permissions);
    if (!granted.includes("ads_read")) {
      throw new MetaKeyRejected("A permissão ads_read não está ativa.");
    }
    if (connection.app_id && connection.app_id !== metaApp.id) {
      throw new MetaKeyRejected("O token foi emitido por outro app Meta.");
    }
    // Sem filtro por BM (D1): a chave vale por todas as contas que alcança.
    if (accounts.length === 0) {
      throw new MetaKeyRejected("O token não possui mais acesso a nenhuma conta de anúncio.");
    }
    adAccounts = accounts;
  } catch (error) {
    const message =
      error instanceof Error ? metaErrorMessage(error) : "Não foi possível validar a conexão.";
    // MB2-04: só o erro da chave põe a conexão em erro. Erro de leitura (timeout,
    // rate limit, instabilidade da Meta) só devolve a mensagem; o status fica.
    if (error instanceof MetaKeyRejected) {
      const checkedAt = new Date().toISOString();
      await markConnectionError(tenantId, connection.id, message, {
        permissions_checked_at: checkedAt,
        health_checked_at: checkedAt,
      });
    }
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
      health_checked_at: checkedAt,
      ...tokenInfoColumns(info),
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

export const renameMetaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaConnectionRenameSchema.parse(input))
  .handler(async ({ data, context }) => renameMetaConnectionFor(context, data));

/**
 * Renomeia uma chave (MB3): só o rótulo que a casa vê. Sem auditoria: a constraint
 * de `meta_connection_audit.action` não tem uma ação para isso.
 */
export async function renameMetaConnectionFor(
  context: MetaActionContext,
  data: z.infer<typeof metaConnectionRenameSchema>,
) {
  const tenantId = await requireMetaAdmin(context.supabase);
  await assertTenantNotDemo(tenantId);
  // O `*For` também é chamado sem o inputValidator: o rótulo é aparado aqui.
  const { connectionId, label } = metaConnectionRenameSchema.parse(data);
  const { data: rows, error } = await (supabaseAdmin as any)
    .from("meta_connections")
    .update({ connection_label: label })
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .neq("status", "disabled")
    .select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Conexão Meta não encontrada.");
  return { ok: true as const, label };
}

export const getMetaConnectionSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getMetaConnectionSummaryFor(context));

type MetaBackfillRunRow = {
  id: string;
  status: string;
  total_accounts: number;
  processed_accounts: number;
  successful_accounts: number;
  failed_accounts: number;
  created_at: string;
  finished_at: string | null;
};

/** As chaves e as contas da casa, cada conta com as chaves que a alcançam. */
export async function getMetaConnectionSummaryFor(context: { supabase: unknown }) {
  const tenantId = await resolveTenantId(context.supabase);

  const [connectionsRes, accountsRes, accessRows, backfillRes] = await Promise.all([
    supabaseAdmin
      .from("meta_connections")
      .select(
        "id, meta_user_id, meta_user_name, scopes, token_expires_at, status, last_error, connected_at, last_sync_at, auth_type, token_hint, token_validated_at, permissions_checked_at, app_id, app_name, business_id, connection_label, accounts_discovered_at, token_type, data_access_expires_at, health_checked_at",
      )
      .eq("tenant_id", tenantId)
      .neq("status", "disabled")
      .order("connected_at", { ascending: false }),
    supabaseAdmin
      .from("meta_ad_accounts")
      .select(
        "id, connection_id, meta_ad_account_id, account_id, name, business_id, business_name, currency, timezone_name, account_status, selected, last_sync_at, sync_status, last_attempt_at, last_success_at, last_error, last_row_count, created_at",
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
    // O backfill mais recente da casa (MB3): a barra de "Primeira leitura".
    (supabaseAdmin as any)
      .from("meta_sync_runs")
      .select(
        "id, status, total_accounts, processed_accounts, successful_accounts, failed_accounts, created_at, finished_at",
      )
      .eq("tenant_id", tenantId)
      .eq("trigger_type", "backfill")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (connectionsRes.error) throw new Error(connectionsRes.error.message);
  if (accountsRes.error) throw new Error(accountsRes.error.message);
  if (backfillRes.error) throw new Error(backfillRes.error.message);

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
    latestBackfill: (backfillRes.data ?? null) as MetaBackfillRunRow | null,
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

/**
 * O que o worker passa para a leitura de um job: `beforeChunk` roda antes de cada
 * bloco depois do primeiro (renova o lock e confere o orçamento); `onPoll` roda a
 * cada consulta do relatório assíncrono (renova o lock; `false` interrompe); `onUsage`
 * recebe o uso da cota de cada resposta.
 */
type JobHooks = {
  beforeChunk: () => Promise<void>;
  onPoll: () => Promise<boolean>;
  onUsage: UsageSink;
};

/** `ads_read` de cada chave, lido no máximo uma vez por tick. */
type AdsReadCache = Map<string, Promise<boolean>>;

/** A chave ainda tem `ads_read`? Uma chamada a `/me/permissions` por chave e tick. */
function keyHasAdsRead(cache: AdsReadCache, connectionId: string, token: string) {
  let pending = cache.get(connectionId);
  if (!pending) {
    pending = getMeta<{ data?: MetaPermission[] }>("/me/permissions", token).then((permissions) =>
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
 * `hooks.beforeChunk` roda antes de cada bloco depois do primeiro e `hooks.onPoll`
 * durante o relatório assíncrono; os dois podem interromper o job
 * (`MetaJobInterrupted`).
 */
async function importMetaAccount(
  tenantId: string,
  account: MetaAccountForSync,
  days: number,
  token: string,
  hooks: JobHooks,
) {
  const now = new Date().toISOString();
  const activeAds: MetaAd[] = await loadActiveAds(token, account.meta_ad_account_id, hooks.onUsage);
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
    if (index > 0) await hooks.beforeChunk();
    const insights = await loadInsights(token, account.meta_ad_account_id, window, hooks);
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
  hooks: JobHooks,
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
      imported = await importMetaAccount(tenantId, account, days, token, hooks);
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
export async function readAllPages<T>(
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

const runJobsSchema = z.object({ runId: z.string().uuid() });

export type MetaSyncRunJob = {
  accountId: string;
  accountName: string | null;
  metaAdAccountId: string;
  status: string;
  attemptCount: number;
  rateLimitedCount: number;
  rowsImported: number;
  lastError: string | null;
  finishedAt: string | null;
};

/** Falhas primeiro; depois as que ainda podem mudar; concluídas no fim. */
const RUN_JOB_STATUS_ORDER: Record<string, number> = {
  failed: 0,
  retry: 1,
  running: 2,
  queued: 3,
  canceled: 4,
  completed: 5,
};

/** MB4-01: as contas de um run da casa, para o histórico de sincronizações. */
export const getMetaSyncRunJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => runJobsSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => getMetaSyncRunJobsFor(context, data));

export async function getMetaSyncRunJobsFor(
  context: { supabase: unknown },
  data: z.infer<typeof runJobsSchema>,
): Promise<{ jobs: MetaSyncRunJob[] }> {
  const tenantId = await resolveTenantId(context.supabase);
  const { data: run, error: runError } = await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .select("id")
    .eq("id", data.runId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (runError) throw new Error(runError.message);
  if (!run) throw new Error("Sincronização não encontrada.");

  const rows = await readAllPages<{
    account_id: string;
    status: string;
    attempt_count: number | null;
    rate_limited_count: number | null;
    rows_imported: number | null;
    last_error: string | null;
    finished_at: string | null;
    meta_ad_accounts:
      | { name: string | null; meta_ad_account_id: string }
      | { name: string | null; meta_ad_account_id: string }[]
      | null;
  }>((from, to) =>
    (supabaseAdmin as any)
      .from("meta_sync_jobs")
      .select(
        "id,account_id,status,attempt_count,rate_limited_count,rows_imported,last_error,finished_at,meta_ad_accounts(name,meta_ad_account_id)",
      )
      .eq("run_id", data.runId)
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const jobs = rows.map((row): MetaSyncRunJob => {
    const account = embedded(row.meta_ad_accounts);
    return {
      accountId: row.account_id,
      accountName: account?.name ?? null,
      metaAdAccountId: account?.meta_ad_account_id ?? "",
      status: row.status,
      attemptCount: Number(row.attempt_count ?? 0),
      rateLimitedCount: Number(row.rate_limited_count ?? 0),
      rowsImported: Number(row.rows_imported ?? 0),
      lastError: row.last_error ?? null,
      finishedAt: row.finished_at ?? null,
    };
  });
  const rank = (status: string) => RUN_JOB_STATUS_ORDER[status] ?? 9;
  jobs.sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      (a.accountName ?? a.metaAdAccountId).localeCompare(
        b.accountName ?? b.metaAdAccountId,
        "pt-BR",
      ),
  );
  return { jobs };
}

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
 * `skip`: chaves cuja lista a checagem de saúde já releu neste tick.
 */
async function rediscoverMetaAccounts(
  demoTenantIds: Set<string>,
  overBudget: () => boolean,
  skip: Set<string> = new Set(),
) {
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
        !skip.has(connection.id) &&
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
    // Registra a tentativa antes de chamar a Meta (se ela falhar, a chave espera
    // 1 h), só se ninguém a registrou desde a leitura: com dois ticks sobrepostos,
    // só um relê a chave.
    const { data: claimedRows, error: claimError } = await (supabaseAdmin as any)
      .from("meta_connections")
      .update({ permissions_checked_at: new Date().toISOString() })
      .eq("id", connection.id)
      .eq("tenant_id", connection.tenant_id)
      .neq("status", "disabled")
      .or(
        `permissions_checked_at.is.null,permissions_checked_at.lt.${new Date(retryBefore).toISOString()}`,
      )
      .select("id");
    if (claimError) {
      console.error("[meta-sync discover]", connection.id, claimError.message);
      continue;
    }
    if (!claimedRows?.length) continue;
    attempted += 1;
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

type HealthCandidate = MetaConnectionToken & {
  id: string;
  status: string;
  health_checked_at: string | null;
};

/**
 * Checagem de saúde diária das chaves (MB2-03/04), depois dos jobs e dentro do
 * orçamento do tick. Para cada chave de Usuário do Sistema não desconectada cuja
 * última checagem tem mais de 24 h (6 h se está em erro): `debug_token`. Chave
 * inválida (ou erro da chave na própria checagem) → erro. Válida → grava tipo e
 * expirações; se estava em erro, relê `/me/adaccounts` e, com contas e `ads_read`,
 * volta a `connected` e grava as contas. Erro de leitura não muda o status. Toda
 * checagem grava `health_checked_at`. Devolve as chaves cuja lista foi relida, para a
 * redescoberta não ler de novo no mesmo tick.
 */
async function checkMetaConnectionsHealth(
  demoTenantIds: Set<string>,
  overBudget: () => boolean,
  now: () => number,
) {
  const reread = new Set<string>();
  const result = { checked: 0, recovered: 0, reread };
  const { data, error } = await (supabaseAdmin as any)
    .from("meta_connections")
    .select("id,tenant_id,encrypted_access_token,status,health_checked_at")
    .neq("status", "disabled")
    .eq("auth_type", "system_user_token");
  if (error) {
    console.error("[meta-sync health]", error.message);
    return result;
  }
  const startedAt = now();
  const due = ((data ?? []) as HealthCandidate[])
    .filter((connection) => {
      if (demoTenantIds.has(connection.tenant_id)) return false;
      if (!connection.health_checked_at) return true;
      const maxAge = connection.status === "error" ? HEALTH_ERROR_STALE_MS : HEALTH_STALE_MS;
      return Date.parse(connection.health_checked_at) < startedAt - maxAge;
    })
    // Nunca checada primeiro; depois a checagem mais antiga.
    .sort((a, b) =>
      String(a.health_checked_at ?? "").localeCompare(String(b.health_checked_at ?? "")),
    );

  for (const connection of due) {
    if (result.checked >= HEALTH_PER_TICK || overBudget()) break;
    try {
      await assertTenantCanOperate(connection.tenant_id);
    } catch (blockError) {
      if (!isTenantOperateBlock(blockError)) {
        console.error("[meta-sync health]", connection.tenant_id, errorMessage(blockError));
      }
      continue;
    }
    const checkedAt = new Date(now()).toISOString();
    const updateConnection = (payload: Record<string, unknown>) =>
      (supabaseAdmin as any)
        .from("meta_connections")
        .update(payload)
        .eq("id", connection.id)
        .eq("tenant_id", connection.tenant_id)
        .neq("status", "disabled") as PromiseLike<{ error: { message: string } | null }>;

    // Registra a checagem antes de chamar a Meta, só se ninguém a registrou desde a
    // leitura: com dois ticks sobrepostos, só um confere a chave.
    const maxAge = connection.status === "error" ? HEALTH_ERROR_STALE_MS : HEALTH_STALE_MS;
    const { data: claimedRows, error: claimError } = await (supabaseAdmin as any)
      .from("meta_connections")
      .update({ health_checked_at: checkedAt })
      .eq("id", connection.id)
      .eq("tenant_id", connection.tenant_id)
      .neq("status", "disabled")
      .or(
        `health_checked_at.is.null,health_checked_at.lt.${new Date(startedAt - maxAge).toISOString()}`,
      )
      .select("id");
    if (claimError) {
      console.error("[meta-sync health]", connection.id, claimError.message);
      continue;
    }
    if (!claimedRows?.length) continue;
    result.checked += 1;

    let token: string;
    let info: MetaTokenInfo;
    try {
      token = await connectionToken(connection);
      info = await debugMetaToken(token);
    } catch (checkError) {
      if (metaErrorLevel(checkError) === "token") {
        const message =
          errorMessage(checkError) === LEGACY_CONNECTION_MESSAGE
            ? LEGACY_CONNECTION_MESSAGE
            : TOKEN_REVOKED_MESSAGE;
        await markConnectionError(connection.tenant_id, connection.id, message, {
          health_checked_at: checkedAt,
        });
      } else {
        // Erro que não é da chave (timeout, rate limit, ou a Meta recusando o
        // `debug_token` pela própria chave, ex.: #100 "must provide an app access
        // token"): validade desconhecida. O status fica e a chave não é dada como
        // saudável; a tentativa já foi registrada acima, e a chave é conferida de
        // novo no próximo ciclo.
        console.error("[meta-sync health]", connection.id, metaErrorMessage(checkError));
      }
      continue;
    }
    if (!info.isValid) {
      await markConnectionError(connection.tenant_id, connection.id, TOKEN_REVOKED_MESSAGE, {
        health_checked_at: checkedAt,
        ...tokenInfoColumns(info),
      });
      continue;
    }
    const { error: stampError } = await updateConnection({
      health_checked_at: checkedAt,
      ...tokenInfoColumns(info),
    });
    if (stampError) console.error("[meta-sync health]", connection.id, stampError.message);
    if (connection.status !== "error") continue;

    // A chave em erro voltou a valer: relê as contas e, com sucesso, volta a
    // `connected` antes de gravar a lista (o RPC só move a preferência de uma conta
    // para uma chave conectada).
    reread.add(connection.id);
    try {
      // `scopes` vazio (não informado) não recusa: a leitura das contas confere.
      if (info.scopes.length > 0 && !info.scopes.includes("ads_read")) {
        throw new MetaKeyRejected(ADS_READ_LOST_MESSAGE);
      }
      const adAccounts = await loadAllAdAccounts(token);
      if (adAccounts.length === 0) throw new MetaKeyRejected(EMPTY_DISCOVERY_MESSAGE);
      const { error: recoverError } = await updateConnection({
        status: "connected",
        last_error: null,
        permissions_checked_at: checkedAt,
      });
      if (recoverError) throw new Error(recoverError.message);
      await upsertConnectionAccounts(connection.tenant_id, connection.id, adAccounts);
      result.recovered += 1;
    } catch (recoverError) {
      const message = metaErrorMessage(recoverError);
      console.error("[meta-sync health]", connection.id, message);
      if (recoverError instanceof MetaKeyRejected || metaErrorLevel(recoverError) === "token") {
        await markConnectionError(connection.tenant_id, connection.id, message);
      }
    }
  }
  return result;
}

/** Algum run `scheduled` da casa criado desde `since` (e com ao menos `minDays`)? */
async function hasScheduledRunSince(tenantId: string, since: number, minDays?: number) {
  let query = (supabaseAdmin as any)
    .from("meta_sync_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("trigger_type", "scheduled")
    .gte("created_at", new Date(since).toISOString());
  if (minDays !== undefined) query = query.gte("days", minDays);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * Agendamento (MB2-06 / D5), por casa com contas elegíveis e sem run ativo (não
 * backfill; `createMetaSyncRun` reaproveita o ativo): entre 3 h e 5 h de Brasília,
 * se não houve run agendado de 28 dias nas últimas 20 h, um de 28 dias; senão, se não
 * houve run agendado nos últimos 55 min, um de 3 dias. O run manual não conta.
 */
async function enqueueScheduledMetaSyncs(demoTenantIds: Set<string>, now: () => number) {
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
  const at = now();
  const dailyWindow = DAILY_SYNC_HOURS.has(brtHour(new Date(at)));
  let enqueued = 0;
  for (const tenantId of tenantIds) {
    let days: number | null = null;
    try {
      const dailyDue =
        dailyWindow &&
        !(await hasScheduledRunSince(tenantId, at - DAILY_SYNC_SPACING_MS, DAILY_SYNC_DAYS));
      if (dailyDue) {
        days = DAILY_SYNC_DAYS;
      } else if (!(await hasScheduledRunSince(tenantId, at - HOURLY_SYNC_SPACING_MS))) {
        days = HOURLY_SYNC_DAYS;
      }
    } catch (error) {
      console.error("[meta-sync schedule]", tenantId, errorMessage(error));
      continue;
    }
    if (days === null) continue;
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
      const run = await createMetaSyncRun({ tenantId, days, triggerType: "scheduled" });
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
  rate_limited_count?: number | null;
};

/**
 * Um tick do worker, nesta ordem: claim → jobs → agendamento → checagem de saúde das
 * chaves → redescoberta. O que chama a Meta respeita o orçamento `TICK_BUDGET_MS`:
 *
 * - um job não começado depois de 40 s volta para a fila (`queued`, sem gastar a
 *   tentativa); entre blocos de um backfill, o job também volta para a fila se o
 *   tick passou do orçamento. Como o job não guarda em que bloco parou (sem coluna
 *   para isso, e sem mudar o schema), o primeiro job do tick nunca é interrompido
 *   pelo orçamento — é ele que garante progresso: um backfill devolvido volta como
 *   primeiro do claim seguinte (ordem `next_attempt_at, created_at`) e roda inteiro;
 * - quando o job em andamento (inclusive o primeiro) passa dos 40 s, os jobs ainda
 *   não começados voltam para a fila na hora, sem esperar ele terminar;
 * - cada renovação de lock renova todos os jobs pendentes do tick, não só o em
 *   andamento: os não começados não vencem (10 min) atrás de um job longo;
 * - se alguma resposta da Meta num job informa uso da cota de 90 % ou mais, ou o
 *   job falha por rate limit, o job termina e os seguintes voltam para a fila (sem
 *   gastar tentativa), e o tick não faz checagem de saúde nem redescoberta (MB2-01);
 * - a checagem de saúde e a redescoberta não começam chave nova depois de 40 s.
 *
 * `now` (relógio do orçamento, do agendamento e da checagem de saúde) e `random`
 * (folga do rate limit) existem para os testes.
 */
export async function processMetaSyncQueue(
  limit = 2,
  { now = Date.now, random = Math.random }: { now?: () => number; random?: () => number } = {},
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
      .eq("worker_id", workerId)
      .eq("status", "running");
  }
  for (const runId of new Set<string>(parkedJobs.map((job) => job.run_id))) {
    await refreshMetaSyncRun(runId);
  }
  const runnableJobs = claimed.filter((job) => !tenantBlocked.get(job.tenant_id));

  // Jobs deste tick ainda nas mãos do worker (o em andamento e os não começados).
  // Saem daqui ao terminar, ao voltar para a fila ou quando outro worker os pega.
  const pendingIds = new Set<string>(runnableJobs.map((job) => job.id));
  let released = 0;

  // Job devolvido à fila sem ter sido concluído (orçamento do tick, cota): volta a
  // `queued` com o lock solto e sem gastar a tentativa, como o da casa bloqueada.
  // Só se este worker ainda é o dono e o job segue em andamento.
  const releaseJob = async (job: ClaimedMetaJob) => {
    pendingIds.delete(job.id);
    released += 1;
    await (supabaseAdmin as any)
      .from("meta_sync_jobs")
      .update({
        status: "queued",
        locked_at: null,
        attempt_count: Math.max(0, job.attempt_count - 1),
      })
      .eq("id", job.id)
      .eq("worker_id", workerId)
      .eq("status", "running");
  };

  // Devolve já os jobs ainda não começados (depois de `index`): um job longo que
  // passou do orçamento não os segura até terminar.
  const releaseNotStarted = async (index: number) => {
    for (const pending of runnableJobs.slice(index + 1)) {
      if (pendingIds.has(pending.id)) await releaseJob(pending);
    }
  };

  // Os jobs reclamados rodam em sequência: renova o lock de todos os ainda pendentes
  // do tick (não só do em andamento), senão um job lento deixa o lock dos seguintes
  // vencer (10 min) e outro worker os pega gastando tentativa, ou o reaper os falha.
  // Um job sem linha renovada já é de outro worker: sai dos pendentes. Devolve se o
  // job `jobId` continua deste worker.
  const renewLocks = async (jobId: string) => {
    const ids = [...pendingIds];
    if (!ids.includes(jobId)) return false;
    const { data: renewed, error: renewError } = await (supabaseAdmin as any)
      .from("meta_sync_jobs")
      .update({ locked_at: new Date().toISOString() })
      .in("id", ids)
      .eq("worker_id", workerId)
      .eq("status", "running")
      .select("id");
    if (renewError) {
      console.error("[meta-sync lock]", jobId, renewError.message);
      return true;
    }
    const kept = new Set(((renewed ?? []) as Array<{ id: string }>).map((row) => String(row.id)));
    for (const id of ids) if (!kept.has(id)) pendingIds.delete(id);
    return kept.has(jobId);
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
  let rateLimited = 0;
  // Cota da Meta perto do limite (uso ≥ 90 % numa resposta) ou estourada (job que
  // falhou por rate limit): os jobs seguintes voltam para a fila e o tick não faz
  // checagem de saúde nem redescoberta.
  let throttled = false;
  const tenantsToReconcile = new Set<string>();
  for (const [index, job] of runnableJobs.entries()) {
    const firstJob = index === 0;
    // Já devolvido (orçamento estourado durante o job anterior) ou de outro worker.
    if (!pendingIds.has(job.id)) continue;
    if (throttled || (!firstJob && overBudget())) {
      await releaseJob(job);
      continue;
    }
    let jobUsagePct = 0;

    const renewLock = () => renewLocks(job.id);
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
      // No relatório assíncrono, cada consulta renova o lock; perdido, a leitura para.
      const outcome = await syncMetaAccount(
        job.tenant_id,
        account as MetaAccountForSync,
        job.days,
        {
          beforeChunk: async () => {
            if (!(await renewLock())) throw new MetaJobInterrupted("lock");
            if (overBudget()) {
              await releaseNotStarted(index);
              if (!firstJob) throw new MetaJobInterrupted("budget");
            }
          },
          onPoll: async () => {
            if (!(await renewLock())) return false;
            if (overBudget()) await releaseNotStarted(index);
            return true;
          },
          onUsage: (usage) => {
            jobUsagePct = Math.max(jobUsagePct, usage.maxPct);
          },
        },
        adsReadCache,
      );
      usedConnectionId = outcome.connectionId;
      pendingIds.delete(job.id);
      await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({
          status: "completed",
          rows_imported: outcome.imported,
          finished_at: new Date().toISOString(),
          locked_at: null,
        })
        .eq("id", job.id)
        .eq("worker_id", workerId)
        .eq("status", "running");
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
          pendingIds.delete(job.id);
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
        continue;
      }
      pendingIds.delete(job.id);
      const message = error instanceof Error ? error.message : "Erro desconhecido ao sincronizar.";
      const rateLimitedCount = Math.max(0, Number(job.rate_limited_count ?? 0));
      const rateLimitError = error instanceof MetaApiError && isMetaRateLimitCode(error.code);
      // Cota estourada: os jobs seguintes do tick também bateriam nela.
      if (rateLimitError) throttled = true;
      if (
        error instanceof MetaApiError &&
        (rateLimitError || isMetaReportNotReady(error)) &&
        rateLimitedCount < RATE_LIMIT_PARK_MAX
      ) {
        // MB2-01: rate limit (ou relatório assíncrono que não ficou pronto) não gasta
        // tentativa, até 3 vezes por job. Espera o que a Meta pede ou 15 min × 2^n, o
        // maior, limitado a 60 min, mais 0–20 % de folga.
        const baseDelayMs = Math.min(
          RATE_LIMIT_PARK_MAX_DELAY_MS,
          Math.max(error.retryAfterMs ?? 0, RATE_LIMIT_BACKOFF_MS * Math.pow(2, rateLimitedCount)),
        );
        const delayMs = Math.round(baseDelayMs * (1 + RATE_LIMIT_JITTER * random()));
        await (supabaseAdmin as any)
          .from("meta_sync_jobs")
          .update({
            status: "retry",
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
            attempt_count: Math.max(0, job.attempt_count - 1),
            rate_limited_count: rateLimitedCount + 1,
            last_error: message.slice(0, 1000),
            finished_at: null,
            locked_at: null,
          })
          .eq("id", job.id)
          .eq("worker_id", workerId)
          .eq("status", "running");
        if (account) {
          await (supabaseAdmin as any)
            .from("meta_ad_accounts")
            .update({ sync_status: "queued", last_error: message.slice(0, 1000) })
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
              retry_scheduled: true,
              rate_limited: rateLimitedCount + 1,
              attempt: job.attempt_count,
            },
          });
        }
        rateLimited += 1;
        retried += 1;
        if (jobUsagePct >= USAGE_RELEASE_PCT) throttled = true;
        await refreshMetaSyncRun(job.run_id);
        continue;
      }
      // Um erro da Graph API que chegou aqui já foi classificado como leitura por
      // `metaErrorLevel` (os de chave/conta trocam de chave e terminam em
      // MetaSyncPermanentError): segue a regra de nova tentativa, sem olhar o texto.
      const permanent =
        error instanceof MetaSyncPermanentError ||
        (!(error instanceof MetaApiError) && isPermanentMetaError(message));
      const canRetry = job.attempt_count < job.max_attempts && !permanent;
      // Rate limit da Meta espera mais (15, 30, 60 min); os demais, 2^n min.
      const retryDelayMs =
        error instanceof MetaApiError && isMetaRateLimitCode(error.code)
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
        .eq("worker_id", workerId)
        .eq("status", "running");
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
    if (jobUsagePct >= USAGE_RELEASE_PCT) {
      console.warn("[meta-sync usage]", job.id, `${jobUsagePct}%`);
      throttled = true;
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

  // Agendamento (só banco), checagem de saúde e redescoberta (chamam a Meta, dentro
  // do orçamento) vêm depois dos jobs: os jobs agendados agora são reclamados no
  // próximo tick. Com a cota da Meta perto do limite, as leituras de chave esperam.
  const scheduled = await enqueueScheduledMetaSyncs(demoTenantIds, now);
  let healthChecked = 0;
  let recovered = 0;
  let discovered = 0;
  if (!throttled) {
    let reread = new Set<string>();
    try {
      const health = await checkMetaConnectionsHealth(demoTenantIds, overBudget, now);
      healthChecked = health.checked;
      recovered = health.recovered;
      reread = health.reread;
    } catch (error) {
      console.error("[meta-sync health]", errorMessage(error));
    }
    try {
      discovered = await rediscoverMetaAccounts(demoTenantIds, overBudget, reread);
    } catch (error) {
      console.error("[meta-sync discover]", errorMessage(error));
    }
  }

  return {
    workerId,
    discovered,
    healthChecked,
    recovered,
    throttled,
    rateLimited,
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
