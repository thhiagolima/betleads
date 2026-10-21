import { createFileRoute, redirect } from "@tanstack/react-router";

import { FlowsTab } from "@/components/ligacoes/flows-tab";

export const Route = createFileRoute("/automacoes/ligacoes")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
  component: CallAutomationFlowsPage,
});

function CallAutomationFlowsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          Automações · Fluxos
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Fluxos de ligação</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Defina tentativas, etapas de contato e mensagens de apoio para a operação de voz.
        </p>
      </div>
      <FlowsTab />
    </div>
  );
}
