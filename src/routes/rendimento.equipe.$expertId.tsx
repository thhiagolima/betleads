// "Relatório de rendimento" de uma pessoa da equipe (Tasks 5 e 6): detalhe
// acessado só pelo admin, a partir de /rendimento/equipe. Substitui o antigo
// /experts/$expertId, que agora redireciona para aqui. `ReportView` com
// `expertId` (modo admin: "Editar" e "Desativar"/"Ativar" no cabeçalho).
import { createFileRoute } from "@tanstack/react-router";

import { ReportView } from "@/components/rendimento/report-view";

export const Route = createFileRoute("/rendimento/equipe/$expertId")({
  component: RendimentoPessoaPage,
});

function RendimentoPessoaPage() {
  const { expertId } = Route.useParams();
  // `key`: trocar de pessoa zera o período, a carteira e o painel aberto.
  return <ReportView key={expertId} expertId={expertId} />;
}
