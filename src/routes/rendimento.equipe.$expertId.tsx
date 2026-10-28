// "Relatório de rendimento" de uma pessoa da equipe (Task 5): detalhe
// acessado só pelo admin, a partir de /rendimento/equipe. Substitui o antigo
// /experts/$expertId, que agora redireciona para aqui. Placeholder; o
// conteúdo (métricas, extrato via `CreditStatement` com `expertId`, carteira)
// vem na Task 7.
import { createFileRoute } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/rendimento/equipe/$expertId")({
  component: RendimentoPessoaPage,
});

function RendimentoPessoaPage() {
  return (
    <Page>
      <PageHeader />
    </Page>
  );
}
