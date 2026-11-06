// Per-house channel state (sms/email/voice/webpush). Design:
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md.
//
// Sem linha em tenant_channels, a casa usa DEFAULT_ENABLED_CHANNELS
// (sms/email/voice ligados, webpush desligado). Falha ao LER a tabela (erro
// de banco) usa o último snapshot carregado e, sem nenhum, o padrão — mesmo
// padrão de cache do provider-accounts.server.ts (snapshot + TTL de
// PROVIDER_ACCOUNTS_CACHE_MS, último valor em caso de erro).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PROVIDER_ACCOUNTS_CACHE_MS } from "./provider-accounts.server";
import { DEFAULT_ENABLED_CHANNELS, CHANNEL_DISABLED_MESSAGE, type ProviderChannel } from "./tenant-channels.shared";

export type TenantChannelState = { enabled: boolean; disabledAt: string | null };

type TenantChannelRow = {
  tenant_id: string;
  channel: string;
  enabled: boolean;
  disabled_at: string | null;
};

type Snapshot = {
  /** `${tenantId}:${channel}` -> state */
  rows: Map<string, TenantChannelState>;
  loadedAt: number;
};

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot | null> | null = null;

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

function defaultState(channel: ProviderChannel): TenantChannelState {
  return { enabled: DEFAULT_ENABLED_CHANNELS[channel], disabledAt: null };
}

async function loadSnapshot(): Promise<Snapshot> {
  const { data, error } = await db().from("tenant_channels").select(
    "tenant_id, channel, enabled, disabled_at",
  );
  if (error) throw new Error(error.message);
  const rows = new Map<string, TenantChannelState>();
  for (const row of (data ?? []) as TenantChannelRow[]) {
    rows.set(`${row.tenant_id}:${row.channel}`, {
      enabled: row.enabled,
      disabledAt: row.disabled_at,
    });
  }
  return { rows, loadedAt: Date.now() };
}

async function currentSnapshot(): Promise<Snapshot | null> {
  if (snapshot && Date.now() - snapshot.loadedAt < PROVIDER_ACCOUNTS_CACHE_MS) return snapshot;
  if (!loading) {
    loading = loadSnapshot()
      .then((next) => {
        snapshot = next;
        return next;
      })
      .catch((error) => {
        console.error("[tenant-channels] falha ao carregar canais; usando o último snapshot", {
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

/**
 * Drops this instance's snapshot (after a super admin change). Other server
 * instances pick the change up within PROVIDER_ACCOUNTS_CACHE_MS. With a
 * tenantId, only invalidates in the sense of the next read being forced
 * fresh — the snapshot is global (small table), so it drops the whole
 * snapshot either way.
 */
export function invalidateTenantChannelsCache(_tenantId?: string) {
  snapshot = null;
  loading = null;
}

export const __resetTenantChannelsCacheForTests = () => invalidateTenantChannelsCache();

/** Estado dos 4 canais da casa (padrão quando não há linha ou snapshot). */
export async function getTenantChannels(
  tenantId: string,
): Promise<Record<ProviderChannel, TenantChannelState>> {
  const snap = await currentSnapshot();
  const channels: ProviderChannel[] = ["sms", "email", "voice", "webpush"];
  const result = {} as Record<ProviderChannel, TenantChannelState>;
  for (const channel of channels) {
    const row = snap?.rows.get(`${tenantId}:${channel}`);
    result[channel] = row ?? defaultState(channel);
  }
  return result;
}

/** Canal ligado para a casa. `tenantId` null (envios sem casa) é sempre true. */
export async function isChannelEnabled(
  tenantId: string | null,
  channel: ProviderChannel,
): Promise<boolean> {
  if (!tenantId) return true;
  const snap = await currentSnapshot();
  const row = snap?.rows.get(`${tenantId}:${channel}`);
  return (row ?? defaultState(channel)).enabled;
}

/** Canal desligado pela casa (checagem antes de reservar crédito). */
export class ChannelDisabledError extends Error {
  channel: ProviderChannel;
  constructor(channel: ProviderChannel) {
    super(CHANNEL_DISABLED_MESSAGE(channel));
    this.name = "ChannelDisabledError";
    this.channel = channel;
  }
}

/** Lança ChannelDisabledError quando o canal está desligado para a casa. */
export async function assertChannelEnabled(
  tenantId: string | null,
  channel: ProviderChannel,
): Promise<void> {
  if (!(await isChannelEnabled(tenantId, channel))) {
    throw new ChannelDisabledError(channel);
  }
}
