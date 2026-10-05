import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ProviderAuthBanner } from "@/components/provider-auth-banner";
import { TenantStatusGate } from "@/components/tenant-status-gate";
import { SidebarToggle } from "@/components/ui/sidebar";
import { WhatsappNotifier } from "@/components/whatsapp-notifier";
import { ActiveTenantSwitcher } from "@/components/active-tenant-switcher";
import { useGlobalRealtimeStatus } from "@/hooks/use-realtime-invalidate";

const titles: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Início", subtitle: "Visão geral em tempo real" },
  "/players": { title: "Jogadores", subtitle: "Base completa de jogadores" },
  "/midia-ltv": { title: "Aquisição e LTV", subtitle: "ROI por criativo, campanha e público" },
  "/inteligencia": {
    title: "Assistente IA",
    subtitle: "Pergunte qualquer coisa sobre seus players",
  },
  "/treino-ia": { title: "Configurar IA", subtitle: "Ensine a inteligência com exemplos reais" },
  "/alertas": { title: "Oportunidades", subtitle: "Jogadores que precisam de atenção" },
  "/gamificacao": {
    title: "Níveis e fidelização",
    subtitle: "Classificação e comportamento dos jogadores",
  },
  "/regras": {
    title: "Níveis e fidelização",
    subtitle: "Classificação e comportamento dos jogadores",
  },
  "/whatsapp": { title: "WhatsApp", subtitle: "Sessões, fluxos e inbox em tempo real" },
  "/sms": { title: "SMS", subtitle: "Disparos em massa e automações por SMS" },
  "/campanhas": { title: "Campanhas", subtitle: "Disparos segmentados e resultados" },
  "/creditos-sms": { title: "Créditos SMS", subtitle: "Saldo, pedidos e extrato de consumo" },
  "/email": { title: "Email", subtitle: "Campanhas e fluxos de email" },
  "/ligacoes": { title: "Voz", subtitle: "Áudios, chamadas e provedores" },
  "/eventos": { title: "Eventos", subtitle: "Timeline de atividades em tempo real" },
  "/webhooks": { title: "Integrações", subtitle: "Conexão com sua plataforma de apostas" },
  "/configuracoes": { title: "Configurações", subtitle: "Preferências da plataforma" },
  "/admin": { title: "Super Admin", subtitle: "Usuários, métricas e billing da plataforma" },
  "/tenants": { title: "Conta e equipe", subtitle: "Usuários, saldo e auditoria" },
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarPreferenceLoaded, setSidebarPreferenceLoaded] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncViewport = () => setIsMobile(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    const savedPreference = window.localStorage.getItem("betleads:sidebar-collapsed");
    if (savedPreference !== null) setSidebarCollapsed(savedPreference === "true");
    setSidebarPreferenceLoaded(true);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (sidebarPreferenceLoaded && !isMobile) {
      window.localStorage.setItem("betleads:sidebar-collapsed", String(sidebarCollapsed));
    }
  }, [isMobile, sidebarCollapsed, sidebarPreferenceLoaded]);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);
  const key = Object.keys(titles).find((k) =>
    k === "/" ? pathname === "/" : pathname.startsWith(k),
  );
  const meta = key ? titles[key] : { title: "BETLEADS", subtitle: "" };
  const rt = useGlobalRealtimeStatus();
  const rtMeta =
    rt === "active"
      ? { dot: "bg-emerald-400 pulse-realtime", label: "Realtime ativo" }
      : rt === "connecting"
        ? { dot: "bg-amber-400 animate-pulse", label: "Conectando..." }
        : rt === "offline"
          ? { dot: "bg-rose-500", label: "Offline" }
          : { dot: "bg-muted-foreground/60", label: "Em espera" };

  return (
    <div className="flex min-h-screen w-full bg-app-gradient">
      {isMobile && mobileSidebarOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <AppSidebar
        collapsed={isMobile ? false : sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        mobile={isMobile}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      <div
        aria-hidden="true"
        className="hidden shrink-0 transition-[width] duration-200 ease-out md:block"
        style={{ width: sidebarCollapsed ? 60 : 244 }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl sm:px-5">
          <SidebarToggle
            collapsed={isMobile ? !mobileSidebarOpen : sidebarCollapsed}
            onToggle={() =>
              isMobile
                ? setMobileSidebarOpen((open) => !open)
                : setSidebarCollapsed((collapsed) => !collapsed)
            }
          />
          <div className="flex min-w-0 flex-col leading-tight">
            <p className="truncate text-base font-semibold tracking-tight">{meta.title}</p>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">
              {meta.subtitle}
            </p>
          </div>
          <ActiveTenantSwitcher />
          <div className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-border/60 bg-card/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            <span className={`h-1.5 w-1.5 rounded-full ${rtMeta.dot}`} />
            <span className="hidden text-foreground/80 sm:inline">{rtMeta.label}</span>
          </div>
        </header>
        <ProviderAuthBanner />
        <WhatsappNotifier />
        <main
          aria-label={meta.title}
          className="flex-1 overflow-x-hidden p-4 animate-fade-in sm:p-6"
        >
          <TenantStatusGate>{children}</TenantStatusGate>
        </main>
      </div>
    </div>
  );
}
