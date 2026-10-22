import { Link, useRouterState } from "@tanstack/react-router";

import { Brand } from "@/components/app-sidebar";
import { useShellNav } from "@/components/shell/use-shell-nav";
import { NavSections } from "@/components/shell/nav-list";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { MOBILE_TABS, activeMobileTab } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Bottom tab bar for phones: the four most used places plus the full menu. */
export function MobileTabBar({
  onOpenMenu,
  menuOpen,
}: {
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeMobileTab(pathname);

  return (
    <nav
      aria-label="Atalhos"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-sidebar-border bg-sidebar/95 px-1.5 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = tab.icon;
        const classes =
          "flex h-[60px] flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";
        if (!tab.to) {
          return (
            <button
              key={tab.title}
              type="button"
              onClick={onOpenMenu}
              aria-expanded={menuOpen}
              className={cn(classes, menuOpen ? "text-primary" : "text-muted-foreground")}
            >
              <Icon className="size-[21px]" strokeWidth={1.75} aria-hidden="true" />
              {tab.title}
            </button>
          );
        }
        const active = !menuOpen && current === tab.title;
        return (
          <Link
            key={tab.title}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            // The router would also mark parents and hash siblings as current;
            // only our single active item should be.
            activeOptions={{ exact: true, includeHash: true }}
            className={cn(classes, active ? "text-primary" : "text-muted-foreground")}
          >
            <Icon className="size-[21px]" strokeWidth={1.75} aria-hidden="true" />
            {tab.title}
          </Link>
        );
      })}
    </nav>
  );
}

/** Full menu on phones. A Radix dialog: traps focus, closes on Esc and returns focus. */
export function MobileMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { sections } = useShellNav();
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="flex w-[86vw] max-w-[320px] flex-col gap-0 border-sidebar-border bg-sidebar p-0"
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Todas as áreas do BETLEADS</SheetDescription>
        <div className="flex h-14 shrink-0 items-center px-[18px]">
          <Brand />
        </div>
        <nav
          aria-label="Navegação principal"
          className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        >
          <NavSections sections={sections} collapsed={false} onNavigate={close} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
