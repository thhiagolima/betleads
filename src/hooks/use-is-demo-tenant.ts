import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getTenantSwitcher } from "@/lib/tenants.functions";

type SwitcherData = {
  activeTenantId?: string | null;
  tenants: Array<{ id: string; is_demo?: boolean | null }>;
};

/**
 * Whether `tenantId` (or, when omitted, the ACTIVE tenant) is the demo tenant.
 * Unknown tenant or no data yet -> false: the server-side demo guard is the
 * real enforcement, this only drives disabled states.
 */
export function isDemoTenantIn(data: SwitcherData | undefined, tenantId?: string | null): boolean {
  const id = tenantId ?? data?.activeTenantId;
  if (!data || !id) return false;
  return data.tenants.find((tenant) => tenant.id === id)?.is_demo === true;
}

/**
 * Whether the ACTIVE tenant (the one `ActiveTenantSwitcher` shows and that
 * requests are scoped to) is the demo tenant. Pass `tenantId` on screens that
 * act on another house than the active one (the super admin's /tenants), so
 * the guard follows the house being edited. Shares the switcher's query key
 * so this never triggers a second fetch of `getTenantSwitcher`.
 *
 * Loading / no data yet -> false, so the demo banner and disabled states
 * only appear once we actually know the tenant is demo (never flash true).
 */
export function useIsDemoTenant(tenantId?: string | null): boolean {
  const getSwitcher = useServerFn(getTenantSwitcher);
  const { data } = useQuery({
    queryKey: ["active-tenant-switcher"],
    queryFn: () => getSwitcher(),
    staleTime: 60_000,
  });

  return isDemoTenantIn(data, tenantId);
}
