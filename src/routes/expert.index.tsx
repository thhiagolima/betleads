// Área do Expert (Fase 1, Task 9): tela "Início" do expert — saudação,
// tipo de acesso e casa, e o total de leads visíveis por ele, com um botão
// para a listagem (/expert/leads).
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { getExpertHome } from "@/lib/expert-leads.functions";

export const Route = createFileRoute("/expert/")({
  component: ExpertHomePage,
});

const TIPO_LABEL: Record<"restrito" | "total", string> = {
  restrito: "Restrito",
  total: "Acesso total",
};

/**
 * `getExpertHome`/`listExpertLeads` throw `ExpertAccessError` (server-only,
 * so not imported here) for two cases: no active expert access (message
 * "Acesso de expert não encontrado ou desativado.") or a suspended house
 * ("Esta casa está indisponível no momento."). The second is shown as-is;
 * the first, and any other unexpected error, collapses to the generic
 * "exclusiva para experts" message so we never leak internal details to a
 * non-expert who lands on this route.
 */
const HOUSE_UNAVAILABLE_MESSAGE = "Esta casa está indisponível no momento.";
const GENERIC_ACCESS_MESSAGE = "Esta área é exclusiva para experts.";

function expertAccessErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === HOUSE_UNAVAILABLE_MESSAGE) {
    return HOUSE_UNAVAILABLE_MESSAGE;
  }
  return GENERIC_ACCESS_MESSAGE;
}

function ExpertHomePage() {
  const getExpertHomeFn = useServerFn(getExpertHome);
  const homeQuery = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => getExpertHomeFn(),
  });

  if (homeQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(homeQuery.error)}
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (homeQuery.isLoading || !homeQuery.data) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Carregando…
          </CardContent>
        </Card>
      </Page>
    );
  }

  const { nome, tipo, tenantNome, totalLeads } = homeQuery.data;

  return (
    <Page>
      <PageHeader
        title={`Olá, ${nome}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{TIPO_LABEL[tipo]}</Badge>
            <span>{tenantNome}</span>
          </span>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Seus leads: {totalLeads}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild className="gap-2">
            <Link to="/expert/leads">
              Ver leads
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </Page>
  );
}
