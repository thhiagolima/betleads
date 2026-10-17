import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getTenantSwitcher } from "@/lib/tenants.functions";

/**
 * Whether the ACTIVE tenant (the one `ActiveTenantSwitcher` shows and that
 * requests are scoped to) is the demo tenant. Shares the switcher's query key
 * so this never triggers a second fetch of `getTenantSwitcher`.
 *
 * Loading / no data yet -> false, so the demo banner and disabled states
 * only appear once we actually know the tenant is demo (never flash true).
 */
export function useIsDemoTenant(): boolean {
  const getSwitcher = useServerFn(getTenantSwitcher);
  const { data } = useQuery({
    queryKey: ["active-tenant-switcher"],
    queryFn: () => getSwitcher(),
    staleTime: 60_000,
  });

  if (!data?.activeTenantId) return false;
  const active = data.tenants.find((tenant) => tenant.id === data.activeTenantId);
  return active?.is_demo === true;
}
