// Task 10: aviso "Ciente" quando um canal da casa é desligado. Design:
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md,
// §4.
//
// `tenant_channels.disabled_at` marca o desligamento mais recente de um
// canal; `tenant_channel_notice_acks` guarda, por usuário, quais
// (tenant, channel, disabled_at) já foram confirmados. Religar e desligar
// de novo gera um disabled_at novo, então o aviso volta a aparecer. O super
// admin nunca vê o aviso (entra na casa pelo seletor, mas não é "pessoal da
// casa").
//
// Conta própria (Task 11): a revogação da concessão de um canal pausa a conta
// própria da casa; o aviso `own_revoked` reaproveita a mesma tabela de acks
// com channel "own:<canal>" e disabled_at = tenant_own_provider_grants.revoked_at
// (revogar de novo gera um revoked_at novo, e o aviso volta). Aparece enquanto
// a concessão está revogada e a casa ainda está pausada por isso: decisão
// pendente, ou "manter pausado" (o link continua apontando para a conta
// desativada). Depois de "usar a padrão" (sem decisão pendente, sem pausa) não
// aparece mais.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveExpertContext } from "@/lib/expert-access.server";
import { getTenantChannels } from "@/lib/tenant-channels.server";
import { ownAccountPausedByRevocation } from "@/lib/provider-accounts.server";
import type { ProviderChannel } from "@/lib/tenant-channels.shared";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic Supabase query builder, same pattern as tenant-channels.server.ts. */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ChannelNoticeKind = "disabled" | "own_revoked";

/**
 * `disabled`: canal desligado para a casa (disabledAt = tenant_channels.disabled_at).
 * `own_revoked`: conta própria do canal pausada pela revogação
 * (disabledAt = tenant_own_provider_grants.revoked_at).
 */
export type PendingChannelNotice = {
  kind: ChannelNoticeKind;
  channel: ProviderChannel;
  disabledAt: string;
};

const OWN_PROVIDER_CHANNELS: ReadonlySet<ProviderChannel> = new Set(["sms", "email", "voice"]);

/** Canal gravado em tenant_channel_notice_acks para o tipo de aviso. */
function ackChannelKey(kind: ChannelNoticeKind, channel: ProviderChannel): string {
  return kind === "own_revoked" ? `own:${channel}` : channel;
}

/** Concessões revogadas cujo canal continua pausado (decisão pendente ou "manter pausado"). */
async function revokedOwnNotices(
  tenantId: string,
): Promise<Array<{ channel: ProviderChannel; disabledAt: string }>> {
  const { data, error } = await db()
    .from("tenant_own_provider_grants")
    .select("channel, allowed, revoked_at, pending_decision")
    .eq("tenant_id", tenantId)
    .eq("allowed", false);
  if (error) throw new Error(error.message);
  const out: Array<{ channel: ProviderChannel; disabledAt: string }> = [];
  for (const row of (data ?? []) as Array<{
    channel: ProviderChannel;
    revoked_at: string | null;
    pending_decision: boolean | null;
  }>) {
    if (!row.revoked_at || !OWN_PROVIDER_CHANNELS.has(row.channel)) continue;
    const paused =
      row.pending_decision === true ||
      (await ownAccountPausedByRevocation(tenantId, row.channel as "sms" | "email" | "voice"));
    if (paused) out.push({ channel: row.channel, disabledAt: row.revoked_at });
  }
  return out;
}

async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data, error } = await db().rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return !!data;
}

/** Acesso à casa: `has_tenant_access` (admin/gestor/member) ou expert dela. */
async function hasHouseAccess(userId: string, tenantId: string): Promise<boolean> {
  const { data, error } = await db().rpc("has_tenant_access", {
    _tenant_id: tenantId,
    _user_id: userId,
  });
  if (error) throw new Error(error.message);
  if (data) return true;
  const expertCtx = await resolveExpertContext(userId, tenantId);
  return expertCtx !== null;
}

/**
 * Avisos da casa que este usuário ainda não confirmou: canais desligados
 * (tenant, channel, disabled_at) e contas próprias pausadas pela revogação
 * (tenant, "own:<canal>", revoked_at). `[]` para o super admin.
 */
export async function getPendingChannelNoticesFor(
  userId: string,
  tenantId: string,
): Promise<PendingChannelNotice[]> {
  if (await isSuperAdmin(userId)) return [];

  const channels = await getTenantChannels(tenantId);
  const candidates: PendingChannelNotice[] = [
    ...(Object.entries(channels) as Array<
      [ProviderChannel, { enabled: boolean; disabledAt: string | null }]
    >)
      .filter(([, state]) => !state.enabled && state.disabledAt)
      .map(([channel, state]) => ({
        kind: "disabled" as const,
        channel,
        disabledAt: state.disabledAt as string,
      })),
    ...(await revokedOwnNotices(tenantId)).map((notice) => ({
      kind: "own_revoked" as const,
      ...notice,
    })),
  ];
  if (candidates.length === 0) return [];

  const { data: acks, error } = await db()
    .from("tenant_channel_notice_acks")
    .select("channel, disabled_at")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .in("channel", candidates.map((notice) => ackChannelKey(notice.kind, notice.channel)));
  if (error) throw new Error(error.message);

  // Compared as instants: the ack's disabled_at comes back from timestamptz
  // in Postgres' own format, not necessarily the one the source column used.
  const ackedKeys = new Set(
    ((acks ?? []) as Array<{ channel: string; disabled_at: string }>).map(
      (row) => `${row.channel}|${Date.parse(row.disabled_at)}`,
    ),
  );

  return candidates.filter(
    (notice) =>
      !ackedKeys.has(
        `${ackChannelKey(notice.kind, notice.channel)}|${Date.parse(notice.disabledAt)}`,
      ),
  );
}

/**
 * Confirma ("Ciente") um aviso; recusa se o usuário não tem acesso à casa.
 * `kind` ausente = `disabled` (clientes de antes da Task 11).
 */
export async function ackChannelNoticeFor(
  userId: string,
  data: {
    tenantId: string;
    kind?: ChannelNoticeKind;
    channel: ProviderChannel;
    disabledAt: string;
  },
): Promise<void> {
  const kind = data.kind ?? "disabled";
  if (kind === "own_revoked" && !OWN_PROVIDER_CHANNELS.has(data.channel)) {
    throw new Error("Canal sem conta própria.");
  }
  if (!(await hasHouseAccess(userId, data.tenantId))) {
    throw new Error("Sem acesso a esta casa.");
  }

  const { error } = await db()
    .from("tenant_channel_notice_acks")
    .upsert(
      {
        user_id: userId,
        tenant_id: data.tenantId,
        channel: ackChannelKey(kind, data.channel),
        disabled_at: data.disabledAt,
      },
      { onConflict: "user_id,tenant_id,channel,disabled_at" },
    );
  if (error) throw new Error(error.message);
}
