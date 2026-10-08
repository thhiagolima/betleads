import { createFileRoute, redirect } from "@tanstack/react-router";

import { WhatsappAutomationFlowsPanel } from "@/routes/whatsapp";

export const Route = createFileRoute("/automacoes/whatsapp")({
  beforeLoad: () => {
    throw redirect({ to: "/automacoes" });
  },
  component: WhatsappAutomationFlowsPage,
});

function WhatsappAutomationFlowsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          AutomaÃ§Ãµes Â· Fluxos
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Fluxos de WhatsApp</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Monte jornadas com mensagens, condiÃ§Ãµes e regras de saÃ­da por WhatsApp.
        </p>
      </div>
      <WhatsappAutomationFlowsPanel />
    </div>
  );
}
