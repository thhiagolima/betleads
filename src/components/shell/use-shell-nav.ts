import { useRouterState } from "@tanstack/react-router";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import { GROUP_SECTIONS, isGroupPath, visibleSections } from "@/lib/navigation";

/** Role of the active house and the menu sections it may see; swaps to the
 * group menu while on a /grupo* route (Task 7, spec §4). */
export function useShellNav() {
  const { active } = useActiveTenant();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const role = active?.role ?? null;
  const isSuperAdmin = role === "super_admin";
  return {
    role,
    isSuperAdmin,
    sections: isGroupPath(pathname)
      ? GROUP_SECTIONS
      : visibleSections(role, isSuperAdmin, active?.can_view_finance),
  };
}
