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

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptProviderCredentials } from "./secret-box.server";

export type ProviderChannel = "sms" | "email" | "voice";

/** ids fixos das contas semeadas em 20261108100000_provider_accounts.sql. */
export const DEFAULT_SHORT_BRASIL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a001";
export const DEFAULT_INFOBIP_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a002";

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
};

export type ProviderAccount = ShortBrasilAccount | InfobipAccount;

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
  };
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

type Snapshot = {
  accounts: Map<string, AccountRow>;
  /** `${tenantId}:${channel}` -> provider_account_id */
  overrides: Map<string, string>;
  loadedAt: number;
};

export const PROVIDER_ACCOUNTS_CACHE_MS = 30_000;

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot | null> | null = null;
const decrypted = new Map<string, Promise<ProviderAccount>>();

export function __resetProviderAccountsCacheForTests() {
  snapshot = null;
  loading = null;
  decrypted.clear();
}

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function loadSnapshot(): Promise<Snapshot> {
  const [accounts, overrides] = await Promise.all([
    db()
      .from("provider_accounts")
      .select(
        "id, provider, label, channels, credentials_source, credentials_encrypted, config, status",
      ),
    db().from("tenant_channel_providers").select("tenant_id, channel, provider_account_id"),
  ]);
  if (accounts?.error) throw new Error(accounts.error.message);
  if (overrides?.error) throw new Error(overrides.error.message);
  const next: Snapshot = { accounts: new Map(), overrides: new Map(), loadedAt: Date.now() };
  for (const row of (accounts?.data ?? []) as AccountRow[]) next.accounts.set(row.id, row);
  for (const row of (overrides?.data ?? []) as OverrideRow[]) {
    next.overrides.set(`${row.tenant_id}:${row.channel}`, row.provider_account_id);
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

async function buildDbAccount(row: AccountRow): Promise<ProviderAccount> {
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
    };
  }
  throw new ProviderAccountUnavailableError(`Provedor desconhecido: ${row.provider}`);
}

function envAccountFor(provider: string): ProviderAccount {
  if (provider === "short_brasil") return { ...envShortBrasilAccount() };
  if (provider === "infobip") return { ...envInfobipAccount() };
  throw new ProviderAccountUnavailableError(`Provedor desconhecido: ${provider}`);
}

function defaultAccountFor(channel: ProviderChannel): ProviderAccount {
  return channel === "sms" ? envShortBrasilAccount() : envInfobipAccount();
}

async function accountFromRow(row: AccountRow, channel: ProviderChannel): Promise<ProviderAccount> {
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
 * Conta que envia pelo canal para a casa. Sem casa (e-mails da plataforma) ou
 * sem configuração, a conta padrão. Lança ProviderAccountUnavailableError
 * quando a conta configurada para a casa não pode ser usada.
 */
export async function resolveChannelAccount(
  tenantId: string | null | undefined,
  channel: ProviderChannel,
): Promise<ProviderAccount> {
  if (!tenantId) return defaultAccountFor(channel);
  const snap = await currentSnapshot();
  const accountId = snap?.overrides.get(`${tenantId}:${channel}`);
  if (!snap || !accountId) return defaultAccountFor(channel);
  const row = snap.accounts.get(accountId);
  if (!row) {
    throw new ProviderAccountUnavailableError(
      `A conta de provedor configurada para a casa (${channel}) não existe mais.`,
    );
  }
  return accountFromRow(row, channel);
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
  channel: ProviderChannel,
): Promise<boolean> {
  try {
    const account = await resolveChannelAccount(tenantId, channel);
    return account.provider === "short_brasil"
      ? channel === "sms" && shortBrasilConfigured(account)
      : channel !== "sms" && infobipConfigured(account);
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return false;
    throw error;
  }
}

/** Conta de SMS da casa. Hoje só Short Brasil envia SMS. */
export async function resolveSmsAccount(
  tenantId: string | null | undefined,
): Promise<ShortBrasilAccount> {
  const account = await resolveChannelAccount(tenantId, "sms");
  if (account.provider !== "short_brasil") {
    throw new ProviderAccountUnavailableError(
      `SMS pela conta "${account.label}" (${account.provider}) ainda não é suportado.`,
    );
  }
  return account;
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
