// Super admin management of provider accounts and of each house's account per
// channel (docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md, Fase 3). Bodies of
// the server functions in provider-accounts.functions.ts, exported so their
// guards are unit-testable. Credentials are write-only: they are encrypted on
// save and only masked hints ever leave the server.

import type { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";
import {
  cleanCredential,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_ONESIGNAL_ACCOUNT_ID,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  ENV_ACCOUNT_IDS,
  envInfobipAccount,
  envOneSignalAccount,
  envShortBrasilAccount,
  infobipConfigured,
  invalidateProviderAccountsCache,
  loadProviderAccountForAdmin,
  oneSignalConfigured,
  shortBrasilConfigured,
  type ProviderChannel,
} from "@/lib/provider-accounts.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "@/lib/secret-box.server";
import { requireBrazilianPhone } from "@/lib/phone-normalization";
import {
  assertInfobipBaseUrl,
  assertShortBrasilUrl,
  PROVIDER_TEST_FAILURE_MESSAGE,
  providerFetch,
} from "@/lib/provider-url-policy.server";
import {
  deleteProviderAccountInput,
  PROVIDER_CHANNEL_LABEL,
  PROVIDER_CHANNELS,
  PROVIDER_LABEL,
  saveProviderAccountInput,
  setPlatformDefaultInput,
  setProviderAccountStatusInput,
  setTenantChannelProviderInput,
  SUPPORTED_CHANNELS,
  testProviderAccountInput,
} from "@/lib/provider-accounts.shared";
import { DEFAULT_ENABLED_CHANNELS } from "@/lib/tenant-channels.shared";

type AdminContext = { userId: string };

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Os 4 canais, na mesma ordem usada nas telas. */
const CHANNELS: ProviderChannel[] = [...PROVIDER_CHANNELS];

/** Conta env de cada canal — padrão de hoje quando não há linha em
 * platform_channel_defaults (mesmo fallback de provider-accounts.server). */
const ENV_DEFAULT_ACCOUNT_ID: Record<ProviderChannel, string> = {
  sms: DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  email: DEFAULT_INFOBIP_ACCOUNT_ID,
  voice: DEFAULT_INFOBIP_ACCOUNT_ID,
  webpush: DEFAULT_ONESIGNAL_ACCOUNT_ID,
};

/** A padrão de cada canal hoje: a escolhida em platform_channel_defaults, ou
 * a conta env quando não há linha. */
async function currentDefaults(): Promise<Record<ProviderChannel, string>> {
  const { data, error } = await db()
    .from("platform_channel_defaults")
    .select("channel, provider_account_id");
  if (error) throw new Error(error.message);
  const defaults = { ...ENV_DEFAULT_ACCOUNT_ID };
  for (const row of (data ?? []) as Array<{ channel: ProviderChannel; provider_account_id: string }>) {
    defaults[row.channel] = row.provider_account_id;
  }
  return defaults;
}

/** Canais dos quais `accountId` é hoje a padrão. */
async function channelsDefaultedTo(accountId: string): Promise<ProviderChannel[]> {
  const defaults = await currentDefaults();
  return CHANNELS.filter((channel) => defaults[channel] === accountId);
}

/** Nenhuma casa pode usar `accountId` nos canais que estão saindo da conta, e
 * a conta não pode ser hoje a padrão de nenhum desses canais (senão toda
 * casa sem override naquele canal ficaria sem conta). */
async function assertNoHouseUsesRemovedChannels(
  accountId: string,
  removedChannels: ProviderChannel[],
) {
  if (!removedChannels.length) return;
  const defaultedRemoved = (await channelsDefaultedTo(accountId)).filter((c) =>
    removedChannels.includes(c),
  );
  if (defaultedRemoved.length) {
    throw new Error(
      `Esta conta é a padrão de ${PROVIDER_CHANNEL_LABEL[defaultedRemoved[0]]}. Escolha outra padrão antes.`,
    );
  }
  const { data: inUse, error } = await db()
    .from("tenant_channel_providers")
    .select("tenant_id, channel")
    .eq("provider_account_id", accountId)
    .in("channel", removedChannels);
  if (error) throw new Error(error.message);
  if ((inUse ?? []).length) {
    throw new Error("Há casas usando esta conta nos canais removidos. Mude essas casas de conta antes.");
  }
}

/** Move os domínios de e-mail (ativos) das casas dadas para a conta corrente
 * de cada um (mesma conta Infobip que a casa tem hoje) — usado ao trocar a
 * conta de uma casa e ao trocar a padrão de e-mail (nesse caso, as casas sem
 * conta própria). */
export async function moveEmailDomains(
  tenantIds: string[],
  opts: { skipOnAccountId?: string } = {},
): Promise<Array<{ tenantId: string; hostname: string; status: string; error: string | null }>> {
  if (!tenantIds.length) return [];
  const { data: domains, error: domainsError } = await db()
    .from("tenant_domains")
    .select("id, tenant_id, hostname, provider_account_id")
    .in("tenant_id", tenantIds)
    .eq("kind", "email")
    .is("removed_at", null);
  if (domainsError) throw new Error(domainsError.message);
  const { refreshTenantDomain } = await import("@/lib/tenant-domains.server");
  const results: Array<{ tenantId: string; hostname: string; status: string; error: string | null }> =
    [];
  const pending = (
    (domains ?? []) as Array<{
      id: string;
      tenant_id: string;
      hostname: string;
      provider_account_id: string | null;
    }>
  ).filter(
    // Resume mode: a domain already registered on the target account
    // (no account stored = the env Infobip account, as refreshTenantDomain
    // reads it) has nothing left to move.
    (domain) =>
      !opts.skipOnAccountId ||
      (domain.provider_account_id ?? DEFAULT_INFOBIP_ACCOUNT_ID) !== opts.skipOnAccountId,
  );
  for (const domain of pending) {
    try {
      const refreshed = await refreshTenantDomain(domain.id, { requestVerify: true });
      results.push({
        tenantId: domain.tenant_id,
        hostname: refreshed.hostname,
        status: refreshed.status,
        error: refreshed.last_error,
      });
    } catch (error) {
      results.push({
        tenantId: domain.tenant_id,
        hostname: domain.hostname,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Credential fields per provider (the only keys ever stored). */
const CREDENTIAL_KEYS = {
  short_brasil: ["shortcode_token", "usuario", "chave"],
  infobip: ["api_key"],
  onesignal: ["org_api_key"],
} as const;

/** Non-secret config fields per provider. */
const CONFIG_KEYS = {
  short_brasil: ["shortcode_url", "single_url", "bulk_url"],
  infobip: ["base_url", "voice_from", "sms_from"],
  onesignal: ["org_id"],
} as const;

export type AccountProvider = keyof typeof CREDENTIAL_KEYS;

/**
 * Validação e cifragem de uma conta de provedor gravada no banco, comum ao
 * super admin (contas da plataforma) e à casa (conta própria): só as chaves
 * conhecidas do provedor, URLs no allowlist, número de voz em dígitos, e as
 * credenciais — campo em branco mantém o valor de `stored` — cifradas.
 * `credentialKeys`: nomes das credenciais gravadas (nunca os valores).
 */
export async function buildAccountPayload(
  provider: AccountProvider,
  channels: readonly ProviderChannel[],
  rawConfig: Partial<Record<string, string | undefined>>,
  rawCredentials: Partial<Record<string, string | undefined>>,
  stored: Record<string, string>,
): Promise<{ config: Record<string, string>; credentialsEncrypted: string; credentialKeys: string[] }> {
  const config: Record<string, string> = {};
  for (const key of CONFIG_KEYS[provider]) {
    const value = rawConfig[key];
    if (value) config[key] = value;
  }
  if (provider === "infobip") {
    if (!config.base_url) throw new Error("Informe a URL base da conta Infobip.");
    config.base_url = assertInfobipBaseUrl(config.base_url);
    if (channels.includes("voice")) {
      const digits = (config.voice_from ?? "").replace(/\D/g, "");
      if (digits.length < 10) throw new Error("Informe o número de origem das ligações (voz).");
      config.voice_from = digits;
    }
  } else if (provider === "short_brasil") {
    if (config.shortcode_url) config.shortcode_url = assertShortBrasilUrl("shortcode_url", config.shortcode_url);
    if (config.single_url) config.single_url = assertShortBrasilUrl("single_url", config.single_url);
    if (config.bulk_url) config.bulk_url = assertShortBrasilUrl("bulk_url", config.bulk_url);
  }
  // onesignal: org_id is a plain identifier, not a URL — nothing to validate.

  const credentials: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS[provider]) {
    const value = cleanCredential(rawCredentials[key] ?? stored[key]);
    if (value) credentials[key] = value;
  }
  const hasCredentials =
    provider === "short_brasil"
      ? Boolean(credentials.shortcode_token || (credentials.usuario && credentials.chave))
      : provider === "infobip"
        ? Boolean(credentials.api_key)
        : Boolean(credentials.org_api_key);
  if (!hasCredentials) {
    throw new Error(
      provider === "short_brasil"
        ? "Informe o token da API Short Code ou o usuário e a chave da API legada."
        : provider === "infobip"
          ? "Informe a API key da conta Infobip."
          : "Informe a chave da organização OneSignal.",
    );
  }
  return {
    config,
    credentialsEncrypted: await encryptProviderCredentials(credentials),
    credentialKeys: Object.keys(credentials),
  };
}

/** Mensagem de toda função do super admin que mexeria numa conta com dono. */
export const OWNED_ACCOUNT_ADMIN_MESSAGE = "Conta da casa: só o admin da casa altera.";

type AccountRow = {
  id: string;
  provider: "short_brasil" | "infobip" | "onesignal";
  label: string;
  channels: ProviderChannel[];
  credentials_source: "env" | "db";
  credentials_encrypted: string | null;
  config: Record<string, unknown> | null;
  status: "active" | "disabled";
  owner_tenant_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** tenant_audit_logs da casa dona de uma conta (nunca credenciais). Falha só loga. */
export async function auditOwnProviderAction(args: {
  tenantId: string;
  actorUserId: string;
  action: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db()
    .from("tenant_audit_logs")
    .insert({
      tenant_id: args.tenantId,
      actor_user_id: args.actorUserId,
      action: args.action,
      entity_type: "own_provider",
      entity_id: args.entityId,
      before_data: args.before ?? null,
      after_data: args.after ?? null,
      metadata: args.metadata ?? {},
    });
  if (error) console.error("[own-provider] failed writing tenant audit log", error.message);
}

export type ProviderAccountView = {
  id: string;
  provider: "short_brasil" | "infobip" | "onesignal";
  label: string;
  channels: ProviderChannel[];
  status: "active" | "disabled";
  /** Conta com credentials_source='env': credenciais do ambiente, editável só no nome e nos canais. */
  envAccount: boolean;
  /** Casa dona da conta (conta própria); null = conta da plataforma. */
  ownerTenantId: string | null;
  /** Canais dos quais esta conta é hoje a padrão escolhida. */
  defaultFor: ProviderChannel[];
  configured: boolean;
  config: Record<string, string>;
  /** Masked last characters of each stored credential ("••••abcd"); sempre
   * vazio em conta com dono (nem dica mascarada sai dessas contas). */
  credentialHints: Record<string, string>;
  /** Houses on this account, per channel (inclui, nos canais de defaultFor,
   * as casas sem conta própria no canal e com o canal ligado). */
  houses: Record<ProviderChannel, number>;
};

export type TenantProvidersView = {
  id: string;
  nome: string;
  /** null = the platform account. */
  accounts: Record<ProviderChannel, string | null>;
  /** Canais ligados para a casa (padrão quando não há linha em tenant_channels). */
  channels: Record<ProviderChannel, boolean>;
};

function hint(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function stringConfig(config: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

async function accountView(
  row: AccountRow,
  houses: Record<ProviderChannel, number>,
  defaultFor: ProviderChannel[],
): Promise<ProviderAccountView> {
  const envAccount = ENV_ACCOUNT_IDS.has(row.id);
  let credentialHints: Record<string, string> = {};
  let configured = false;
  if (row.credentials_source === "env") {
    if (row.provider === "short_brasil") {
      const env = envShortBrasilAccount();
      configured = shortBrasilConfigured(env);
      credentialHints = Object.fromEntries(
        (
          [
            ["shortcode_token", env.shortcodeToken],
            ["usuario", env.usuario],
            ["chave", env.chave],
          ] as const
        )
          .filter(([, v]) => v)
          .map(([k, v]) => [k, hint(v)]),
      );
    } else if (row.provider === "infobip") {
      const env = envInfobipAccount();
      configured = infobipConfigured(env);
      if (env.apiKey) credentialHints = { api_key: hint(env.apiKey) };
    } else {
      const env = envOneSignalAccount();
      configured = oneSignalConfigured(env);
      if (env.orgApiKey) credentialHints = { org_api_key: hint(env.orgApiKey) };
    }
  } else if (row.credentials_encrypted) {
    try {
      const creds = await decryptProviderCredentials(row.credentials_encrypted);
      credentialHints = Object.fromEntries(
        Object.entries(creds)
          .filter(([, v]) => v)
          .map(([k, v]) => [k, hint(v)]),
      );
      const config = stringConfig(row.config);
      configured =
        row.provider === "short_brasil"
          ? Boolean(creds.shortcode_token || (creds.usuario && creds.chave))
          : row.provider === "infobip"
            ? Boolean(creds.api_key && config.base_url)
            : Boolean(creds.org_api_key);
    } catch {
      configured = false;
    }
  }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    channels: row.channels ?? [],
    status: row.status,
    envAccount,
    ownerTenantId: row.owner_tenant_id ?? null,
    defaultFor,
    configured,
    config: envAccount ? {} : stringConfig(row.config),
    credentialHints: row.owner_tenant_id ? {} : credentialHints,
    houses,
  };
}

// ---------------------------------------------------------------------------
// Listing

export async function adminListProviderAccountsFor(context: AdminContext) {
  await assertSuperAdmin(context.userId);
  const [accounts, assignments, tenants, tenantChannels, verifiedEmailDomains, defaults] =
    await Promise.all([
      db()
        .from("provider_accounts")
        .select(
          "id, provider, label, channels, credentials_source, credentials_encrypted, config, status, owner_tenant_id, created_at",
        )
        .order("created_at", { ascending: true }),
      db().from("tenant_channel_providers").select("tenant_id, channel, provider_account_id"),
      db().from("tenants").select("id, nome").order("nome"),
      db().from("tenant_channels").select("tenant_id, channel, enabled"),
      db()
        .from("tenant_domains")
        .select("tenant_id")
        .eq("kind", "email")
        .eq("status", "verified")
        .is("removed_at", null),
      currentDefaults(),
    ]);
  for (const result of [accounts, assignments, tenants, tenantChannels, verifiedEmailDomains]) {
    if (result.error) throw new Error(result.error.message);
  }
  const rows = (accounts.data ?? []) as AccountRow[];
  const links = (assignments.data ?? []) as Array<{
    tenant_id: string;
    channel: ProviderChannel;
    provider_account_id: string;
  }>;
  const tenantRows = (tenants.data ?? []) as Array<{ id: string; nome: string }>;

  const byTenant = new Map<string, Record<ProviderChannel, string | null>>();
  for (const link of links) {
    const current =
      byTenant.get(link.tenant_id) ?? { sms: null, email: null, voice: null, webpush: null };
    current[link.channel] = link.provider_account_id;
    byTenant.set(link.tenant_id, current);
  }

  const channelEnabled = new Map<string, boolean>();
  for (const row of (tenantChannels.data ?? []) as Array<{
    tenant_id: string;
    channel: ProviderChannel;
    enabled: boolean;
  }>) {
    channelEnabled.set(`${row.tenant_id}:${row.channel}`, row.enabled);
  }
  const channelsOf = (tenantId: string): Record<ProviderChannel, boolean> => {
    const out = {} as Record<ProviderChannel, boolean>;
    for (const channel of CHANNELS) {
      out[channel] = channelEnabled.get(`${tenantId}:${channel}`) ?? DEFAULT_ENABLED_CHANNELS[channel];
    }
    return out;
  };

  const housesOf = (accountId: string, defaultFor: ProviderChannel[]) => {
    const counts = { sms: 0, email: 0, voice: 0, webpush: 0 } as Record<ProviderChannel, number>;
    for (const link of links) if (link.provider_account_id === accountId) counts[link.channel]++;
    for (const channel of defaultFor) {
      for (const tenant of tenantRows) {
        if (byTenant.get(tenant.id)?.[channel]) continue;
        if (channelsOf(tenant.id)[channel]) counts[channel]++;
      }
    }
    return counts;
  };

  const tenantsWithoutEmailOverride = new Set(
    tenantRows.map((t) => t.id).filter((id) => !byTenant.get(id)?.email),
  );
  const verifiedEmailDomainsOnDefault = ((verifiedEmailDomains.data ?? []) as Array<{
    tenant_id: string;
  }>).filter((row) => tenantsWithoutEmailOverride.has(row.tenant_id)).length;

  return {
    accounts: await Promise.all(
      rows.map((row) => {
        const defaultFor = CHANNELS.filter((channel) => defaults[channel] === row.id);
        return accountView(row, housesOf(row.id, defaultFor), defaultFor);
      }),
    ),
    tenants: tenantRows.map(
      (tenant): TenantProvidersView => ({
        id: tenant.id,
        nome: tenant.nome,
        accounts: byTenant.get(tenant.id) ?? { sms: null, email: null, voice: null, webpush: null },
        channels: channelsOf(tenant.id),
      }),
    ),
    defaults,
    verifiedEmailDomainsOnDefault,
  };
}

// ---------------------------------------------------------------------------
// Create / edit

export async function adminSaveProviderAccountFor(
  context: AdminContext,
  data: z.infer<typeof saveProviderAccountInput>,
) {
  await assertSuperAdmin(context.userId);
  const supported = SUPPORTED_CHANNELS[data.provider];
  const channels = [...new Set(data.channels)];
  const unsupported = channels.filter((c) => !supported.includes(c));
  if (unsupported.length) {
    throw new Error(
      data.provider === "short_brasil"
        ? "A Short Brasil só atende SMS."
        : `${PROVIDER_LABEL[data.provider]} não atende ${unsupported.join(", ")}.`,
    );
  }

  // Conta env (credentials_source='env'): só o nome e os canais são
  // editáveis; credenciais e config continuam vindo das variáveis de
  // ambiente, intocados.
  if (data.id && ENV_ACCOUNT_IDS.has(data.id)) {
    const { data: row, error } = await db()
      .from("provider_accounts")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Conta de provedor não encontrada.");
    const before = row as AccountRow;
    if (before.provider !== data.provider) {
      throw new Error("Não é possível trocar o provedor de uma conta existente.");
    }
    const removed = (before.channels ?? []).filter((c) => !channels.includes(c));
    await assertNoHouseUsesRemovedChannels(data.id, removed);

    const { error: updateError } = await db()
      .from("provider_accounts")
      .update({ label: data.label, channels, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (updateError) throw new Error(updateError.message);
    invalidateProviderAccountsCache();
    await auditAdminAction({
      actorUserId: context.userId,
      action: "provider_account.update",
      before: { provider: before.provider, label: before.label, channels: before.channels },
      after: { id: data.id, provider: data.provider, label: data.label, channels },
    });
    return { id: data.id };
  }

  let before: AccountRow | null = null;
  let stored: Record<string, string> = {};
  if (data.id) {
    const { data: row, error } = await db()
      .from("provider_accounts")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Conta de provedor não encontrada.");
    before = row as AccountRow;
    if (before.owner_tenant_id) throw new Error(OWNED_ACCOUNT_ADMIN_MESSAGE);
    if (before.provider !== data.provider) {
      throw new Error("Não é possível trocar o provedor de uma conta existente.");
    }
    // A channel still used by a house cannot be removed from the account.
    const removed = (before.channels ?? []).filter((c) => !channels.includes(c));
    await assertNoHouseUsesRemovedChannels(data.id, removed);
    if (before.credentials_encrypted) {
      stored = await decryptProviderCredentials(before.credentials_encrypted);
    }
  }

  const { config, credentialsEncrypted } = await buildAccountPayload(
    data.provider,
    channels,
    data.config,
    data.credentials,
    stored,
  );

  const payload = {
    provider: data.provider,
    label: data.label,
    channels,
    credentials_source: "db",
    credentials_encrypted: credentialsEncrypted,
    config,
    updated_at: new Date().toISOString(),
  };
  const query = data.id
    ? db().from("provider_accounts").update(payload).eq("id", data.id)
    : db()
        .from("provider_accounts")
        .insert({ ...payload, status: "active", created_by: context.userId });
  const { data: saved, error: saveError } = await query.select("id").single();
  if (saveError) throw new Error(saveError.message);
  invalidateProviderAccountsCache();

  const summary = (
    row: Pick<AccountRow, "provider" | "label" | "channels"> & { config: unknown },
  ) => ({
    provider: row.provider,
    label: row.label,
    channels: row.channels,
    config: row.config,
  });
  await auditAdminAction({
    actorUserId: context.userId,
    action: data.id ? "provider_account.update" : "provider_account.create",
    before: before ? summary(before) : null,
    // Never the credentials: only which ones were (re)written.
    after: {
      id: (saved as { id: string }).id,
      ...summary({ ...data, channels, config }),
      credentials_changed: Object.keys(data.credentials).filter(
        (k) => data.credentials[k as keyof typeof data.credentials],
      ),
    },
  });
  return { id: (saved as { id: string }).id };
}

// ---------------------------------------------------------------------------
// Enable / disable

export async function adminSetProviderAccountStatusFor(
  context: AdminContext,
  data: z.infer<typeof setProviderAccountStatusInput>,
) {
  await assertSuperAdmin(context.userId);
  const ownerTenantId = await accountOwnerTenantId(data.id);
  // Conta com dono: o super admin pode desativar (sem editar credencial);
  // quem reativa é o admin da casa, ao ativar a conta própria de novo.
  if (ownerTenantId && data.status === "active") throw new Error(OWNED_ACCOUNT_ADMIN_MESSAGE);
  if (data.status === "disabled") {
    const [defaultedChannel] = await channelsDefaultedTo(data.id);
    if (defaultedChannel) {
      throw new Error(
        `Esta conta é a padrão de ${PROVIDER_CHANNEL_LABEL[defaultedChannel]}. Escolha outra padrão antes.`,
      );
    }
  }
  const { data: row, error } = await db()
    .from("provider_accounts")
    .update({ status: data.status, updated_at: new Date().toISOString() })
    .eq("id", data.id)
    .select("id, label")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Conta de provedor não encontrada.");
  invalidateProviderAccountsCache();
  await auditAdminAction({
    actorUserId: context.userId,
    action: `provider_account.${data.status === "active" ? "enable" : "disable"}`,
    after: { id: data.id, label: (row as { label: string }).label, status: data.status },
  });
  if (ownerTenantId) {
    await auditOwnProviderAction({
      tenantId: ownerTenantId,
      actorUserId: context.userId,
      action: "own_provider.disable",
      entityId: data.id,
      after: { id: data.id, label: (row as { label: string }).label, status: data.status },
    });
  }
  return { ok: true };
}

/** Casa dona da conta (null = conta da plataforma ou conta inexistente). */
async function accountOwnerTenantId(accountId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("provider_accounts")
    .select("id, owner_tenant_id")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { owner_tenant_id?: string | null } | null)?.owner_tenant_id ?? null;
}

// ---------------------------------------------------------------------------
// Connection test

export type ProviderAccountTestResult = { ok: boolean; message: string };

const TEST_TIMEOUT_MS = 10_000;

export async function adminTestProviderAccountFor(
  context: AdminContext,
  data: z.infer<typeof testProviderAccountInput>,
): Promise<ProviderAccountTestResult> {
  await assertSuperAdmin(context.userId);
  if (await accountOwnerTenantId(data.id)) throw new Error(OWNED_ACCOUNT_ADMIN_MESSAGE);
  const account = await loadProviderAccountForAdmin(data.id);
  const result = await runProviderAccountTest(account, data.phone);
  await auditAdminAction({
    actorUserId: context.userId,
    action: "provider_account.test",
    after: { id: data.id, ok: result.ok, message: result.message.slice(0, 300) },
  });
  return result;
}

/**
 * O teste de conexão em si (sem permissão nem auditoria), comum ao super
 * admin e ao admin da casa (conta própria). Mensagens de falha genéricas:
 * nunca status HTTP cru nem texto de erro de rede.
 */
export async function runProviderAccountTest(
  account: Awaited<ReturnType<typeof loadProviderAccountForAdmin>>,
  rawPhone: string | undefined,
): Promise<ProviderAccountTestResult> {
  let result: ProviderAccountTestResult;

  // Contas env (as 3 fixas de id) leem a URL do ambiente; o config salvo no
  // banco por uma conta anterior a este allowlist pode ainda apontar para um
  // host fora dele — validar de novo aqui, antes de qualquer chamada, para
  // que uma conta "legada" não vire um SSRF via "Testar".
  const isEnvAccount = ENV_ACCOUNT_IDS.has(account.id);

  if (account.provider === "infobip") {
    if (!infobipConfigured(account)) {
      result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
    } else {
      try {
        const baseUrl = isEnvAccount ? account.baseUrl : assertInfobipBaseUrl(account.baseUrl);
        const response = await providerFetch(`${baseUrl}/account/1/balance`, {
          headers: { Accept: "application/json", Authorization: `App ${account.apiKey}` },
          timeoutMs: TEST_TIMEOUT_MS,
        });
        const body = (await response.json().catch(() => null)) as {
          balance?: number;
          currency?: string;
        } | null;
        if (response.ok) {
          result = {
            ok: true,
            message:
              typeof body?.balance === "number"
                ? `Conectado. Saldo: ${body.balance.toLocaleString("pt-BR")} ${body.currency ?? ""}`.trim()
                : "Conectado.",
          };
        } else {
          console.error(`provider_account.test infobip: HTTP ${response.status}`);
          result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
        }
      } catch (error) {
        console.error("provider_account.test infobip:", error);
        result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
      }
    }
  } else if (account.provider === "onesignal") {
    if (!oneSignalConfigured(account)) {
      result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
    } else {
      try {
        const response = await providerFetch("https://api.onesignal.com/apps", {
          headers: { Accept: "application/json", Authorization: `Key ${account.orgApiKey}` },
          timeoutMs: TEST_TIMEOUT_MS,
        });
        if (response.ok) {
          result = { ok: true, message: "Chave da organização aceita." };
        } else {
          console.error(`provider_account.test onesignal: HTTP ${response.status}`);
          result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
        }
      } catch (error) {
        console.error("provider_account.test onesignal:", error);
        result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
      }
    }
  } else {
    if (!rawPhone) throw new Error("Informe um celular para receber o SMS de teste.");
    const phone = requireBrazilianPhone(rawPhone);
    const { postShortBrasilSingle } = await import("@/lib/sms.functions");
    try {
      if (!isEnvAccount) {
        // A URL que postShortBrasilSingle realmente usa: a da API Short Code
        // quando há token, senão a de envio individual.
        if (account.shortcodeToken) assertShortBrasilUrl("shortcode_url", account.shortcodeUrl);
        else assertShortBrasilUrl("single_url", account.singleUrl);
      }
      const r = await postShortBrasilSingle(
        account,
        phone,
        `Teste de conexão BetLeads: conta "${account.label}".`,
      );
      if (r.ok) {
        result = { ok: true, message: `SMS de teste aceito pelo provedor para ${phone}.` };
      } else {
        console.error(`provider_account.test short_brasil: status ${r.status}`, r.body);
        result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
      }
    } catch (error) {
      console.error("provider_account.test short_brasil:", error);
      result = { ok: false, message: PROVIDER_TEST_FAILURE_MESSAGE };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// A house's account per channel

export type SetTenantChannelProviderResult = {
  /** E-mail: the house's domains after moving them to the new account. */
  emailDomains: Array<{ hostname: string; status: string; error: string | null }>;
};

export async function adminSetTenantChannelProviderFor(
  context: AdminContext,
  data: z.infer<typeof setTenantChannelProviderInput>,
): Promise<SetTenantChannelProviderResult> {
  await assertSuperAdmin(context.userId);
  // accountId: null é o único jeito de "usar a padrão"; uma conta env
  // escolhida explicitamente é só mais uma conta (upsert de override).
  const accountId = data.accountId;

  const { data: current, error: currentError } = await db()
    .from("tenant_channel_providers")
    .select("provider_account_id")
    .eq("tenant_id", data.tenantId)
    .eq("channel", data.channel)
    .maybeSingle();
  if (currentError) throw new Error(currentError.message);
  const before = (current as { provider_account_id: string } | null)?.provider_account_id ?? null;
  if (before === accountId) return { emailDomains: [] };
  // Ligar ou desligar uma conta com dono é coisa da casa (ativar / voltar
  // para a rota da BetLeads) ou da revogação (adminResolveRevokedOwnProviderFor).
  if (
    (accountId && (await accountOwnerTenantId(accountId))) ||
    (before && (await accountOwnerTenantId(before)))
  ) {
    throw new Error(OWNED_ACCOUNT_ADMIN_MESSAGE);
  }

  if (accountId) {
    const { data: row, error } = await db()
      .from("provider_accounts")
      .select("id, provider, channels, status")
      .eq("id", accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const account = row as Pick<AccountRow, "id" | "provider" | "channels" | "status"> | null;
    if (!account) throw new Error("Conta de provedor não encontrada.");
    if (account.status !== "active") throw new Error("Esta conta está desativada.");
    if (
      !(account.channels ?? []).includes(data.channel) ||
      !SUPPORTED_CHANNELS[account.provider].includes(data.channel)
    ) {
      throw new Error("Esta conta não atende este canal.");
    }
    const { error: upsertError } = await db().from("tenant_channel_providers").upsert(
      {
        tenant_id: data.tenantId,
        channel: data.channel,
        provider_account_id: accountId,
        updated_by: context.userId,
      },
      { onConflict: "tenant_id,channel" },
    );
    if (upsertError) throw new Error(upsertError.message);
  } else {
    const { error: deleteError } = await db()
      .from("tenant_channel_providers")
      .delete()
      .eq("tenant_id", data.tenantId)
      .eq("channel", data.channel);
    if (deleteError) throw new Error(deleteError.message);
  }
  invalidateProviderAccountsCache();
  await auditAdminAction({
    actorUserId: context.userId,
    action: "tenant_channel_provider.set",
    tenantId: data.tenantId,
    before: { channel: data.channel, provider_account_id: before },
    after: { channel: data.channel, provider_account_id: accountId },
  });

  // E-mail domains live in an Infobip account: move them now so the house
  // sees the new DNS records right away (they go back to pending).
  const emailDomains =
    data.channel === "email"
      ? (await moveEmailDomains([data.tenantId])).map(({ hostname, status, error }) => ({
          hostname,
          status,
          error,
        }))
      : [];
  return { emailDomains };
}

// ---------------------------------------------------------------------------
// The platform default per channel

export async function adminSetPlatformDefaultFor(
  context: AdminContext,
  data: z.infer<typeof setPlatformDefaultInput>,
): Promise<{
  emailDomains: Array<{
    tenantId: string;
    tenantNome: string;
    hostname: string;
    status: string;
    error: string | null;
  }>;
}> {
  await assertSuperAdmin(context.userId);

  const { data: row, error } = await db()
    .from("provider_accounts")
    .select("id, provider, channels, status")
    .eq("id", data.accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const account = row as Pick<AccountRow, "id" | "provider" | "channels" | "status"> | null;
  if (!account) throw new Error("Conta de provedor não encontrada.");
  if (account.status !== "active") throw new Error("Esta conta está desativada.");
  if (
    !(account.channels ?? []).includes(data.channel) ||
    !SUPPORTED_CHANNELS[account.provider].includes(data.channel)
  ) {
    throw new Error("Esta conta não atende este canal.");
  }

  const defaults = await currentDefaults();
  const before = defaults[data.channel];
  if (before === data.accountId) {
    // Same default saved again: for e-mail it works as "re-sincronizar" —
    // an earlier move that died midway is resumed for the domains not yet
    // on this account. Nothing else changes (no upsert, no audit).
    return {
      emailDomains:
        data.channel === "email"
          ? await moveDefaultEmailDomains({ skipOnAccountId: data.accountId })
          : [],
    };
  }

  const { error: upsertError } = await db()
    .from("platform_channel_defaults")
    .upsert(
      {
        channel: data.channel,
        provider_account_id: data.accountId,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "channel" },
    );
  if (upsertError) throw new Error(upsertError.message);
  // Invalida o cache ANTES de mover os domínios: o resolver já deve ver a
  // nova padrão enquanto os domínios de e-mail ainda estão sendo trocados.
  invalidateProviderAccountsCache();

  await auditAdminAction({
    actorUserId: context.userId,
    action: "provider_account.set_default",
    before: { channel: data.channel, provider_account_id: before },
    after: { channel: data.channel, provider_account_id: data.accountId },
  });

  return { emailDomains: data.channel === "email" ? await moveDefaultEmailDomains() : [] };
}

/** Move os domínios de e-mail das casas sem conta própria de e-mail para a
 * padrão corrente (`skipOnAccountId`: retomar, pulando os que já estão nela). */
async function moveDefaultEmailDomains(opts: { skipOnAccountId?: string } = {}): Promise<
  Array<{ tenantId: string; tenantNome: string; hostname: string; status: string; error: string | null }>
> {
  const { data: overrideRows, error: overrideError } = await db()
    .from("tenant_channel_providers")
    .select("tenant_id")
    .eq("channel", "email");
  if (overrideError) throw new Error(overrideError.message);
  const overridden = new Set(
    ((overrideRows ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id),
  );
  const { data: tenantRows, error: tenantsError } = await db().from("tenants").select("id, nome");
  if (tenantsError) throw new Error(tenantsError.message);
  const targets = ((tenantRows ?? []) as Array<{ id: string; nome: string }>).filter(
    (t) => !overridden.has(t.id),
  );
  const tenantNomeById = new Map(targets.map((t) => [t.id, t.nome]));
  const moved = await moveEmailDomains(
    targets.map((t) => t.id),
    opts,
  );
  return moved.map((m) => ({
    tenantId: m.tenantId,
    tenantNome: tenantNomeById.get(m.tenantId) ?? "",
    hostname: m.hostname,
    status: m.status,
    error: m.error,
  }));
}

// ---------------------------------------------------------------------------
// Delete

export async function adminDeleteProviderAccountFor(
  context: AdminContext,
  data: z.infer<typeof deleteProviderAccountInput>,
): Promise<void> {
  await assertSuperAdmin(context.userId);
  if (ENV_ACCOUNT_IDS.has(data.id)) {
    throw new Error("Contas do ambiente não podem ser excluídas.");
  }

  const { data: row, error } = await db()
    .from("provider_accounts")
    .select("id, provider, label, channels, owner_tenant_id")
    .eq("id", data.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const account = row as Pick<
    AccountRow,
    "id" | "provider" | "label" | "channels" | "owner_tenant_id"
  > | null;
  if (!account) throw new Error("Conta de provedor não encontrada.");
  if (account.owner_tenant_id) throw new Error(OWNED_ACCOUNT_ADMIN_MESSAGE);

  const defaultedChannels = await channelsDefaultedTo(data.id);
  if (defaultedChannels.length) {
    throw new Error(
      `Esta conta é a padrão de ${defaultedChannels.map((c) => PROVIDER_CHANNEL_LABEL[c]).join(", ")}. Escolha outra padrão antes de excluir.`,
    );
  }

  const { data: inUse, error: inUseError } = await db()
    .from("tenant_channel_providers")
    .select("tenant_id")
    .eq("provider_account_id", data.id)
    .limit(1);
  if (inUseError) throw new Error(inUseError.message);
  if ((inUse ?? []).length) {
    throw new Error("Uma ou mais casas usam esta conta em algum canal. Mude essas casas de conta antes de excluir.");
  }

  const { data: domainsInUse, error: domainsError } = await db()
    .from("tenant_domains")
    .select("id")
    .eq("provider_account_id", data.id)
    .is("removed_at", null)
    .limit(1);
  if (domainsError) throw new Error(domainsError.message);
  if ((domainsInUse ?? []).length) {
    throw new Error(
      "Um ou mais domínios de e-mail de casas usam esta conta. Mude essas casas de conta antes de excluir.",
    );
  }

  const { data: appsInUse, error: appsError } = await db()
    .from("tenant_webpush_apps")
    .select("id")
    .eq("provider_account_id", data.id)
    .limit(1);
  if (appsError) throw new Error(appsError.message);
  if ((appsInUse ?? []).length) {
    throw new Error(
      "Um ou mais apps de web push de casas usam esta conta. Mude essas casas de conta antes de excluir.",
    );
  }

  // tenant_domains.provider_account_id não tem ON DELETE: domínios já
  // removidos (removed_at preenchido) não bloqueiam a exclusão (checagem
  // acima já cobre os ativos), mas precisam soltar a referência antes do
  // DELETE para não quebrar a FK.
  const { error: clearRemovedDomainsError } = await db()
    .from("tenant_domains")
    .update({ provider_account_id: null })
    .eq("provider_account_id", data.id)
    .not("removed_at", "is", null);
  if (clearRemovedDomainsError) throw new Error(clearRemovedDomainsError.message);

  const { error: deleteError } = await db().from("provider_accounts").delete().eq("id", data.id);
  if (deleteError) throw new Error(deleteError.message);
  invalidateProviderAccountsCache();

  await auditAdminAction({
    actorUserId: context.userId,
    action: "provider_account.delete",
    before: { provider: account.provider, label: account.label, channels: account.channels },
  });
}
