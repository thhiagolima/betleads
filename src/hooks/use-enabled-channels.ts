import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getTenantSwitcher } from "@/lib/tenants.functions";
import { DEFAULT_ENABLED_CHANNELS, type ProviderChannel } from "@/lib/tenant-channels.shared";

type SwitcherData = {
  activeTenantId?: string | null;
  tenants: Array<{ id: string; enabled_channels?: ProviderChannel[] | null }>;
};

const ALL_DEFAULT_ENABLED = (Object.keys(DEFAULT_ENABLED_CHANNELS) as ProviderChannel[]).filter(
  (channel) => DEFAULT_ENABLED_CHANNELS[channel],
);

/**
 * The ACTIVE tenant's `enabled_channels` from the switcher — `undefined`
 * while the switcher hasn't loaded yet, so callers can fall back to
 * `DEFAULT_ENABLED_CHANNELS`. Pure helper so the loading/fallback logic is
 * unit-testable without mounting the hook (mirrors `isDemoTenantIn`).
 */
export function enabledChannelsIn(
  data: SwitcherData | undefined,
  loading: boolean,
): ProviderChannel[] | undefined {
  if (loading || !data) return undefined;
  const active = data.tenants.find((tenant) => tenant.id === data.activeTenantId);
  return active?.enabled_channels ?? undefined;
}

/** Whether `channel` is on, given an (possibly still-loading) enabled list. */
export function isChannelEnabledIn(
  enabled: ProviderChannel[] | undefined,
  channel: ProviderChannel,
): boolean {
  if (!enabled) return DEFAULT_ENABLED_CHANNELS[channel];
  return enabled.includes(channel);
}

/**
 * Channels the ACTIVE house has turned on (tenant-channels.shared.ts).
 * Same query key as the switcher and `useIsDemoTenant`/`useActiveTenant`, so
 * this never triggers a second fetch of `getTenantSwitcher`.
 *
 * While loading, `isEnabled` falls back to `DEFAULT_ENABLED_CHANNELS` (never
 * flashes a channel hidden that turns out to be on).
 */
export function useEnabledChannels(): {
  isEnabled: (channel: ProviderChannel) => boolean;
  enabled: ProviderChannel[];
  loading: boolean;
} {
  const getSwitcher = useServerFn(getTenantSwitcher);
  const { data, isLoading } = useQuery({
    queryKey: ["active-tenant-switcher"],
    queryFn: () => getSwitcher(),
    staleTime: 60_000,
  });

  const enabled = enabledChannelsIn(data as SwitcherData | undefined, isLoading);
  return {
    isEnabled: (channel) => isChannelEnabledIn(enabled, channel),
    enabled: enabled ?? ALL_DEFAULT_ENABLED,
    loading: isLoading,
  };
}
