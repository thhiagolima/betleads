// Área do Expert — "Rendimento" (Relatório de rendimento, Tasks 5 e 6): o
// próprio relatório do expert. `ReportView` sem `expertId` (sujeito = o
// próprio usuário, via `resolveReportSubject`).
import { createFileRoute } from "@tanstack/react-router";

import { ReportView } from "@/components/rendimento/report-view";

export const Route = createFileRoute("/expert/rendimento")({
  component: ExpertRendimentoPage,
});

function ExpertRendimentoPage() {
  return <ReportView />;
}
