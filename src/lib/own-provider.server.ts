// Conta própria de provedor por casa — o lado do admin da casa (spec 6.2, 7).
//
// Toda função aqui exige uma linha `admin` em user_roles daquela casa
// (requireHouseAdmin; nunca is_tenant_admin, que é true para o super admin),
// concessão `allowed` no canal (menos "voltar para a rota da BetLeads") e só
// mexe na conta com owner_tenant_id = casa. Mudança de credencial, ativação e
// remoção pedem a senha de novo (requirePasswordReauth) e avisam por e-mail os
// outros admins da casa. Nenhuma resposta leva credencial (nem mascarada).

import { createClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  invalidateProviderAccountsCache,
  loadProviderAccountForAdmin,
} from "@/lib/provider-accounts.server";
import {
  auditOwnProviderAction,
  buildAccountPayload,
  moveEmailDomains,
  runProviderAccountTest,
  type ProviderAccountTestResult,
} from "@/lib/provider-accounts-admin.server";
import { lastAcceptedSendAt, loadGrant, type GrantRow } from "@/lib/own-provider-admin.server";
import { ensureCallbackToken } from "@/lib/provider-callback-tokens.server";
import { decryptProviderCredentials } from "@/lib/secret-box.server";
import {
  OWN_PROVIDER_CHANGED_EMAIL_SUBJECT,
  OWN_PROVIDER_CHANNEL_LABEL,
  OWN_PROVIDER_CHANNELS,
  OWN_PROVIDER_LABEL,
  OWN_PROVIDERS_BY_CHANNEL,
  type activateOwnProviderInput,
  type deactivateOwnProviderInput,
  type OwnProvider,
  type OwnProviderChannel,
  type removeOwnProviderAccountInput,
  type saveOwnProviderAccountInput,
  type testOwnProviderAccountInput,
} from "@/lib/own-provider.shared";

/** userId do JWT e a casa ativa já resolvida pelo wrapper da server function. */
export type HouseContext = { userId: string; tenantId: string };

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const NOT_HOUSE_ADMIN_MESSAGE = "Só o admin da casa pode fazer isso.";
const WRONG_PASSWORD_MESSAGE = "Senha incorreta.";
const PLATFORM_DISABLED_MESSAGE = "Esta conta foi desativada pela BetLeads. Fale com o suporte.";
const DUPLICATE_ACCOUNT_MESSAGE = "Já existe uma conta para este canal. Recarregue a página.";

// ---------------------------------------------------------------------------
// Guardas

/** Linha `admin` em user_roles desta casa; qualquer outra coisa recusa. */
export async function requireHouseAdmin(userId: string, tenantId: string): Promise<void> {
  const { data, error } = await db()
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .eq("role", "admin")
    .limit(1);
  if (error) throw new Error("Não foi possível validar a permissão da casa.");
  if (!((data ?? []) as unknown[]).length) throw new Error(NOT_HOUSE_ADMIN_MESSAGE);
}

/**
 * Confirma a senha com um login descartável (cliente anon sem sessão
 * persistida). A sessão criada é encerrada na hora, só ela (scope local).
 */
export async function requirePasswordReauth(email: string, password: string): Promise<void> {
  // Só a chave pública (anon): nunca a secret, que pularia a checagem de senha.
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Não foi possível confirmar a senha agora.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw new Error(WRONG_PASSWORD_MESSAGE);
  try {
    await client.auth.signOut({ scope: "local" });
  } catch (signOutError) {
    console.warn("[own-provider] reauth sign-out failed", {
      error: signOutError instanceof Error ? signOutError.message : String(signOutError),
    });
  }
}

async function userEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) return null;
  return data?.user?.email ?? null;
}

async function reauth(userId: string, password: string): Promise<void> {
  const email = await userEmail(userId);
  if (!email) throw new Error(WRONG_PASSWORD_MESSAGE);
  await requirePasswordReauth(email, password);
}

async function requireAllowedGrant(tenantId: string, channel: OwnProviderChannel): Promise<GrantRow> {
  const grant = await loadGrant(tenantId, channel);
  if (!grant?.allowed) {
    throw new Error(
      `Conta própria não liberada para ${OWN_PROVIDER_CHANNEL_LABEL[channel]} nesta casa.`,
    );
  }
  return grant;
}

// ---------------------------------------------------------------------------
// Leitura da conta da casa

type OwnAccountFullRow = {
  id: string;
  provider: OwnProvider;
  label: string;
  channels: string[];
  status: "active" | "disabled";
  owner_tenant_id: string;
  credentials_encrypted: string | null;
  config: Record<string, unknown> | null;
  own_unit_cost: number | string | null;
  last_callback_at: string | null;
  disabled_reason: "platform" | "revoked" | null;
};

/**
 * Desativada pela BetLeads ('platform', ou sem motivo registrado): a casa não
 * grava, não testa, não reativa nem remove — a linha continua ocupando a vaga
 * do canal (índice único), então a casa também não cria outra no lugar. Só a
 * desativação por revogação ('revoked') fica nas mãos da casa.
 */
function assertNotPlatformDisabled(account: Pick<OwnAccountFullRow, "status" | "disabled_reason">) {
  if (account.status !== "active" && account.disabled_reason !== "revoked") {
    throw new Error(PLATFORM_DISABLED_MESSAGE);
  }
}

/** A conta com dono da casa no canal (null quando ainda não cadastrada). */
async function houseAccount(
  tenantId: string,
  channel: OwnProviderChannel,
): Promise<OwnAccountFullRow | null> {
  const { data, error } = await db()
    .from("provider_accounts")
    .select(
      "id, provider, label, channels, status, owner_tenant_id, credentials_encrypted, config, own_unit_cost, last_callback_at, disabled_reason",
    )
    .eq("owner_tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (
    ((data ?? []) as OwnAccountFullRow[]).find((row) => (row.channels ?? []).includes(channel)) ??
    null
  );
}

async function requireHouseAccount(
  tenantId: string,
  channel: OwnProviderChannel,
): Promise<OwnAccountFullRow> {
  const account = await houseAccount(tenantId, channel);
  if (!account) throw new Error("Cadastre a conta própria deste canal antes.");
  return account;
}

/** Ligação atual do canal da casa (null = rota da BetLeads, a padrão). */
async function channelLink(tenantId: string, channel: OwnProviderChannel): Promise<string | null> {
  const { data, error } = await db()
    .from("tenant_channel_providers")
    .select("provider_account_id")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { provider_account_id: string } | null)?.provider_account_id ?? null;
}

async function storedCredentials(row: { credentials_encrypted: string | null }) {
  if (!row.credentials_encrypted) return {};
  return decryptProviderCredentials(row.credentials_encrypted);
}

function configText(config: Record<string, unknown> | null, key: string): string | null {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function smsCallbackUrl(token: string): string {
  const appUrl = (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
  // Token no caminho: com ?token= a Short Brasil devolve só o token no
  // callback, sem id nem status (origin/main 40e5ba5).
  return `${appUrl}/api/public/sms-webhook/${encodeURIComponent(token)}`;
}

export type OwnAccountView = {
  id: string;
  provider: OwnProvider;
  label: string;
  status: "active" | "disabled";
  /** 'platform' = desativada pela BetLeads; 'revoked' = pela revogação do canal. */
  disabledReason: "platform" | "revoked" | null;
  ownUnitCost: number | null;
  smsFrom: string | null;
  voiceFrom: string | null;
  baseUrl: string | null;
  lastCallbackAt: string | null;
  lastAcceptedSendAt: string | null;
  /** Nomes das credenciais gravadas — nunca os valores. */
  credentialsSet: string[];
};

export type OwnProviderChannelState = {
  channel: OwnProviderChannel;
  monthlyFeeCents: number;
  account: OwnAccountView | null;
  usingOwnAccount: boolean;
  /** Short Brasil: URL a configurar no painel. Infobip: null (vai em cada envio). */
  callbackUrl: string | null;
  /** Concessão revogada: o canal aparece só para mostrar a pausa e o "Voltar
   * para a rota da BetLeads" (quando a conta ainda está ligada). */
  revoked: boolean;
  /** Revogada e aguardando a decisão do super admin (padrão ou pausado). */
  pendingDecision: boolean;
};

export async function getOwnProviderStateFor(ctx: HouseContext): Promise<OwnProviderChannelState[]> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  const { data, error } = await db()
    .from("tenant_own_provider_grants")
    .select("channel, allowed, monthly_fee_cents, pending_decision")
    .eq("tenant_id", ctx.tenantId);
  if (error) throw new Error(error.message);
  const grants = (data ?? []) as Array<{
    channel: OwnProviderChannel;
    allowed: boolean;
    monthly_fee_cents: number;
    pending_decision: boolean;
  }>;

  const states: OwnProviderChannelState[] = [];
  for (const channel of OWN_PROVIDER_CHANNELS) {
    const grant = grants.find((g) => g.channel === channel);
    if (!grant) continue;
    const row = await houseAccount(ctx.tenantId, channel);
    // Canal sem concessão fica escondido, a não ser que a revogação tenha
    // deixado conta ou ligação da casa (estado pausado).
    if (!grant.allowed && !row) continue;
    let account: OwnAccountView | null = null;
    let callbackUrl: string | null = null;
    let usingOwnAccount = false;
    if (row) {
      let credentialsSet: string[] = [];
      try {
        const creds = await storedCredentials(row);
        credentialsSet = Object.entries(creds)
          .filter(([, v]) => typeof v === "string" && v)
          .map(([k]) => k);
      } catch {
        credentialsSet = [];
      }
      account = {
        id: row.id,
        provider: row.provider,
        label: row.label,
        status: row.status,
        disabledReason: row.disabled_reason ?? null,
        ownUnitCost: row.own_unit_cost === null ? null : Number(row.own_unit_cost),
        smsFrom: configText(row.config, "sms_from"),
        voiceFrom: configText(row.config, "voice_from"),
        baseUrl: configText(row.config, "base_url"),
        lastCallbackAt: row.last_callback_at ?? null,
        lastAcceptedSendAt: await lastAcceptedSendAt(ctx.tenantId, channel, row.id),
        credentialsSet,
      };
      if (row.provider === "short_brasil") callbackUrl = smsCallbackUrl(await ensureCallbackToken(row.id));
      usingOwnAccount = (await channelLink(ctx.tenantId, channel)) === row.id;
    }
    states.push({
      channel,
      monthlyFeeCents: Number(grant.monthly_fee_cents),
      account,
      usingOwnAccount,
      callbackUrl,
      revoked: !grant.allowed,
      pendingDecision: Boolean(grant.pending_decision),
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// E-mail aos outros admins da casa (falha nunca derruba a ação)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notifyOtherHouseAdmins(
  ctx: HouseContext,
  channel: OwnProviderChannel,
  what: string,
): Promise<void> {
  try {
    const { data, error } = await db()
      .from("user_roles")
      .select("user_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("role", "admin");
    if (error) throw new Error(error.message);
    const userIds = [
      ...new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    ].filter((id) => id !== ctx.userId);
    if (!userIds.length) return;

    const [{ data: tenant }, actorEmail] = await Promise.all([
      db().from("tenants").select("nome").eq("id", ctx.tenantId).maybeSingle(),
      userEmail(ctx.userId),
    ]);
    const tenantName = (tenant as { nome?: string } | null)?.nome ?? "sua casa";
    const html = [
      `<p>Olá!</p>`,
      `<p>${escapeHtml(actorEmail ?? "Um admin da casa")} ${escapeHtml(what)} de ` +
        `<strong>${escapeHtml(OWN_PROVIDER_CHANNEL_LABEL[channel])}</strong> da casa ` +
        `<strong>${escapeHtml(tenantName)}</strong>.</p>`,
      `<p>Se você não reconhece esta mudança, fale com os admins da casa e com o suporte da BetLeads.</p>`,
    ].join("\n");

    const { sendPlatformEmail } = await import("@/lib/platform-email.server");
    const sentTo = new Set<string>();
    for (const userId of userIds) {
      try {
        const email = await userEmail(userId);
        if (!email || sentTo.has(email) || email === actorEmail) continue;
        sentTo.add(email);
        await sendPlatformEmail({ to: email, subject: OWN_PROVIDER_CHANGED_EMAIL_SUBJECT, html });
      } catch (error) {
        console.error("[own-provider] notice e-mail failed", {
          tenantId: ctx.tenantId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    console.error("[own-provider] could not notify the other admins", {
      tenantId: ctx.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Cadastrar / atualizar

function roundCost(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export async function saveOwnProviderAccountFor(
  ctx: HouseContext,
  data: z.infer<typeof saveOwnProviderAccountInput>,
): Promise<{ id: string }> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  await requireAllowedGrant(ctx.tenantId, data.channel);
  if (!OWN_PROVIDERS_BY_CHANNEL[data.channel].includes(data.provider)) {
    throw new Error(
      `${OWN_PROVIDER_LABEL[data.provider]} não atende ${OWN_PROVIDER_CHANNEL_LABEL[data.channel]}.`,
    );
  }
  const existing = await houseAccount(ctx.tenantId, data.channel);
  if (existing) assertNotPlatformDisabled(existing);
  if (existing && existing.provider !== data.provider) {
    throw new Error("Não é possível trocar o provedor de uma conta existente.");
  }

  const stored = existing ? await storedCredentials(existing) : {};
  // Short Brasil de conta própria não aceita URL nenhuma (usa sempre os
  // endereços padrão do código): nada do config entra.
  const { config, credentialsEncrypted, credentialKeys } = await buildAccountPayload(
    data.provider,
    [data.channel],
    data.provider === "short_brasil" ? {} : data.config,
    data.credentials,
    stored,
  );
  const ownUnitCost =
    data.ownUnitCost === undefined
      ? existing?.own_unit_cost === undefined || existing?.own_unit_cost === null
        ? null
        : Number(existing.own_unit_cost)
      : data.ownUnitCost === null
        ? null
        : roundCost(data.ownUnitCost);

  // Senha conferida só depois das validações e antes de qualquer escrita.
  await reauth(ctx.userId, data.password);

  const now = new Date().toISOString();
  const common = {
    label: data.label,
    credentials_source: "db",
    credentials_encrypted: credentialsEncrypted,
    config,
    own_unit_cost: ownUnitCost,
    updated_at: now,
  };
  const query = existing
    ? db()
        .from("provider_accounts")
        .update(common)
        .eq("id", existing.id)
        .eq("owner_tenant_id", ctx.tenantId)
    : db()
        .from("provider_accounts")
        .insert({
          ...common,
          provider: data.provider,
          channels: [data.channel],
          owner_tenant_id: ctx.tenantId,
          status: "active",
          created_by: ctx.userId,
        });
  const { data: saved, error } = await query.select("id").single();
  // Índice único (owner_tenant_id, channels[1]): outro save da casa criou a
  // conta do canal ao mesmo tempo.
  if (error?.code === "23505") throw new Error(DUPLICATE_ACCOUNT_MESSAGE);
  if (error) throw new Error(error.message);
  const id = (saved as { id: string }).id;
  invalidateProviderAccountsCache();
  await ensureCallbackToken(id);

  const credentialsChanged = Object.entries(data.credentials)
    .filter(([, v]) => v)
    .map(([k]) => k);
  await auditOwnProviderAction({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: "own_provider.save",
    entityId: id,
    before: existing
      ? { label: existing.label, config: existing.config, own_unit_cost: existing.own_unit_cost }
      : null,
    after: {
      id,
      channel: data.channel,
      provider: data.provider,
      label: data.label,
      config,
      own_unit_cost: ownUnitCost,
      credentials_set: credentialKeys,
    },
    metadata: { created: !existing, credentials_changed: credentialsChanged },
  });
  await notifyOtherHouseAdmins(
    ctx,
    data.channel,
    existing
      ? credentialsChanged.length
        ? "trocou as credenciais da conta própria"
        : "alterou a conta própria"
      : "cadastrou a conta própria",
  );
  return { id };
}

// ---------------------------------------------------------------------------
// Testar

export async function testOwnProviderAccountFor(
  ctx: HouseContext,
  data: z.infer<typeof testOwnProviderAccountInput>,
): Promise<ProviderAccountTestResult> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  await requireAllowedGrant(ctx.tenantId, data.channel);
  const row = await requireHouseAccount(ctx.tenantId, data.channel);
  assertNotPlatformDisabled(row);
  const account = await loadProviderAccountForAdmin(row.id);
  if (account.ownerTenantId !== ctx.tenantId || account.provider === "onesignal") {
    throw new Error("Cadastre a conta própria deste canal antes.");
  }
  return runProviderAccountTest(account, data.phone);
}

// ---------------------------------------------------------------------------
// Ativar / voltar para a rota da BetLeads / remover

type EmailDomainsResult = { emailDomains: Array<{ hostname: string; status: string; error: string | null }> };

async function refreshHouseEmailDomains(
  tenantId: string,
  channel: OwnProviderChannel,
): Promise<EmailDomainsResult["emailDomains"]> {
  if (channel !== "email") return [];
  return (await moveEmailDomains([tenantId])).map(({ hostname, status, error }) => ({
    hostname,
    status,
    error,
  }));
}

export async function activateOwnProviderFor(
  ctx: HouseContext,
  data: z.infer<typeof activateOwnProviderInput>,
): Promise<EmailDomainsResult> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  await requireAllowedGrant(ctx.tenantId, data.channel);
  const account = await requireHouseAccount(ctx.tenantId, data.channel);
  // Só a desativação por revogação ('revoked') a casa desfaz, e só com a
  // concessão de volta (checada acima). 'platform' (ou sem motivo
  // registrado) fica com o super admin.
  assertNotPlatformDisabled(account);
  await reauth(ctx.userId, data.password);

  const now = new Date().toISOString();
  if (account.status !== "active") {
    const { data: reactivated, error } = await db()
      .from("provider_accounts")
      .update({ status: "active", disabled_reason: null, updated_at: now })
      .eq("id", account.id)
      .eq("owner_tenant_id", ctx.tenantId)
      .eq("disabled_reason", "revoked")
      .select("id");
    if (error) throw new Error(error.message);
    // O motivo mudou entre a leitura e a escrita (ex.: o super admin
    // desativou agora): nada de ligação nem aviso de ativação.
    if (!((reactivated ?? []) as unknown[]).length) throw new Error(PLATFORM_DISABLED_MESSAGE);
  }
  const before = await channelLink(ctx.tenantId, data.channel);
  const { error: upsertError } = await db().from("tenant_channel_providers").upsert(
    {
      tenant_id: ctx.tenantId,
      channel: data.channel,
      provider_account_id: account.id,
      updated_by: ctx.userId,
    },
    { onConflict: "tenant_id,channel" },
  );
  if (upsertError) throw new Error(upsertError.message);
  invalidateProviderAccountsCache();

  await auditOwnProviderAction({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: "own_provider.activate",
    entityId: account.id,
    before: { channel: data.channel, provider_account_id: before, account_status: account.status },
    after: { channel: data.channel, provider_account_id: account.id, account_status: "active" },
  });
  // E-mail: os domínios da casa passam para a conta própria (voltam a
  // pending com o DKIM novo).
  const emailDomains = await refreshHouseEmailDomains(ctx.tenantId, data.channel);
  await notifyOtherHouseAdmins(ctx, data.channel, "ativou a conta própria");
  return { emailDomains };
}

/** "Voltar para a rota da BetLeads": tira só a ligação com a conta da casa. */
export async function deactivateOwnProviderFor(
  ctx: HouseContext,
  data: z.infer<typeof deactivateOwnProviderInput>,
): Promise<EmailDomainsResult> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  const account = await houseAccount(ctx.tenantId, data.channel);
  const linked = await channelLink(ctx.tenantId, data.channel);
  if (!account || linked !== account.id) {
    throw new Error("A conta própria não está ativa neste canal.");
  }
  const { error } = await db()
    .from("tenant_channel_providers")
    .delete()
    .eq("tenant_id", ctx.tenantId)
    .eq("channel", data.channel)
    .eq("provider_account_id", account.id);
  if (error) throw new Error(error.message);
  invalidateProviderAccountsCache();

  await auditOwnProviderAction({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: "own_provider.deactivate",
    entityId: account.id,
    before: { channel: data.channel, provider_account_id: account.id },
    after: { channel: data.channel, provider_account_id: null },
  });
  return { emailDomains: await refreshHouseEmailDomains(ctx.tenantId, data.channel) };
}

export async function removeOwnProviderAccountFor(
  ctx: HouseContext,
  data: z.infer<typeof removeOwnProviderAccountInput>,
): Promise<void> {
  await requireHouseAdmin(ctx.userId, ctx.tenantId);
  await requireAllowedGrant(ctx.tenantId, data.channel);
  const account = await requireHouseAccount(ctx.tenantId, data.channel);
  assertNotPlatformDisabled(account);

  const { data: links, error: linksError } = await db()
    .from("tenant_channel_providers")
    .select("tenant_id")
    .eq("provider_account_id", account.id)
    .limit(1);
  if (linksError) throw new Error(linksError.message);
  if (((links ?? []) as unknown[]).length) {
    throw new Error("A conta está ativa. Volte para a rota da BetLeads antes de remover.");
  }
  const { data: liveDomains, error: domainsError } = await db()
    .from("tenant_domains")
    .select("id")
    .eq("provider_account_id", account.id)
    .is("removed_at", null)
    .limit(1);
  if (domainsError) throw new Error(domainsError.message);
  if (((liveDomains ?? []) as unknown[]).length) {
    throw new Error(
      "Um ou mais domínios de e-mail da casa ainda estão nesta conta. Tente de novo em alguns minutos.",
    );
  }

  await reauth(ctx.userId, data.password);

  // Domínios já removidos ainda podem apontar para a conta (FK sem ON DELETE).
  const { error: clearError } = await db()
    .from("tenant_domains")
    .update({ provider_account_id: null })
    .eq("provider_account_id", account.id)
    .not("removed_at", "is", null);
  if (clearError) throw new Error(clearError.message);
  const { data: deleted, error: deleteError } = await db()
    .from("provider_accounts")
    .delete()
    .eq("id", account.id)
    .eq("owner_tenant_id", ctx.tenantId)
    // Mesma regra de assertNotPlatformDisabled, na própria escrita.
    .or("status.eq.active,disabled_reason.eq.revoked")
    .select("id");
  if (deleteError) throw new Error(deleteError.message);
  if (!((deleted ?? []) as unknown[]).length) throw new Error(PLATFORM_DISABLED_MESSAGE);
  invalidateProviderAccountsCache();

  await auditOwnProviderAction({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: "own_provider.remove",
    entityId: account.id,
    before: { channel: data.channel, provider: account.provider, label: account.label },
    after: null,
  });
  await notifyOtherHouseAdmins(ctx, data.channel, "removeu a conta própria");
}
