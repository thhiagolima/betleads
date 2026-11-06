// Web push (OneSignal) — Task 12: the "Web Push" tab of Integrações
// (src/routes/webhooks.tsx). Loads `getWebpushIntegrationFn` and renders,
// depending on the house's state: no app at all (the house's or the super
// admin's activation block), the 4-step assistant, or — once the pipeline
// has been proven end to end — a per-origin summary. The super admin's
// block (manage origins, add a domain) is always shown to a super admin,
// independent of whether a "current" app already exists.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Skeleton } from "@/components/ui/skeleton";
import { DataCard } from "@/components/ui-premium/data-card";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { getWebpushIntegrationFn } from "@/lib/webpush/webpush.functions";
import { WEBPUSH_INTEGRATION_QUERY_KEY } from "@/components/webpush/webpush-query";
import {
  CompletedSummaryView,
  isWizardComplete,
  WebpushNotActivatedView,
  WebpushSetupWizard,
} from "@/components/webpush/webpush-setup-wizard";
import { WebpushPromptForm } from "@/components/webpush/webpush-prompt-form";
import { WebpushSuperAdminBlock } from "@/components/webpush/webpush-super-admin-block";

const INNER_TABS = [
  { value: "assistente", label: "Assistente" },
  { value: "convite", label: "Convite" },
] as const;
type InnerTab = (typeof INNER_TABS)[number]["value"];

export type RedoEvent = { type: "redo" } | { type: "test-sent" };

/**
 * "Refazer verificação" hides the completed summary (`redoing: true`) so
 * the wizard shows again; a fresh successful test push (`test-sent`) is
 * exactly the signal that the house has proven the pipeline again, so it
 * clears `redoing` and lets the summary reappear. Any other progress event
 * (worker verified, script confirmed) leaves `redoing` untouched — those
 * alone don't mean the house is done again.
 */
export function reduceRedoing(current: boolean, event: RedoEvent): boolean {
  if (event.type === "redo") return true;
  if (event.type === "test-sent") return false;
  return current;
}

export function WebpushIntegrationPanel() {
  const qc = useQueryClient();
  const fetchIntegration = useServerFn(getWebpushIntegrationFn);
  const { isSuperAdmin } = useIsSuperAdmin();
  const [innerTab, setInnerTab] = useState<InnerTab>("assistente");
  const [redoing, setRedoing] = useState(false);

  const query = useQuery({
    queryKey: WEBPUSH_INTEGRATION_QUERY_KEY,
    queryFn: () => fetchIntegration(),
  });

  function onProgress(opts?: { testSent?: boolean }) {
    qc.invalidateQueries({ queryKey: WEBPUSH_INTEGRATION_QUERY_KEY });
    if (opts?.testSent) setRedoing((r) => reduceRedoing(r, { type: "test-sent" }));
  }

  if (query.isLoading || !query.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  const data = query.data;
  const current = data.current;
  const complete = current ? isWizardComplete(current) && !redoing : false;

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageTabs
        label="Web Push"
        value={innerTab}
        onValueChange={setInnerTab}
        items={INNER_TABS}
      />

      {innerTab === "assistente" && (
        <>
          {!current && !isSuperAdmin && <WebpushNotActivatedView />}

          {current && (
            <DataCard
              title="Ativação do Web Push"
              description={current.origin}
            >
              {complete ? (
                <CompletedSummaryView
                  apps={data.apps.map((app) => ({
                    id: app.id,
                    origin: app.origin,
                    status: app.status,
                    activeSubscriptions: app.activeSubscriptions,
                    identifiedSubscriptions: app.identifiedSubscriptions,
                  }))}
                  onRedo={() => setRedoing((r) => reduceRedoing(r, { type: "redo" }))}
                />
              ) : (
                <WebpushSetupWizard
                  app={{
                    id: current.id,
                    origin: current.origin,
                    workerUrl: `${current.origin}/push/onesignal/OneSignalSDKWorker.js`,
                    workerVerifiedAt: current.workerVerifiedAt,
                    scriptSeenAt: current.scriptSeenAt,
                    playerLinkedAt: current.playerLinkedAt,
                    testSentAt: current.testSentAt,
                  }}
                  loaderSnippet={data.loaderSnippet}
                  playerSnippet={data.playerSnippet}
                  onProgress={onProgress}
                  onCheckScript={() => query.refetch()}
                />
              )}
            </DataCard>
          )}

          {isSuperAdmin && (
            <WebpushSuperAdminBlock
              tenantId={data.tenantId}
              siteUrl={data.siteUrl}
              apps={data.apps.map((app) => ({ id: app.id, origin: app.origin, status: app.status }))}
            />
          )}
        </>
      )}

      {innerTab === "convite" && (
        <DataCard title="Convite" description="Texto e aparência do pedido de permissão.">
          <WebpushPromptForm prompt={data.prompt} canEdit={data.canEdit} />
        </DataCard>
      )}
    </div>
  );
}
