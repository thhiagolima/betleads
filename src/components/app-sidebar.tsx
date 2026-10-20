import { Link } from "@tanstack/react-router";

import { NavLinks, NavSections } from "@/components/shell/nav-list";
import { useShellNav } from "@/components/shell/use-shell-nav";
import { SIDEBAR_FOOTER } from "@/lib/navigation";

export function Brand() {
  return (
    <Link
      to="/"
      aria-label="BETLEADS — Início"
      className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
        B
      </span>
      <span className="min-w-0 sb-collapsed:hidden">
        <span className="block truncate text-[13.5px] font-semibold leading-none">BETLEADS</span>
        <span className="mt-1 block truncate text-[9px] uppercase leading-none tracking-[0.15em] text-muted-foreground">
          Player Intelligence
        </span>
      </span>
    </Link>
  );
}

/** Desktop sidebar (md and up). On phones the same navigation lives in MobileMenu. */
export function AppSidebar({ collapsed }: { collapsed: boolean }) {
  const { sections } = useShellNav();
  return (
    <aside className="sticky top-0 z-40 hidden h-dvh w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex sb-collapsed:w-16">
      <div className="flex h-14 shrink-0 items-center px-[18px] sb-collapsed:justify-center sb-collapsed:px-0">
        <Brand />
      </div>
      <nav
        aria-label="Navegação principal"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3"
      >
        <NavSections sections={sections} collapsed={collapsed} />
      </nav>
      <nav
        aria-label="Configurações"
        className="shrink-0 border-t border-sidebar-border px-2.5 py-2"
      >
        <NavLinks items={SIDEBAR_FOOTER} collapsed={collapsed} />
      </nav>
    </aside>
  );
}
