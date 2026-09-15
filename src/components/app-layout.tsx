import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useRouterState } from "@tanstack/react-router";
import { useGlobalRealtimeStatus } from "@/hooks/use-realtime-invalidate";
import { ProviderAuthBanner } from "@/components/provider-auth-banner";
import { WhatsappNotifier } from "@/components/whatsapp-notifier";

const titles: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Dashboard", subtitle: "Visão geral em tempo real" },
  "/players": { title: "Players", subtitle: "Base completa de jogadores" },
  "/inteligencia": { title: "Inteligência IA", subtitle: "Pergunte qualquer coisa sobre seus players" },
  "/treino-ia": { title: "Treino IA", subtitle: "Ensine a inteligência com exemplos reais" },
  "/alertas": { title: "Alertas", subtitle: "Central de recuperação de receita" },
  "/regras": { title: "Regras", subtitle: "Os 12 gatilhos inteligentes da plataforma" },
  "/whatsapp": { title: "WhatsApp", subtitle: "Sessões, fluxos e inbox em tempo real" },
  "/sms": { title: "SMS", subtitle: "Disparos em massa e automações por SMS" },
  "/email": { title: "Email", subtitle: "Campanhas e fluxos de email — em breve" },
  "/ligacoes": { title: "Ligações", subtitle: "Discador e call center — em breve" },
  "/eventos": { title: "Eventos", subtitle: "Timeline de atividades em tempo real" },
  "/webhooks": { title: "Webhooks", subtitle: "Integração com sua casa de aposta" },
  "/configuracoes": { title: "Configurações", subtitle: "Preferências da plataforma" },
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
        ? { dot: "bg-amber-400 animate-pulse", label: "Conectando…" }
        : rt === "offline"
          ? { dot: "bg-rose-500", label: "Offline" }
          : { dot: "bg-muted-foreground/60", label: "Em espera" };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-app-gradient">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b border-border/60 flex items-center gap-3 px-4 sm:px-5 sticky top-0 z-30 bg-background/70 backdrop-blur-xl">
            <SidebarTrigger />
            <div className="flex flex-col leading-tight min-w-0">
              <h1 className="text-base font-semibold tracking-tight truncate">{meta.title}</h1>
              <p className="text-xs text-muted-foreground truncate hidden sm:block">{meta.subtitle}</p>
            </div>
            <div className="ml-auto flex items-center gap-2 rounded-full border border-border/60 bg-card/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur shrink-0">
              <span className={`h-1.5 w-1.5 rounded-full ${rtMeta.dot}`} />
              <span className="text-foreground/80 hidden sm:inline">{rtMeta.label}</span>
            </div>
          </header>
          <ProviderAuthBanner />
          <WhatsappNotifier />
          <main className="flex-1 p-4 sm:p-6 overflow-x-hidden animate-fade-in">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}