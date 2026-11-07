// Conta própria de provedor por casa — o lado do super admin (spec 6.1):
// liberar/revogar o canal para a casa com a taxa mensal, decidir o que fazer
// com um canal pausado por revogação e listar as concessões. Credenciais de
// conta com dono nunca passam por aqui (só o admin da casa as grava).

import type { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";
import { invalidateProviderAccountsCache } from "@/lib/provider-accounts.server";
import { auditOwnProviderAction, moveEmailDomains } from "@/lib/provider-accounts-admin.server";
import type {
  OwnProviderChannel,
  resolveRevokedOwnProviderInput,
  setOwnProviderGrantInput,
} from "@/lib/own-provider.shared";

type AdminContext = { userId: string };

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type GrantRow = {
  tenant_id: string;
  channel: OwnProviderChannel;
  allowed: boolean;
  monthly_fee_cents: number;
  granted_at: string | null;
  granted_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  pending_decision: boolean;
};

export type OwnedAccountRow = {
  id: string;
  provider: "short_brasil" | "infobip";
  label: string;
  channels: string[];
  status: "active" | "disabled";
  owner_tenant_id: string;
  last_callback_at: string | null;
};

export async function loadGrant(tenantId: string, channel: OwnProviderChannel): Promise<GrantRow | null> {
  const { data, error } = await db()
    .from("tenant_own_provider_grants")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GrantRow | null) ?? null;
}

/** Contas com dono da casa naquele canal (uma por casa e canal na prática). */
export async function ownedAccountsOf(
  tenantId: string,
  channel: OwnProviderChannel,
): Promise<OwnedAccountRow[]> {
  const { data, error } = await db()
    .from("provider_accounts")
    .select("id, provider, label, channels, status, owner_tenant_id, last_callback_at")
    .eq("owner_tenant_id", tenantId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as OwnedAccountRow[]).filter((row) => (row.channels ?? []).includes(channel));
}

const LAST_SEND_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Último envio aceito pela conta nos últimos 7 dias (janela curta: as
 * tabelas de log não têm índice em provider_account_id, só em tenant/data).
 * Nunca lança: o card de saúde não pode quebrar por isso.
 */
export async function lastAcceptedSendAt(
  tenantId: string,
  channel: OwnProviderChannel,
  accountId: string,
): Promise<string | null> {
  const since = new Date(Date.now() - LAST_SEND_WINDOW_MS).toISOString();
  try {
    const base = (table: string) =>
      db()
        .from(table)
        .select("created_at")
        .eq("tenant_id", tenantId)
        .eq("provider_account_id", accountId)
        .gte("created_at", since);
    const query =
      channel === "sms"
        ? base("sms_send_logs").eq("status", "sent")
        : channel === "email"
          ? base("email_send_logs").eq("status", "sent")
          : base("call_history").is("error_message", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
  } catch (error) {
    console.error("[own-provider] last accepted send lookup failed", {
      tenantId,
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function auditBoth(args: {
  actorUserId: string;
  tenantId: string;
  action: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}) {
  await auditOwnProviderAction(args);
  await auditAdminAction({
    actorUserId: args.actorUserId,
    action: args.action,
    tenantId: args.tenantId,
    before: args.before,
    after: args.after,
  });
}

const grantSummary = (g: GrantRow | null) =>
  g
    ? {
        channel: g.channel,
        allowed: g.allowed,
        monthly_fee_cents: g.monthly_fee_cents,
        pending_decision: g.pending_decision,
      }
    : null;

// ---------------------------------------------------------------------------
// Liberar / alterar taxa / revogar

export async function adminSetOwnProviderGrantFor(
  context: AdminContext,
  data: z.infer<typeof setOwnProviderGrantInput>,
): Promise<{ ok: true }> {
  await assertSuperAdmin(context.userId);
  const { data: tenant, error: tenantError } = await db()
    .from("tenants")
    .select("id")
    .eq("id", data.tenantId)
    .maybeSingle();
  if (tenantError) throw new Error(tenantError.message);
  if (!tenant) throw new Error("Casa não encontrada.");

  const before = await loadGrant(data.tenantId, data.channel);
  const now = new Date().toISOString();
  const revoking = !data.allowed && before?.allowed === true;

  let row: Record<string, unknown>;
  if (data.allowed) {
    // Liberar (ou só mudar a taxa): uma concessão já ativa mantém a data de
    // liberação; liberar de novo limpa a revogação (a conta continua como
    // está — quem a reativa é o admin da casa).
    const stillActive = before?.allowed === true;
    row = {
      tenant_id: data.tenantId,
      channel: data.channel,
      allowed: true,
      monthly_fee_cents: data.monthlyFeeCents,
      granted_at: stillActive ? before.granted_at : now,
      granted_by: stillActive ? before.granted_by : context.userId,
      revoked_at: null,
      revoked_by: null,
      pending_decision: false,
      updated_at: now,
    };
  } else if (revoking) {
    row = {
      tenant_id: data.tenantId,
      channel: data.channel,
      allowed: false,
      monthly_fee_cents: data.monthlyFeeCents,
      revoked_at: now,
      revoked_by: context.userId,
      pending_decision: true,
      updated_at: now,
    };
  } else {
    // Já não liberado (ou sem linha): só registra a taxa, sem revogação nova.
    row = {
      tenant_id: data.tenantId,
      channel: data.channel,
      allowed: false,
      monthly_fee_cents: data.monthlyFeeCents,
      updated_at: now,
    };
  }
  const { error: upsertError } = await db()
    .from("tenant_own_provider_grants")
    .upsert(row, { onConflict: "tenant_id,channel" });
  if (upsertError) throw new Error(upsertError.message);

  let disabledAccountIds: string[] = [];
  if (revoking) {
    // A conta própria do canal fica suspensa: o canal da casa pausa (a
    // ligação em tenant_channel_providers fica; nada cai na rota da BetLeads).
    const accounts = await ownedAccountsOf(data.tenantId, data.channel);
    disabledAccountIds = accounts.map((a) => a.id);
    if (disabledAccountIds.length) {
      const { error } = await db()
        .from("provider_accounts")
        .update({ status: "disabled", updated_at: now })
        .in("id", disabledAccountIds);
      if (error) throw new Error(error.message);
    }
    invalidateProviderAccountsCache();
  }

  await auditBoth({
    actorUserId: context.userId,
    tenantId: data.tenantId,
    action: revoking ? "own_provider.revoke" : "own_provider.grant",
    entityId: data.tenantId,
    before: grantSummary(before),
    after: {
      channel: data.channel,
      allowed: data.allowed,
      monthly_fee_cents: data.monthlyFeeCents,
      ...(revoking ? { pending_decision: true, disabled_account_ids: disabledAccountIds } : {}),
    },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Canal pausado por revogação: voltar para a padrão ou manter pausado

export async function adminResolveRevokedOwnProviderFor(
  context: AdminContext,
  data: z.infer<typeof resolveRevokedOwnProviderInput>,
): Promise<{ emailDomains: Array<{ hostname: string; status: string; error: string | null }> }> {
  await assertSuperAdmin(context.userId);
  const grant = await loadGrant(data.tenantId, data.channel);
  if (!grant?.pending_decision) throw new Error("Não há decisão pendente para este canal.");

  let removedAccountId: string | null = null;
  if (data.action === "use_default") {
    const { data: removed, error } = await db()
      .from("tenant_channel_providers")
      .delete()
      .eq("tenant_id", data.tenantId)
      .eq("channel", data.channel)
      .select("provider_account_id");
    if (error) throw new Error(error.message);
    removedAccountId =
      ((removed ?? []) as Array<{ provider_account_id: string }>)[0]?.provider_account_id ?? null;
    invalidateProviderAccountsCache();
  }

  const { error: grantError } = await db()
    .from("tenant_own_provider_grants")
    .update({ pending_decision: false, updated_at: new Date().toISOString() })
    .eq("tenant_id", data.tenantId)
    .eq("channel", data.channel);
  if (grantError) throw new Error(grantError.message);

  await auditBoth({
    actorUserId: context.userId,
    tenantId: data.tenantId,
    action: "own_provider.resolve",
    entityId: data.tenantId,
    before: { channel: data.channel, pending_decision: true, provider_account_id: removedAccountId },
    after: { channel: data.channel, decision: data.action, pending_decision: false },
  });

  // E-mail volta para a conta padrão: os domínios da casa mudam de conta
  // (voltam a pending com o DKIM da padrão).
  const emailDomains =
    data.action === "use_default" && data.channel === "email"
      ? (await moveEmailDomains([data.tenantId])).map(({ hostname, status, error }) => ({
          hostname,
          status,
          error,
        }))
      : [];
  return { emailDomains };
}

// ---------------------------------------------------------------------------
// Listagem

export type OwnProviderGrantView = {
  tenantId: string;
  channel: OwnProviderChannel;
  allowed: boolean;
  monthlyFeeCents: number;
  pendingDecision: boolean;
  account: {
    id: string;
    provider: "short_brasil" | "infobip";
    label: string;
    status: "active" | "disabled";
    lastCallbackAt: string | null;
    lastAcceptedSendAt: string | null;
  } | null;
  /** Concessão liberada, conta ativa e ligada ao canal da casa. */
  active: boolean;
};

export async function adminListOwnProviderGrantsFor(
  context: AdminContext,
): Promise<OwnProviderGrantView[]> {
  await assertSuperAdmin(context.userId);
  const [grants, accounts, links] = await Promise.all([
    db().from("tenant_own_provider_grants").select("*"),
    db()
      .from("provider_accounts")
      .select("id, provider, label, channels, status, owner_tenant_id, last_callback_at")
      .not("owner_tenant_id", "is", null),
    db().from("tenant_channel_providers").select("tenant_id, channel, provider_account_id"),
  ]);
  for (const result of [grants, accounts, links]) {
    if (result.error) throw new Error(result.error.message);
  }
  const accountRows = (accounts.data ?? []) as OwnedAccountRow[];
  const linkRows = (links.data ?? []) as Array<{
    tenant_id: string;
    channel: string;
    provider_account_id: string;
  }>;

  return Promise.all(
    ((grants.data ?? []) as GrantRow[]).map(async (grant): Promise<OwnProviderGrantView> => {
      const account =
        accountRows.find(
          (a) => a.owner_tenant_id === grant.tenant_id && (a.channels ?? []).includes(grant.channel),
        ) ?? null;
      const linked =
        account !== null &&
        linkRows.some(
          (l) =>
            l.tenant_id === grant.tenant_id &&
            l.channel === grant.channel &&
            l.provider_account_id === account.id,
        );
      return {
        tenantId: grant.tenant_id,
        channel: grant.channel,
        allowed: grant.allowed,
        monthlyFeeCents: Number(grant.monthly_fee_cents),
        pendingDecision: grant.pending_decision,
        account: account
          ? {
              id: account.id,
              provider: account.provider,
              label: account.label,
              status: account.status,
              lastCallbackAt: account.last_callback_at ?? null,
              lastAcceptedSendAt: await lastAcceptedSendAt(grant.tenant_id, grant.channel, account.id),
            }
          : null,
        active: grant.allowed && linked && account?.status === "active",
      };
    }),
  );
}
