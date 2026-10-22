import { useRouterState } from "@tanstack/react-router";
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ActiveTenantSwitcher } from "@/components/active-tenant-switcher";
import { BillingBanner } from "@/components/billing/billing-banner";
import { DemoBanner } from "@/components/demo-banner";
import { ProviderAuthBanner } from "@/components/provider-auth-banner";
import { AccountMenu } from "@/components/shell/account-menu";
import { MobileMenu, MobileTabBar } from "@/components/shell/mobile-nav";
import { useSidebarCollapsed } from "@/components/shell/sidebar-collapse";
import { useShellNav } from "@/components/shell/use-shell-nav";
import { TenantStatusGate } from "@/components/tenant-status-gate";
import { useGlobalRealtimeStatus } from "@/hooks/use-realtime-invalidate";
import { resolveRouteMeta } from "@/lib/navigation";
import { cn } from "@/lib/utils";

function RealtimeIndicator() {
  const rt = useGlobalRealtimeStatus();
  const meta =
    rt === "active"
      ? { dot: "bg-emerald-400 pulse-realtime", label: "Ao vivo" }
      : rt === "connecting"
        ? { dot: "bg-amber-400 animate-pulse", label: "Conectando…" }
        : rt === "offline"
          ? { dot: "bg-rose-500", label: "Offline" }
          : { dot: "bg-muted-foreground/60", label: "Em espera" };
  return (
    <span
      role="status"
      aria-label={`Tempo real: ${meta.label}`}
      className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-border px-3 text-xs text-foreground/80"
    >
      <span className={cn("size-1.5 rounded-full", meta.dot)} aria-hidden="true" />
      <span className="hidden sm:inline">{meta.label}</span>
    </span>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { collapsed, toggle } = useSidebarCollapsed();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const meta = resolveRouteMeta(pathname);
  const { role } = useShellNav();

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.title = meta.title === "BETLEADS" ? "BETLEADS" : `${meta.title} · BETLEADS`;
  }, [meta.title]);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="flex min-h-dvh w-full bg-app-gradient">
      <AppSidebar collapsed={collapsed} />
      <MobileMenu open={menuOpen} onOpenChange={setMenuOpen} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/60 bg-background/80 px-4 backdrop-blur-xl sm:gap-3 md:px-6">
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            className="hidden size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:flex"
          >
            <ToggleIcon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <nav aria-label="Você está em" className="flex min-w-0 items-center gap-2 text-[13.5px]">
            <span className="hidden shrink-0 text-muted-foreground md:inline">{meta.section}</span>
            <ChevronRight
              className="hidden size-3.5 shrink-0 text-muted-foreground md:block"
              aria-hidden="true"
            />
            <span className="truncate text-[15px] font-semibold md:text-[13.5px] md:font-medium">
              {meta.title}
            </span>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div className="min-w-0 md:hidden">
              <ActiveTenantSwitcher compact />
            </div>
            <div className="hidden min-w-0 md:block">
              <ActiveTenantSwitcher />
            </div>
            <RealtimeIndicator />
            <AccountMenu role={role} />
          </div>
        </header>
        <BillingBanner />
        <DemoBanner />
        <ProviderAuthBanner />
        <main
          aria-label={meta.title}
          className="flex-1 overflow-x-hidden p-4 pb-[calc(76px+env(safe-area-inset-bottom))] animate-fade-in sm:p-6 sm:pb-[calc(76px+env(safe-area-inset-bottom))] md:pb-6"
        >
          <TenantStatusGate>{children}</TenantStatusGate>
        </main>
      </div>

      <MobileTabBar menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
    </div>
  );
}
