import { createFileRoute } from "@tanstack/react-router";

import { ChannelPage } from "@/components/channels/channel-page";
import { HistoryShell } from "@/components/history/history-shell";
import { BulkCallTab } from "@/components/ligacoes/bulk-call-tab";
import { DashboardTab } from "@/components/ligacoes/dashboard-tab";
import { QueueTab } from "@/components/ligacoes/queue-tab";
import { ScriptsTab } from "@/components/ligacoes/scripts-tab";
import { VoiceAssetsTab } from "@/components/ligacoes/voice-assets-tab";

export const Route = createFileRoute("/ligacoes")({
  component: LigacoesPage,
});

// Fluxos de voz moved to Automações; #fluxos redirects there (see channel-tabs).
function LigacoesPage() {
  return (
    <ChannelPage
      channel="voz"
      subtitle="Ligações com áudio gravado ou voz gerada: envios, fila e histórico."
    >
      {(tab) => {
        if (tab === "massa") return <BulkCallTab />;
        if (tab === "audios")
          return (
            <div className="space-y-6">
              <VoiceAssetsTab />
              <ScriptsTab />
            </div>
          );
        if (tab === "historico")
          return (
            <div className="space-y-6">
              <QueueTab />
              <HistoryShell
                channel="calls"
                options={{
                  subtitle: "Todas as ligações feitas para os jogadores.",
                  showStep: false,
                  cardLabels: {
                    total: "Ligações",
                    success: "Atendidas",
                    failed: "Não atendidas / falhas",
                    pending: "Pendentes",
                    conversions: "Convertidas",
                  },
                }}
              />
            </div>
          );
        return <DashboardTab />;
      }}
    </ChannelPage>
  );
}
