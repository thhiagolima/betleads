import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { ChannelPage } from "@/components/channels/channel-page";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WebpushHistoryTab,
  WebpushNotInstalledState,
  WebpushOverviewTab,
} from "@/components/webpush/webpush-channel-tabs";
import { WEBPUSH_INTEGRATION_QUERY_KEY } from "@/components/webpush/webpush-query";
import { useEnabledChannels } from "@/hooks/use-enabled-channels";
import { getWebpushIntegrationFn } from "@/lib/webpush/webpush.functions";

export const Route = createFileRoute("/webpush")({
  component: WebpushPage,
});

// House-only, like the composer's web push tab: the expert shell never links
// here and sends any non-expert route back to /expert. #configuracoes
// redirects to Integrações > Web Push (see channel-tabs).
function WebpushPage() {
  const { isEnabled } = useEnabledChannels();
  const integrationFn = useServerFn(getWebpushIntegrationFn);
  const integration = useQuery({
    queryKey: WEBPUSH_INTEGRATION_QUERY_KEY,
    queryFn: () => integrationFn(),
    enabled: isEnabled("webpush"),
  });

  // "Nova campanha" only once an app is installing/active (same check as the composer).
  const notReady = integration.isLoading ? (
    <Skeleton className="h-48 w-full rounded-2xl" />
  ) : integration.data && !integration.data.enabled ? (
    <WebpushNotInstalledState />
  ) : undefined;

  return (
    <ChannelPage
      channel="webpush"
      subtitle="Notificações no navegador: inscrições, envios, cliques e campanhas."
      notReady={notReady}
    >
      {(tab, setTab) =>
        tab === "historico" ? (
          <WebpushHistoryTab />
        ) : (
          <WebpushOverviewTab onOpenHistory={() => setTab("historico")} />
        )
      }
    </ChannelPage>
  );
}
