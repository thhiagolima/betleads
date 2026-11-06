import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getTenantSwitcher } from "@/lib/tenants.functions";
import type { ShellRole } from "@/lib/navigation";
import type { ProviderChannel } from "@/lib/tenant-channels.shared";

export type TenantOption = {
  id: string;
  nome: string;
  slug: string;
  role: ShellRole;
  is_demo?: boolean;
  /** Moeda de exibição dos valores da casa (ISO 4217, padrão BRL). */
  moeda?: string;
  can_view_finance?: boolean;
  /** Papel na casa (HOUSE_MEMBER_ROLES) + perfil de rendimento ativo vinculado a este usuário ali. */
  has_team_profile?: boolean;
  /** Canais ligados desta casa (tenant_channels); sem linha = DEFAULT_ENABLED_CHANNELS. */
  enabled_channels?: ProviderChannel[];
};

/**
 * The active house — the one the header switcher shows and that every
 * request is scoped to (`X-Active-Tenant`). Same query key as the switcher
 * and `useIsDemoTenant`, so it is fetched once for the whole shell.
 */
export function useActiveTenant() {
  const getSwitcher = useServerFn(getTenantSwitcher);
  const query = useQuery({
    queryKey: ["active-tenant-switcher"],
    queryFn: () => getSwitcher(),
    staleTime: 60_000,
  });
  const tenants = (query.data?.tenants ?? []) as TenantOption[];
  const active = tenants.find((tenant) => tenant.id === query.data?.activeTenantId) ?? null;
  return { ...query, tenants, active };
}
