import { createFileRoute } from "@tanstack/react-router";

import { SmsFlowsPanel } from "@/routes/sms";

export const Route = createFileRoute("/automacoes/sms")({
  component: SmsAutomationFlowsPage,
});

function SmsAutomationFlowsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          Automações · Fluxos
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Fluxos de SMS</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Crie jornadas acionadas por comportamento. Estes fluxos agora vivem na central de
          Automações e poderão ser combinados com outros canais.
        </p>
      </div>
      <SmsFlowsPanel />
    </div>
  );
}
