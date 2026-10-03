import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { EmailAutomationFlowsPanel } from "@/routes/email";
import { consumeAutomationJourneyDraft, type AutomationJourneyDraft } from "@/lib/automation-draft";

export const Route = createFileRoute("/automacoes/email")({
  component: EmailAutomationFlowsPage,
});

function EmailAutomationFlowsPage() {
  const [draft, setDraft] = useState<AutomationJourneyDraft | null>(null);

  useEffect(() => {
    setDraft(consumeAutomationJourneyDraft("email"));
  }, []);

  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          AutomaÃ§Ãµes Â· Fluxos
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Fluxos de e-mail</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Organize condiÃ§Ãµes, etapas e mensagens automÃ¡ticas para acompanhar cada jogador.
        </p>
      </div>
      <EmailAutomationFlowsPanel initialDraft={draft} />
    </div>
  );
}
