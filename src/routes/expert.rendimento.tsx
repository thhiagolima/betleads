// Área do Expert — "Rendimento" (Relatório de rendimento, Task 5): entrada
// de menu/aba para o próprio relatório do expert. Placeholder; o conteúdo
// (Task 6) usa `CreditStatement` sem `expertId` (sujeito = o próprio
// usuário, via `resolveReportSubject`).
import { createFileRoute } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/expert/rendimento")({
  component: ExpertRendimentoPage,
});

function ExpertRendimentoPage() {
  return (
    <Page>
      <PageHeader />
    </Page>
  );
}
