// "Rendimento da equipe" (Relatório de rendimento, Task 5): lista/ranking dos
// perfis de equipe da casa, só para o admin. `/rendimento/equipe/$expertId`
// é rota filha (detalhe de uma pessoa) — renderiza só o próprio <Outlet />,
// no padrão de `experts.tsx`. Placeholder; o conteúdo vem na Task 7.
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/rendimento/equipe")({
  component: RendimentoEquipeRoute,
});

function RendimentoEquipeRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isDetailRoute = pathname.replace(/\/+$/, "") !== "/rendimento/equipe";
  return isDetailRoute ? <Outlet /> : <RendimentoEquipePage />;
}

function RendimentoEquipePage() {
  return (
    <Page>
      <PageHeader />
    </Page>
  );
}
