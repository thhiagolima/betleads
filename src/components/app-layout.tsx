import { useRouterState } from "@tanstack/react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { ProviderAuthBanner } from "@/components/provider-auth-banner";
import { TenantStatusGate } from "@/components/tenant-status-gate";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { WhatsappNotifier } from "@/components/whatsapp-notifier";
import { useGlobalRealtimeStatus } from "@/hooks/use-realtime-invalidate";

const titles: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Dashboard", subtitle: "Visão geral em tempo real" },
  "/players": { title: "Players", subtitle: "Base completa de jogadores" },
  "/midia-ltv": { title: "Mídia e LTV", subtitle: "ROI por criativo, campanha e público" },
  "/inteligencia": {
    title: "Inteligência IA",
    subtitle: "Pergunte qualquer coisa sobre seus players",
  },
  "/treino-ia": { title: "Treino IA", subtitle: "Ensine a inteligência com exemplos reais" },
  "/alertas": { title: "Alertas", subtitle: "Central de recuperação de receita" },
  "/gamificacao": { title: "Gamificação", subtitle: "Níveis, VIPs parados e faixas por tenant" },
  "/regras": { title: "Gamificação", subtitle: "Níveis, VIPs parados e faixas por tenant" },
  "/whatsapp": { title: "WhatsApp", subtitle: "Sessões, fluxos e inbox em tempo real" },
  "/sms": { title: "SMS", subtitle: "Disparos em massa e automações por SMS" },
  "/creditos-sms": { title: "Créditos SMS", subtitle: "Saldo, pedidos e extrato de consumo" },
  "/email": { title: "Email", subtitle: "Campanhas e fluxos de email" },
  "/ligacoes": { title: "Ligações", subtitle: "Discador e call center" },
  "/eventos": { title: "Eventos", subtitle: "Timeline de atividades em tempo real" },
  "/webhooks": { title: "Webhooks", subtitle: "Integração com sua casa de aposta" },
  "/configuracoes": { title: "Configurações", subtitle: "Preferências da plataforma" },
  "/admin": { title: "Super Admin", subtitle: "Usuários, métricas e billing da plataforma" },
  "/tenants": { title: "Tenants", subtitle: "Conta, usuarios, saldo e auditoria" },
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
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
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-app-gradient">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl sm:px-5">
            <SidebarTrigger />
            <div className="flex min-w-0 flex-col leading-tight">
              <h1 className="truncate text-base font-semibold tracking-tight">{meta.title}</h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                {meta.subtitle}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-border/60 bg-card/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
              <span className={`h-1.5 w-1.5 rounded-full ${rtMeta.dot}`} />
              <span className="hidden text-foreground/80 sm:inline">{rtMeta.label}</span>
            </div>
          </header>
          <ProviderAuthBanner />
          <WhatsappNotifier />
          <main className="flex-1 overflow-x-hidden p-4 animate-fade-in sm:p-6">
            <TenantStatusGate>{children}</TenantStatusGate>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
