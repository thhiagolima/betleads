import { useActiveTenant } from "@/hooks/use-active-tenant";
import { visibleSections } from "@/lib/navigation";

/** Role of the active house and the menu sections it may see. */
export function useShellNav() {
  const { active } = useActiveTenant();
  const role = active?.role ?? null;
  const isSuperAdmin = role === "super_admin";
  return {
    role,
    isSuperAdmin,
    sections: visibleSections(role, isSuperAdmin, active?.can_view_finance),
  };
}
