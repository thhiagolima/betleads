// "Relatório de rendimento" de uma pessoa da equipe (Tasks 5 e 6): detalhe
// acessado só pelo admin, a partir de /rendimento/equipe. Substitui o antigo
// /experts/$expertId, que agora redireciona para aqui. `ReportView` com
// `expertId` (modo admin: "Editar" e "Desativar"/"Ativar" no cabeçalho).
//
// Área do Expert §8: abas "Rendimento" | "Campanhas" (?aba=campanhas) — a
// aba Campanhas é a fila de aprovação, pausar/retomar e o uso × teto do
// expert. O aviso de teto atingido (e-mail) aponta para ela.
import { createFileRoute } from "@tanstack/react-router";

import { ReportView } from "@/components/rendimento/report-view";
import {
  ExpertCampaignsAdminView,
  ExpertDetailTabsWithCount,
} from "@/components/experts/expert-campaigns-admin-view";

type Search = { aba?: "campanhas" };

export const Route = createFileRoute("/rendimento/equipe/$expertId")({
  validateSearch: (search: Record<string, unknown>): Search =>
    search.aba === "campanhas" ? { aba: "campanhas" } : {},
  component: RendimentoPessoaPage,
});

function RendimentoPessoaPage() {
  const { expertId } = Route.useParams();
  const { aba } = Route.useSearch();
  if (aba === "campanhas") return <ExpertCampaignsAdminView key={expertId} expertId={expertId} />;
  // `key`: trocar de pessoa zera o período, a carteira e o painel aberto.
  return (
    <ReportView
      key={expertId}
      expertId={expertId}
      tabs={<ExpertDetailTabsWithCount expertId={expertId} active="rendimento" />}
    />
  );
}
