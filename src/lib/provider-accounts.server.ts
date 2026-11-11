// Contas de provedor por casa (docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md).
//
// Cada casa usa, por canal, a conta de public.tenant_channel_providers; sem
// linha, a conta padrão da plataforma. As contas padrão têm
// credentials_source='env' e são montadas aqui a partir das variáveis de
// ambiente — este é o único módulo que lê as credenciais de SMS/e-mail/voz do
// ambiente.
//
// Sem fallback: uma conta da casa desativada ou ilegível NÃO cai na conta
// padrão; o envio falha como `misconfigured` (nada é enviado).
//
// Falha ao LER as tabelas (erro de banco) não é falha da conta: o resolver usa
// o último snapshot carregado e, sem nenhum, a conta padrão.
//
// A partir de public.platform_channel_defaults, a "conta padrão" de cada
// canal é escolhível pelo super admin (docs/superpowers/specs/
// 2026-11-05-contas-padrao-canais-por-casa-design.md). Os ids
// DEFAULT_*_ACCOUNT_ID continuam exportados, mas passam a significar "conta
// env" (credentials_source='env'), não "a padrão": os usos em
// email-automations.server.ts, email-send.server.ts, tenant-domains*.server.ts
// e sms-provider-breaker.server.ts identificam a conta env e ficam como
// estão.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptProviderCredentials } from "./secret-box.server";

export type ProviderChannel = "sms" | "email" | "voice" | "webpush";

/** ids fixos das contas semeadas em 20261108100000_provider_accounts.sql e
 * 20261210100400_webpush_provider_accounts.sql. */
export const DEFAULT_SHORT_BRASIL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a001";
export const DEFAULT_INFOBIP_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a002";
export const DEFAULT_ONESIGNAL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a003";

/** As três contas env (credentials_source='env'); nunca a "padrão" agora. */
export const ENV_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_ONESIGNAL_ACCOUNT_ID,
]);

const DEFAULT_SHORT_BRASIL_SINGLE_URL = "http://lp01-short.painelsms.com/bot/single-sms.php";
const DEFAULT_SHORT_BRASIL_BULK_URL = "http://lp01-short.painelsms.com/bot/bulk-sms.php";
const DEFAULT_SHORTCODE_MESSAGES_URL = "https://api.shortcode.com.br/messages";

export type ShortBrasilAccount = {
  id: string;
  provider: "short_brasil";
  label: string;
  /** API Bearer (Short Code). Vazio = API legada usuario/chave. */
  shortcodeToken: string;
  shortcodeUrl: string;
  usuario: string;
  chave: string;
  singleUrl: string;
  bulkUrl: string;
};

export type InfobipAccount = {
  id: string;
  provider: "infobip";
  label: string;
  /** Sem barra final; vazio quando não configurado. */
  baseUrl: string;
  apiKey: string;
  /** Só dígitos; vazio quando não configurado. */
  voiceFrom: string;
  /** Remetente do SMS (número ou nome aprovado na Infobip); vazio = padrão da conta. */
  smsFrom: string;
};

export type ProviderAccount = ShortBrasilAccount | InfobipAccount;

/** Contas que enviam SMS: Short Brasil ou Infobip. */
export type SmsAccount = ShortBrasilAccount | InfobipAccount;

export type OneSignalAccount = {
  id: string;
  provider: "onesignal";
  label: string;
  /** Chave da organização (secreta). Vazia = não configurada. */
  orgApiKey: string;
  /** Opcional: várias organizações podem ser atendidas pela mesma chave. */
  orgId: string;
};

/**
 * Todas as contas de provedor, SMS/e-mail/voz (ProviderAccount) e OneSignal.
 * Só usado pelos caminhos genéricos deste módulo (listagem/admin); o código
 * de SMS/e-mail/voz continua enxergando apenas ProviderAccount — nunca
 * precisa (nem deve) tratar o caso OneSignal.
 */
export type AnyProviderAccount = ProviderAccount | OneSignalAccount;

/** A conta da casa existe mas não pode ser usada (desativada, ilegível, provedor errado). */
export class ProviderAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAccountUnavailableError";
  }
}

export function cleanCredential(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

function trimBaseUrl(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\/$/, "");
}

/** Conta padrão de SMS. Lida a cada chamada: os testes alteram o ambiente. */
export function envShortBrasilAccount(): ShortBrasilAccount {
  return {
    id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
    provider: "short_brasil",
    label: "Short Brasil (padrão)",
    shortcodeToken: cleanCredential(process.env.SHORTCODE_SMS_TOKEN),
    shortcodeUrl: process.env.SHORTCODE_SMS_URL ?? DEFAULT_SHORTCODE_MESSAGES_URL,
    usuario: cleanCredential(process.env.SHORT_BRASIL_SMS_USUARIO),
    chave: cleanCredential(process.env.SHORT_BRASIL_SMS_CHAVE),
    singleUrl: process.env.SHORT_BRASIL_SMS_SINGLE_URL ?? DEFAULT_SHORT_BRASIL_SINGLE_URL,
    bulkUrl: process.env.SHORT_BRASIL_SMS_BULK_URL ?? DEFAULT_SHORT_BRASIL_BULK_URL,
  };
}

/** Conta padrão de e-mail e voz. */
export function envInfobipAccount(): InfobipAccount {
  return {
    id: DEFAULT_INFOBIP_ACCOUNT_ID,
    provider: "infobip",
    label: "Infobip (padrão)",
    baseUrl: trimBaseUrl(process.env.INFOBIP_BASE_URL),
    apiKey: process.env.INFOBIP_API_KEY?.trim() ?? "",
    voiceFrom: process.env.INFOBIP_VOICE_FROM?.replace(/\D/g, "") ?? "",
    smsFrom: "",
  };
}

/** Conta padrão de web push (OneSignal). */
export function envOneSignalAccount(): OneSignalAccount {
  return {
    id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
    provider: "onesignal",
    label: "OneSignal (padrão)",
    orgApiKey: cleanCredential(process.env.ONESIGNAL_ORG_API_KEY),
    orgId: cleanCredential(process.env.ONESIGNAL_ORG_ID),
  };
}

/** True quando a conta OneSignal tem a chave da organização. */
export function oneSignalConfigured(account: OneSignalAccount): boolean {
  return Boolean(account.orgApiKey);
}

/** True quando a conta Short Brasil tem alguma credencial utilizável. */
export function shortBrasilConfigured(account: ShortBrasilAccount): boolean {
  return Boolean(account.shortcodeToken || (account.usuario && account.chave));
}

/** True quando a conta Infobip tem endpoint e chave. */
export function infobipConfigured(account: InfobipAccount): boolean {
  return Boolean(account.baseUrl && account.apiKey);
}

// ---------------------------------------------------------------------------
// Snapshot das tabelas (pequenas: escritas só pelo super admin).

type AccountRow = {
  id: string;
  provider: string;
  label: string;
  channels: string[] | null;
  credentials_source: string;
  credentials_encrypted: string | null;
  config: Record<string, unknown> | null;
  status: string;
};

type OverrideRow = { tenant_id: string; channel: string; provider_account_id: string };

type DefaultRow = { channel: string; provider_account_id: string };

type OptionRow = {
  tenant_id: string;
  channel: string;
  provider_account_id: string;
  display_name: string;
};

type Snapshot = {
  accounts: Map<string, AccountRow>;
  /** `${tenantId}:${channel}` -> provider_account_id */
  overrides: Map<string, string>;
  /** channel -> provider_account_id (public.platform_channel_defaults). */
  defaults: Map<ProviderChannel, string>;
  /** `${tenantId}:${channel}` -> contas extras que a casa pode escolher
   * (public.tenant_channel_account_options), em ordem de nome. */
  options: Map<string, OptionRow[]>;
  loadedAt: number;
};

export const PROVIDER_ACCOUNTS_CACHE_MS = 30_000;

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot | null> | null = null;
const decrypted = new Map<string, Promise<AnyProviderAccount>>();

/**
 * Drops this instance's snapshot (after a super admin change). Other server
 * instances pick the change up within PROVIDER_ACCOUNTS_CACHE_MS.
 */
export function invalidateProviderAccountsCache() {
  snapshot = null;
  loading = null;
  decrypted.clear();
}

export const __resetProviderAccountsCacheForTests = invalidateProviderAccountsCache;

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tabela ainda não criada (app novo antes da migração): sem opções extras. */
function isMissingRelationError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|could not find the table/i.test(error.message ?? "")
  );
}

async function loadSnapshot(): Promise<Snapshot> {
  const [accounts, overrides, defaults, options] = await Promise.all([
    db()
      .from("provider_accounts")
      .select(
        "id, provider, label, channels, credentials_source, credentials_encrypted, config, status",
      ),
    db().from("tenant_channel_providers").select("tenant_id, channel, provider_account_id"),
    db().from("platform_channel_defaults").select("channel, provider_account_id"),
    db()
      .from("tenant_channel_account_options")
      .select("tenant_id, channel, provider_account_id, display_name"),
  ]);
  if (accounts?.error) throw new Error(accounts.error.message);
  if (overrides?.error) throw new Error(overrides.error.message);
  if (defaults?.error) throw new Error(defaults.error.message);
  if (options?.error && !isMissingRelationError(options.error)) {
    throw new Error(options.error.message);
  }
  const next: Snapshot = {
    accounts: new Map(),
    overrides: new Map(),
    defaults: new Map(),
    options: new Map(),
    loadedAt: Date.now(),
  };
  for (const row of (accounts?.data ?? []) as AccountRow[]) next.accounts.set(row.id, row);
  for (const row of (overrides?.data ?? []) as OverrideRow[]) {
    next.overrides.set(`${row.tenant_id}:${row.channel}`, row.provider_account_id);
  }
  for (const row of (defaults?.data ?? []) as DefaultRow[]) {
    next.defaults.set(row.channel as ProviderChannel, row.provider_account_id);
  }
  const optionRows = options?.error ? [] : ((options?.data ?? []) as OptionRow[]);
  for (const row of [...optionRows].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "pt-BR"),
  )) {
    const key = `${row.tenant_id}:${row.channel}`;
    next.options.set(key, [...(next.options.get(key) ?? []), row]);
  }
  return next;
}

async function currentSnapshot(): Promise<Snapshot | null> {
  if (snapshot && Date.now() - snapshot.loadedAt < PROVIDER_ACCOUNTS_CACHE_MS) return snapshot;
  if (!loading) {
    loading = loadSnapshot()
      .then((next) => {
        // Conta alterada/removida: descarta a credencial decifrada em cache.
        for (const id of [...decrypted.keys()]) {
          const before = snapshot?.accounts.get(id);
          const after = next.accounts.get(id);
          if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) {
            decrypted.delete(id);
          }
        }
        snapshot = next;
        return next;
      })
      .catch((error) => {
        console.error("[provider-accounts] falha ao carregar contas; usando o último snapshot", {
          error: error instanceof Error ? error.message : String(error),
          hasSnapshot: snapshot !== null,
        });
        return snapshot;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function configString(config: Record<string, unknown> | null, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function buildDbAccount(row: AccountRow): Promise<AnyProviderAccount> {
  if (!row.credentials_encrypted) {
    throw new ProviderAccountUnavailableError(`Conta de provedor "${row.label}" sem credenciais.`);
  }
  let creds: Record<string, string>;
  try {
    creds = await decryptProviderCredentials(row.credentials_encrypted);
  } catch (error) {
    throw new ProviderAccountUnavailableError(
      `Não foi possível ler as credenciais da conta "${row.label}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const config = row.config ?? {};
  if (row.provider === "short_brasil") {
    return {
      id: row.id,
      provider: "short_brasil",
      label: row.label,
      shortcodeToken: cleanCredential(creds.shortcode_token),
      shortcodeUrl: configString(config, "shortcode_url") ?? DEFAULT_SHORTCODE_MESSAGES_URL,
      usuario: cleanCredential(creds.usuario),
      chave: cleanCredential(creds.chave),
      singleUrl: configString(config, "single_url") ?? DEFAULT_SHORT_BRASIL_SINGLE_URL,
      bulkUrl: configString(config, "bulk_url") ?? DEFAULT_SHORT_BRASIL_BULK_URL,
    };
  }
  if (row.provider === "infobip") {
    return {
      id: row.id,
      provider: "infobip",
      label: row.label,
      baseUrl: trimBaseUrl(configString(config, "base_url")),
      apiKey: creds.api_key?.trim() ?? "",
      voiceFrom: configString(config, "voice_from")?.replace(/\D/g, "") ?? "",
      smsFrom: configString(config, "sms_from") ?? "",
    };
  }
  if (row.provider === "onesignal") {
    return {
      id: row.id,
      provider: "onesignal",
      label: row.label,
      orgApiKey: cleanCredential(creds.org_api_key),
      orgId: configString(config, "org_id") ?? "",
    };
  }
  throw new ProviderAccountUnavailableError(`Provedor desconhecido: ${row.provider}`);
}

function envAccountFor(provider: string): AnyProviderAccount {
  if (provider === "short_brasil") return { ...envShortBrasilAccount() };
  if (provider === "infobip") return { ...envInfobipAccount() };
  if (provider === "onesignal") return { ...envOneSignalAccount() };
  throw new ProviderAccountUnavailableError(`Provedor desconhecido: ${provider}`);
}

function defaultAccountFor(channel: ProviderChannel): ProviderAccount {
  return channel === "sms" ? envShortBrasilAccount() : envInfobipAccount();
}

/** Conta env do canal (webpush incluso) — a padrão de hoje, sem escolha. */
function envDefaultAccountFor(channel: ProviderChannel): AnyProviderAccount {
  if (channel === "webpush") return envOneSignalAccount();
  return defaultAccountFor(channel);
}

/** Id da conta env do canal (webpush incluso). */
function envDefaultAccountId(channel: ProviderChannel): string {
  if (channel === "sms") return DEFAULT_SHORT_BRASIL_ACCOUNT_ID;
  if (channel === "webpush") return DEFAULT_ONESIGNAL_ACCOUNT_ID;
  return DEFAULT_INFOBIP_ACCOUNT_ID;
}

async function accountFromRow(
  row: AccountRow,
  channel: ProviderChannel,
): Promise<AnyProviderAccount> {
  if (row.status !== "active") {
    throw new ProviderAccountUnavailableError(`A conta de provedor "${row.label}" está desativada.`);
  }
  if (!(row.channels ?? []).includes(channel)) {
    throw new ProviderAccountUnavailableError(
      `A conta de provedor "${row.label}" não atende o canal ${channel}.`,
    );
  }
  if (row.credentials_source === "env") {
    // Uma conta 'env' extra reaproveita as credenciais do ambiente com o id dela.
    return { ...envAccountFor(row.provider), id: row.id, label: row.label };
  }
  let pending = decrypted.get(row.id);
  if (!pending) {
    pending = buildDbAccount(row);
    decrypted.set(row.id, pending);
    pending.catch(() => decrypted.delete(row.id));
  }
  return pending;
}

/**
 * A conta padrão da plataforma do canal: a escolhida pelo super admin em
 * platform_channel_defaults, ou a conta env quando não há snapshot (falha de
 * leitura sem nenhum anterior) ou não há linha para o canal (comportamento
 * de hoje). A linha aponta para uma conta que não existe mais ou está
 * desativada/fora do canal: ProviderAccountUnavailableError (sem fallback
 * para a conta env — trocar a padrão e algo dar errado deve falhar visível,
 * não voltar silenciosamente para o env).
 */
async function tenantDefaultAccount(
  snap: Snapshot | null,
  channel: ProviderChannel,
): Promise<AnyProviderAccount> {
  const accountId = snap?.defaults.get(channel);
  if (!snap || !accountId) return envDefaultAccountFor(channel);
  const row = snap.accounts.get(accountId);
  if (!row) {
    throw new ProviderAccountUnavailableError(
      `A conta padrão escolhida para o canal ${channel} não existe mais.`,
    );
  }
  return accountFromRow(row, channel);
}

/**
 * Id da conta padrão do canal (a escolhida pelo super admin, ou a conta env
 * quando não há snapshot/linha). Não resolve credenciais nem valida status —
 * só para exibir qual conta é a padrão hoje.
 */
export async function platformDefaultAccountId(channel: ProviderChannel): Promise<string> {
  const snap = await currentSnapshot();
  const accountId = snap?.defaults.get(channel);
  return snap && accountId ? accountId : envDefaultAccountId(channel);
}

/**
 * Conta que envia pelo canal para a casa. Sem casa (e-mails da plataforma),
 * a conta env (não a padrão escolhida — chamada do usuário: envios sem casa
 * continuam na conta env de hoje). Sem configuração própria da casa, a
 * padrão escolhida pelo super admin. Lança ProviderAccountUnavailableError
 * quando a conta configurada para a casa (ou a padrão escolhida) não pode
 * ser usada.
 */
export async function resolveChannelAccount(
  tenantId: string | null | undefined,
  channel: Exclude<ProviderChannel, "webpush">,
): Promise<ProviderAccount> {
  if (!tenantId) return defaultAccountFor(channel);
  const snap = await currentSnapshot();
  const overrideId = snap?.overrides.get(`${tenantId}:${channel}`);
  if (overrideId) {
    const row = snap!.accounts.get(overrideId);
    if (!row) {
      throw new ProviderAccountUnavailableError(
        `A conta de provedor configurada para a casa (${channel}) não existe mais.`,
      );
    }
    // channel is never "webpush" here: the account it resolves to is always
    // Short Brasil or Infobip (OneSignal accounts only ever serve "webpush").
    return accountFromRow(row, channel) as Promise<ProviderAccount>;
  }
  return tenantDefaultAccount(snap, channel) as Promise<ProviderAccount>;
}

/**
 * Conta que envia web push (OneSignal) da casa. Sem casa, a conta env. Sem
 * conta própria, a padrão escolhida pelo super admin. Mesma semântica de
 * resolveInfobipAccount: sem fallback — uma conta própria (ou a padrão
 * escolhida) desativada/ilegível lança ProviderAccountUnavailableError, nunca
 * cai na conta env.
 */
export async function resolveOneSignalAccount(
  tenantId: string | null | undefined,
): Promise<OneSignalAccount> {
  if (!tenantId) return envOneSignalAccount();
  const snap = await currentSnapshot();
  const overrideId = snap?.overrides.get(`${tenantId}:webpush`);
  let account: AnyProviderAccount;
  if (overrideId) {
    const row = snap!.accounts.get(overrideId);
    if (!row) {
      throw new ProviderAccountUnavailableError(
        "A conta de provedor configurada para a casa (webpush) não existe mais.",
      );
    }
    account = await accountFromRow(row, "webpush");
  } else {
    account = await tenantDefaultAccount(snap, "webpush");
  }
  if (account.provider !== "onesignal") {
    throw new ProviderAccountUnavailableError(`A conta "${account.label}" não é OneSignal.`);
  }
  return account;
}

/**
 * Conta pelo id lida direto do banco (sem cache), qualquer status ou canal:
 * usada pelo super admin para testar a conexão de uma conta.
 */
export async function loadProviderAccountForAdmin(
  accountId: string,
): Promise<AnyProviderAccount> {
  if (accountId === DEFAULT_SHORT_BRASIL_ACCOUNT_ID) return envShortBrasilAccount();
  if (accountId === DEFAULT_INFOBIP_ACCOUNT_ID) return envInfobipAccount();
  if (accountId === DEFAULT_ONESIGNAL_ACCOUNT_ID) return envOneSignalAccount();
  const { data, error } = await db()
    .from("provider_accounts")
    .select("id, provider, label, channels, credentials_source, credentials_encrypted, config, status")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as AccountRow | null;
  if (!row) throw new ProviderAccountUnavailableError("Conta de provedor não encontrada.");
  if (row.credentials_source === "env") {
    return { ...envAccountFor(row.provider), id: row.id, label: row.label };
  }
  return buildDbAccount(row);
}

/**
 * Conta OneSignal pelo id (ex.: a conta gravada em tenant_webpush_apps.
 * provider_account_id de um app específico). null/id padrão = conta padrão
 * da plataforma.
 */
export async function oneSignalAccountById(
  accountId: string | null | undefined,
): Promise<OneSignalAccount> {
  if (!accountId || accountId === DEFAULT_ONESIGNAL_ACCOUNT_ID) return envOneSignalAccount();
  const snap = await currentSnapshot();
  const row = snap?.accounts.get(accountId);
  if (!row) {
    throw new ProviderAccountUnavailableError(`A conta de provedor ${accountId} não existe mais.`);
  }
  const account = await accountFromRow(row, "webpush");
  if (account.provider !== "onesignal") {
    throw new ProviderAccountUnavailableError(`A conta "${account.label}" não é OneSignal.`);
  }
  return account;
}

/**
 * Conta Infobip pelo id (ex.: a conta onde um domínio de e-mail foi
 * cadastrado). null/id padrão = conta padrão da plataforma.
 */
export async function infobipAccountById(
  accountId: string | null | undefined,
  channel: "email" | "voice",
): Promise<InfobipAccount> {
  if (!accountId || accountId === DEFAULT_INFOBIP_ACCOUNT_ID) return envInfobipAccount();
  const snap = await currentSnapshot();
  const row = snap?.accounts.get(accountId);
  if (!row) {
    throw new ProviderAccountUnavailableError(`A conta de provedor ${accountId} não existe mais.`);
  }
  const account = await accountFromRow(row, channel);
  if (account.provider !== "infobip") {
    throw new ProviderAccountUnavailableError(`A conta "${account.label}" não é Infobip.`);
  }
  return account;
}

/**
 * O canal da casa tem uma conta utilizável e configurada (status exibido à
 * casa; nunca expõe nome de fornecedor). Conta indisponível = false.
 */
export async function channelConfiguredFor(
  tenantId: string | null | undefined,
  channel: Exclude<ProviderChannel, "webpush">,
): Promise<boolean> {
  try {
    const account = await resolveChannelAccount(tenantId, channel);
    return account.provider === "short_brasil"
      ? channel === "sms" && shortBrasilConfigured(account)
      : infobipConfigured(account);
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return false;
    throw error;
  }
}

/** Mensagem (vista pela casa) quando a conta escolhida não pode mais ser usada. */
export const SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE =
  "A conta de envio escolhida não está mais disponível para a casa.";

/** Nome da opção "padrão da casa" na escolha da conta de envio. */
export const SMS_DEFAULT_CHOICE_NAME = "Padrão da casa";

/** Nome mostrado para uma campanha cuja conta escolhida deixou de ser opção da casa. */
export const SMS_REMOVED_CHOICE_NAME = "Conta removida";

/** Id da conta que a padrão da casa resolve hoje (override ou padrão da plataforma). */
function houseDefaultAccountId(snap: Snapshot, tenantId: string, channel: ProviderChannel): string {
  return (
    snap.overrides.get(`${tenantId}:${channel}`) ??
    snap.defaults.get(channel) ??
    envDefaultAccountId(channel)
  );
}

/**
 * Conta de SMS da casa (Short Brasil ou Infobip). `accountId` vazio = a
 * padrão da casa (comportamento de sempre). Com `accountId` (conta escolhida
 * na campanha), a conta precisa ser uma das opções da casa para SMS
 * (tenant_channel_account_options) ou exatamente a conta que a padrão da
 * casa resolve hoje; senão ProviderAccountUnavailableError com
 * SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE — sem fallback para a padrão. A
 * mensagem nunca traz o label interno nem o fornecedor (a casa a vê no
 * last_error da campanha). Sem snapshot nenhum (falha ao ler as tabelas e
 * nada carregado antes) não dá para conferir a escolha: erro comum (não é
 * falha da conta), o envio é tentado de novo depois.
 */
export async function resolveSmsAccount(
  tenantId: string | null | undefined,
  accountId?: string | null,
): Promise<SmsAccount> {
  if (!accountId) return resolveChannelAccount(tenantId, "sms");
  if (!tenantId) throw new ProviderAccountUnavailableError(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
  const snap = await currentSnapshot();
  if (!snap) throw new Error("Não foi possível carregar as contas de envio. Tente de novo.");
  if (accountId === houseDefaultAccountId(snap, tenantId, "sms")) {
    return resolveChannelAccount(tenantId, "sms");
  }
  const isOption = (snap.options.get(`${tenantId}:sms`) ?? []).some(
    (option) => option.provider_account_id === accountId,
  );
  const row = isOption ? snap.accounts.get(accountId) : undefined;
  if (!row) throw new ProviderAccountUnavailableError(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
  try {
    // channel "sms": the account is always Short Brasil or Infobip.
    return (await accountFromRow(row, "sms")) as SmsAccount;
  } catch (error) {
    if (!(error instanceof ProviderAccountUnavailableError)) throw error;
    console.error("[provider-accounts] conta de envio escolhida indisponível", {
      tenantId,
      accountId,
      error: error.message,
    });
    throw new ProviderAccountUnavailableError(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
  }
}

function smsAccountConfigured(account: SmsAccount): boolean {
  return account.provider === "short_brasil"
    ? shortBrasilConfigured(account)
    : infobipConfigured(account);
}

export type SmsSendChoice = { id: string | null; name: string; available: boolean };

/**
 * Contas pelas quais a casa pode enviar uma campanha de SMS: primeiro a
 * "Padrão da casa" (id null; nunca bloqueada aqui — é o envio de sempre),
 * depois as opções vinculadas pelo super admin, em ordem de nome. available =
 * conta ativa, atendendo SMS e com credenciais. Só o nome definido no vínculo
 * sai daqui: nunca o label interno nem o fornecedor.
 */
export async function listSmsSendChoices(
  tenantId: string | null | undefined,
): Promise<SmsSendChoice[]> {
  const choices: SmsSendChoice[] = [{ id: null, name: SMS_DEFAULT_CHOICE_NAME, available: true }];
  if (!tenantId) return choices;
  const snap = await currentSnapshot();
  for (const option of snap?.options.get(`${tenantId}:sms`) ?? []) {
    const row = snap!.accounts.get(option.provider_account_id);
    let available = false;
    if (row) {
      try {
        available = smsAccountConfigured((await accountFromRow(row, "sms")) as SmsAccount);
      } catch (error) {
        if (!(error instanceof ProviderAccountUnavailableError)) throw error;
      }
    }
    choices.push({ id: option.provider_account_id, name: option.display_name, available });
  }
  return choices;
}

/**
 * Motivo (para a casa) de a conta escolhida não poder enviar agora, ou null
 * quando pode. accountId vazio (padrão da casa) = sempre null: a padrão
 * segue o caminho de sempre.
 */
export async function smsSendChoiceProblem(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
): Promise<string | null> {
  if (!accountId) return null;
  try {
    const account = await resolveSmsAccount(tenantId, accountId);
    return smsAccountConfigured(account) ? null : SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE;
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return error.message;
    throw error;
  }
}

/**
 * Validação ao criar uma campanha (ou envio de teste) com conta escolhida:
 * a opção existe para a casa e está disponível. null/vazio = padrão da casa.
 */
export async function assertSmsSendChoice(
  tenantId: string,
  accountId: string | null | undefined,
): Promise<void> {
  if (!accountId) return;
  const choice = (await listSmsSendChoices(tenantId)).find((c) => c.id === accountId);
  if (!choice) {
    throw new Error(
      "A conta de envio escolhida não existe para esta casa. Atualize a página e escolha de novo.",
    );
  }
  if (!choice.available || (await smsSendChoiceProblem(tenantId, accountId))) {
    throw new Error(
      `A conta de envio "${choice.name}" está indisponível no momento. Escolha outra ou use a padrão da casa.`,
    );
  }
}

/**
 * Nome visto pela casa da conta gravada numa campanha: "Padrão da casa"
 * (null), o nome da opção, ou "Conta removida" quando a opção não existe
 * mais.
 */
export async function smsSendChoiceNames(
  tenantId: string,
): Promise<(accountId: string | null | undefined) => string> {
  const snap = await currentSnapshot();
  const names = new Map(
    (snap?.options.get(`${tenantId}:sms`) ?? []).map((o) => [o.provider_account_id, o.display_name]),
  );
  return (accountId) =>
    !accountId ? SMS_DEFAULT_CHOICE_NAME : (names.get(accountId) ?? SMS_REMOVED_CHOICE_NAME);
}

/** Conta Infobip de e-mail ou voz da casa. */
export async function resolveInfobipAccount(
  tenantId: string | null | undefined,
  channel: "email" | "voice",
): Promise<InfobipAccount> {
  const account = await resolveChannelAccount(tenantId, channel);
  if (account.provider !== "infobip") {
    throw new ProviderAccountUnavailableError(
      `A conta "${account.label}" (${account.provider}) não atende ${channel}.`,
    );
  }
  return account;
}
