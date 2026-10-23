import { useActiveTenant } from "@/hooks/use-active-tenant";
import { visibleSections } from "@/lib/navigation";

/** Role of the active house and the menu sections it may see. */
export function useShellNav() {
  const { active, isLoading } = useActiveTenant();
  const role = active?.role ?? null;
  const isSuperAdmin = role === "super_admin";
  return {
    role,
    /** True while the switcher query that resolves `role` is still loading. */
    roleLoading: isLoading,
    isSuperAdmin,
    sections: visibleSections(role, isSuperAdmin),
  };
}
