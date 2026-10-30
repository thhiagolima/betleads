// "Meu rendimento" (Relatório de rendimento, Tasks 5 e 6): relatório do
// perfil de equipe vinculado ao usuário logado na casa ativa (`ReportView`
// sem `expertId`). Rotas filhas (/rendimento/equipe e
// /rendimento/equipe/$expertId) renderizam só o próprio <Outlet />, no padrão
// de `expert.leads.tsx`.
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { ReportView } from "@/components/rendimento/report-view";

export const Route = createFileRoute("/rendimento")({
  component: RendimentoRoute,
});

function RendimentoRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isChildRoute = pathname.replace(/\/+$/, "") !== "/rendimento";
  return isChildRoute ? <Outlet /> : <ReportView />;
}
