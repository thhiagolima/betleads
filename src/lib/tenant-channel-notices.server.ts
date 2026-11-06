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

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveExpertContext } from "@/lib/expert-access.server";
import { getTenantChannels } from "@/lib/tenant-channels.server";
import type { ProviderChannel } from "@/lib/tenant-channels.shared";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic Supabase query builder, same pattern as tenant-channels.server.ts. */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type PendingChannelNotice = { channel: ProviderChannel; disabledAt: string };

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
 * Canais desligados da casa cujo desligamento (tenant, channel, disabled_at)
 * este usuário ainda não confirmou. `[]` para o super admin.
 */
export async function getPendingChannelNoticesFor(
  userId: string,
  tenantId: string,
): Promise<PendingChannelNotice[]> {
  if (await isSuperAdmin(userId)) return [];

  const channels = await getTenantChannels(tenantId);
  const disabled = (Object.entries(channels) as Array<
    [ProviderChannel, { enabled: boolean; disabledAt: string | null }]
  >).filter(([, state]) => !state.enabled && state.disabledAt);
  if (disabled.length === 0) return [];

  const { data: acks, error } = await db()
    .from("tenant_channel_notice_acks")
    .select("channel, disabled_at")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .in("channel", disabled.map(([channel]) => channel));
  if (error) throw new Error(error.message);

  const ackedKeys = new Set(
    ((acks ?? []) as Array<{ channel: string; disabled_at: string }>).map(
      (row) => `${row.channel}:${row.disabled_at}`,
    ),
  );

  return disabled
    .filter(([channel, state]) => !ackedKeys.has(`${channel}:${state.disabledAt}`))
    .map(([channel, state]) => ({ channel, disabledAt: state.disabledAt as string }));
}

/** Confirma ("Ciente") um desligamento; recusa se o usuário não tem acesso à casa. */
export async function ackChannelNoticeFor(
  userId: string,
  data: { tenantId: string; channel: ProviderChannel; disabledAt: string },
): Promise<void> {
  if (!(await hasHouseAccess(userId, data.tenantId))) {
    throw new Error("Sem acesso a esta casa.");
  }

  const { error } = await db()
    .from("tenant_channel_notice_acks")
    .upsert(
      {
        user_id: userId,
        tenant_id: data.tenantId,
        channel: data.channel,
        disabled_at: data.disabledAt,
      },
      { onConflict: "user_id,tenant_id,channel,disabled_at" },
    );
  if (error) throw new Error(error.message);
}
