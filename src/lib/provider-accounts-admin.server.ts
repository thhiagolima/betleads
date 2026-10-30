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
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  envInfobipAccount,
  envShortBrasilAccount,
  infobipConfigured,
  invalidateProviderAccountsCache,
  loadProviderAccountForAdmin,
  shortBrasilConfigured,
  type ProviderChannel,
} from "@/lib/provider-accounts.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "@/lib/secret-box.server";
import { requireBrazilianPhone } from "@/lib/phone-normalization";
import {
  saveProviderAccountInput,
  setProviderAccountStatusInput,
  setTenantChannelProviderInput,
  SUPPORTED_CHANNELS,
  testProviderAccountInput,
} from "@/lib/provider-accounts.shared";

type AdminContext = { userId: string };

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const PLATFORM_ACCOUNT_IDS = new Set([DEFAULT_SHORT_BRASIL_ACCOUNT_ID, DEFAULT_INFOBIP_ACCOUNT_ID]);

/** Credential fields per provider (the only keys ever stored). */
const CREDENTIAL_KEYS = {
  short_brasil: ["shortcode_token", "usuario", "chave"],
  infobip: ["api_key"],
} as const;

/** Non-secret config fields per provider. */
const CONFIG_KEYS = {
  short_brasil: ["shortcode_url", "single_url", "bulk_url"],
  infobip: ["base_url", "voice_from", "sms_from"],
} as const;

type AccountRow = {
  id: string;
  provider: "short_brasil" | "infobip";
  label: string;
  channels: ProviderChannel[];
  credentials_source: "env" | "db";
  credentials_encrypted: string | null;
  config: Record<string, unknown> | null;
  status: "active" | "disabled";
  created_at?: string;
  updated_at?: string;
};

export type ProviderAccountView = {
  id: string;
  provider: "short_brasil" | "infobip";
  label: string;
  channels: ProviderChannel[];
  status: "active" | "disabled";
  /** The two env-backed platform accounts: read-only here. */
  platformDefault: boolean;
  configured: boolean;
  config: Record<string, string>;
  /** Masked last characters of each stored credential ("••••abcd"). */
  credentialHints: Record<string, string>;
  /** Houses on this account, per channel. */
  houses: Record<ProviderChannel, number>;
};

export type TenantProvidersView = {
  id: string;
  nome: string;
  /** null = the platform account. */
  accounts: Record<ProviderChannel, string | null>;
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
): Promise<ProviderAccountView> {
  const platformDefault = PLATFORM_ACCOUNT_IDS.has(row.id);
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
    } else {
      const env = envInfobipAccount();
      configured = infobipConfigured(env);
      if (env.apiKey) credentialHints = { api_key: hint(env.apiKey) };
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
          : Boolean(creds.api_key && config.base_url);
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
    platformDefault,
    configured,
    config: platformDefault ? {} : stringConfig(row.config),
    credentialHints,
    houses,
  };
}

// ---------------------------------------------------------------------------
// Listing

export async function adminListProviderAccountsFor(context: AdminContext) {
  await assertSuperAdmin(context.userId);
  const [accounts, assignments, tenants] = await Promise.all([
    db()
      .from("provider_accounts")
      .select(
        "id, provider, label, channels, credentials_source, credentials_encrypted, config, status, created_at",
      )
      .order("created_at", { ascending: true }),
    db().from("tenant_channel_providers").select("tenant_id, channel, provider_account_id"),
    db().from("tenants").select("id, nome").order("nome"),
  ]);
  for (const result of [accounts, assignments, tenants]) {
    if (result.error) throw new Error(result.error.message);
  }
  const rows = (accounts.data ?? []) as AccountRow[];
  const links = (assignments.data ?? []) as Array<{
    tenant_id: string;
    channel: ProviderChannel;
    provider_account_id: string;
  }>;

  const housesOf = (accountId: string) => {
    const counts = { sms: 0, email: 0, voice: 0 } as Record<ProviderChannel, number>;
    for (const link of links) if (link.provider_account_id === accountId) counts[link.channel]++;
    return counts;
  };
  const byTenant = new Map<string, Record<ProviderChannel, string | null>>();
  for (const link of links) {
    const current = byTenant.get(link.tenant_id) ?? { sms: null, email: null, voice: null };
    current[link.channel] = link.provider_account_id;
    byTenant.set(link.tenant_id, current);
  }

  return {
    accounts: await Promise.all(rows.map((row) => accountView(row, housesOf(row.id)))),
    tenants: ((tenants.data ?? []) as Array<{ id: string; nome: string }>).map(
      (tenant): TenantProvidersView => ({
        id: tenant.id,
        nome: tenant.nome,
        accounts: byTenant.get(tenant.id) ?? { sms: null, email: null, voice: null },
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Create / edit

function assertHttpsUrl(value: string | undefined, field: string) {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field}: URL inválida.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field}: use uma URL http(s).`);
  }
}

export async function adminSaveProviderAccountFor(
  context: AdminContext,
  data: z.infer<typeof saveProviderAccountInput>,
) {
  await assertSuperAdmin(context.userId);
  if (data.id && PLATFORM_ACCOUNT_IDS.has(data.id)) {
    throw new Error("As contas padrão da plataforma são configuradas pelas variáveis de ambiente.");
  }
  const supported = SUPPORTED_CHANNELS[data.provider];
  const channels = [...new Set(data.channels)];
  const unsupported = channels.filter((c) => !supported.includes(c));
  if (unsupported.length) throw new Error("A Short Brasil só atende SMS.");

  const config: Record<string, string> = {};
  for (const key of CONFIG_KEYS[data.provider]) {
    const value = data.config[key];
    if (value) config[key] = value;
  }
  if (data.provider === "infobip") {
    if (!config.base_url) throw new Error("Informe a URL base da conta Infobip.");
    assertHttpsUrl(config.base_url, "URL base");
    if (channels.includes("voice")) {
      const digits = (config.voice_from ?? "").replace(/\D/g, "");
      if (digits.length < 10) throw new Error("Informe o número de origem das ligações (voz).");
      config.voice_from = digits;
    }
  } else {
    assertHttpsUrl(config.shortcode_url, "URL da API Short Code");
    assertHttpsUrl(config.single_url, "URL de envio individual");
    assertHttpsUrl(config.bulk_url, "URL de envio em lote");
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
    if (before.provider !== data.provider) {
      throw new Error("Não é possível trocar o provedor de uma conta existente.");
    }
    // A channel still used by a house cannot be removed from the account.
    const removed = (before.channels ?? []).filter((c) => !channels.includes(c));
    if (removed.length) {
      const { data: inUse, error: inUseError } = await db()
        .from("tenant_channel_providers")
        .select("tenant_id, channel")
        .eq("provider_account_id", data.id)
        .in("channel", removed);
      if (inUseError) throw new Error(inUseError.message);
      if ((inUse ?? []).length) {
        throw new Error(
          "Há casas usando esta conta nos canais removidos. Mude essas casas de conta antes.",
        );
      }
    }
    if (before.credentials_encrypted) {
      stored = await decryptProviderCredentials(before.credentials_encrypted);
    }
  }

  const credentials: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS[data.provider]) {
    const value = cleanCredential(data.credentials[key] ?? stored[key]);
    if (value) credentials[key] = value;
  }
  const hasCredentials =
    data.provider === "short_brasil"
      ? Boolean(credentials.shortcode_token || (credentials.usuario && credentials.chave))
      : Boolean(credentials.api_key);
  if (!hasCredentials) {
    throw new Error(
      data.provider === "short_brasil"
        ? "Informe o token da API Short Code ou o usuário e a chave da API legada."
        : "Informe a API key da conta Infobip.",
    );
  }

  const payload = {
    provider: data.provider,
    label: data.label,
    channels,
    credentials_source: "db",
    credentials_encrypted: await encryptProviderCredentials(credentials),
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
  if (PLATFORM_ACCOUNT_IDS.has(data.id)) {
    throw new Error("As contas padrão da plataforma não podem ser desativadas.");
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
  return { ok: true };
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
  const account = await loadProviderAccountForAdmin(data.id);
  let result: ProviderAccountTestResult;

  if (account.provider === "infobip") {
    if (!infobipConfigured(account)) {
      result = { ok: false, message: "URL base ou API key não configurada." };
    } else {
      try {
        const response = await fetch(`${account.baseUrl}/account/1/balance`, {
          headers: { Accept: "application/json", Authorization: `App ${account.apiKey}` },
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        const body = (await response.json().catch(() => null)) as {
          balance?: number;
          currency?: string;
        } | null;
        result = response.ok
          ? {
              ok: true,
              message:
                typeof body?.balance === "number"
                  ? `Conectado. Saldo: ${body.balance.toLocaleString("pt-BR")} ${body.currency ?? ""}`.trim()
                  : "Conectado.",
            }
          : {
              ok: false,
              message:
                response.status === 401 || response.status === 403
                  ? "A Infobip recusou a API key."
                  : `A Infobip respondeu HTTP ${response.status}.`,
            };
      } catch (error) {
        result = {
          ok: false,
          message: `Sem resposta da Infobip: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  } else {
    if (!data.phone) throw new Error("Informe um celular para receber o SMS de teste.");
    const phone = requireBrazilianPhone(data.phone);
    const { postShortBrasilSingle, summarizeProviderError } = await import("@/lib/sms.functions");
    const r = await postShortBrasilSingle(
      account,
      phone,
      `Teste de conexão BetLeads: conta "${account.label}".`,
    );
    result = r.ok
      ? { ok: true, message: `SMS de teste aceito pelo provedor para ${phone}.` }
      : {
          ok: false,
          message:
            r.status > 0
              ? summarizeProviderError(r.status, r.body)
              : String((r.body as { error?: unknown } | null)?.error ?? "Falha no envio."),
        };
  }

  await auditAdminAction({
    actorUserId: context.userId,
    action: "provider_account.test",
    after: { id: data.id, ok: result.ok, message: result.message.slice(0, 300) },
  });
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
  const accountId =
    data.accountId && !PLATFORM_ACCOUNT_IDS.has(data.accountId) ? data.accountId : null;

  const { data: current, error: currentError } = await db()
    .from("tenant_channel_providers")
    .select("provider_account_id")
    .eq("tenant_id", data.tenantId)
    .eq("channel", data.channel)
    .maybeSingle();
  if (currentError) throw new Error(currentError.message);
  const before = (current as { provider_account_id: string } | null)?.provider_account_id ?? null;
  if (before === accountId) return { emailDomains: [] };

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
  const emailDomains: SetTenantChannelProviderResult["emailDomains"] = [];
  if (data.channel === "email") {
    const { data: domains, error: domainsError } = await db()
      .from("tenant_domains")
      .select("id, hostname")
      .eq("tenant_id", data.tenantId)
      .eq("kind", "email")
      .is("removed_at", null);
    if (domainsError) throw new Error(domainsError.message);
    const { refreshTenantDomain } = await import("@/lib/tenant-domains.server");
    for (const domain of (domains ?? []) as Array<{ id: string; hostname: string }>) {
      try {
        const refreshed = await refreshTenantDomain(domain.id, { requestVerify: true });
        emailDomains.push({
          hostname: refreshed.hostname,
          status: refreshed.status,
          error: refreshed.last_error,
        });
      } catch (error) {
        emailDomains.push({
          hostname: domain.hostname,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { emailDomains };
}
