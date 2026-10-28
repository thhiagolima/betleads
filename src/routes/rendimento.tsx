// "Meu rendimento" (Relatório de rendimento, Task 5): relatório do perfil de
// equipe vinculado ao usuário logado na casa ativa. Rotas filhas
// (/rendimento/equipe e /rendimento/equipe/$expertId) renderizam só o
// próprio <Outlet />, no padrão de `expert.leads.tsx`. Placeholder; o
// conteúdo vem na Task 6.
import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium/page-header";

export const Route = createFileRoute("/rendimento")({
  component: RendimentoRoute,
});

function RendimentoRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isChildRoute = pathname.replace(/\/+$/, "") !== "/rendimento";
  return isChildRoute ? <Outlet /> : <MeuRendimentoPage />;
}

function MeuRendimentoPage() {
  return (
    <Page>
      <PageHeader />
    </Page>
  );
}
