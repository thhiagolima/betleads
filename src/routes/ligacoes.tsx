import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { Phone } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui-premium";
import { SendWindowCard } from "@/components/send-window-card";
import { LigacoesPausedBanner } from "@/components/ligacoes/paused-banner";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { ScriptsTab } from "@/components/ligacoes/scripts-tab";
import { GenerateAudioTab } from "@/components/ligacoes/generate-audio-tab";
import { QueueTab } from "@/components/ligacoes/queue-tab";
import { HistoryShell } from "@/components/history/history-shell";
import { ProvidersTab } from "@/components/ligacoes/providers-tab";
import { FlowsTab } from "@/components/ligacoes/flows-tab";
import { BulkCallTab } from "@/components/ligacoes/bulk-call-tab";
import { DashboardTab } from "@/components/ligacoes/dashboard-tab";

export const Route = createFileRoute("/ligacoes")({
  head: () => ({
    meta: [
      { title: "Ligações IA — BETLEADS" },
      {
        name: "description",
        content:
          "Central de ligações com voz IA — templates de fala, geração de áudio ElevenLabs, fila e provedores.",
      },
    ],
  }),
  component: LigacoesPage,
});

const VALID_TABS = [
  "dashboard",
  "fluxos",
  "scripts",
  "massa",
  "historico",
  "configuracoes",
] as const;

function LigacoesPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const currentTab = (VALID_TABS as readonly string[]).includes(hash)
    ? hash
    : "dashboard";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={<Phone />}
        title="Ligações com Voz IA"
        subtitle="Scripts personalizados, áudio gerado em tempo real e fila pronta para qualquer provedor de telefonia."
      />

      <LigacoesPausedBanner />

      <ProvidersPausedBanner channel="call" />

      <SendWindowCard compact />

      <Tabs
        value={currentTab}
        onValueChange={(v) =>
          navigate({ to: "/ligacoes", hash: v, replace: true })
        }
        className="space-y-6"
      >
        <TabsList className="hidden">
          {VALID_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="dashboard">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="fluxos">
          <FlowsTab />
        </TabsContent>
        <TabsContent value="scripts" className="space-y-6">
          <ScriptsTab />
          <GenerateAudioTab />
        </TabsContent>
        <TabsContent value="massa">
          <BulkCallTab />
        </TabsContent>
        <TabsContent value="historico" className="space-y-6">
          <QueueTab />
          <HistoryShell
            channel="calls"
            options={{
              title: "Histórico de ligações",
              subtitle: "Tudo que foi disparado para os leads.",
              showStep: false,
              cardLabels: {
                total: "Ligações hoje",
                success: "Atendidas",
                failed: "Não atendidas / falhas",
                pending: "Pendentes",
                conversions: "Convertidas",
              },
            }}
          />
        </TabsContent>
        <TabsContent value="configuracoes">
          <ProvidersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

