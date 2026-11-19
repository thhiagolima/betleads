import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { JourneyEditor } from "@/components/journeys/journey-editor";
import { LoadError } from "@/components/journeys/load-error";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/ui-premium/page-header";
import { getJourney } from "@/lib/journeys.functions";
export const Route = createFileRoute("/jornadas/$journeyId")({ component: JourneyDetailPage });

const NOT_FOUND_MESSAGE = "Jornada não encontrada";

function JourneyDetailPage() {
  const { journeyId } = Route.useParams();
  const load = useServerFn(getJourney);
  const query = useQuery({
    queryKey: ["journey", journeyId],
    queryFn: () => load({ data: { id: journeyId } }),
  });
  if (query.isLoading)
    return (
      <Page className="max-w-3xl">
        <p className="text-body text-muted-foreground">Carregando jornada…</p>
      </Page>
    );
  if (!query.data) {
    // getJourney throws "Jornada não encontrada" only when the row is missing;
    // anything else (network, server) can be retried.
    const notFound = !query.isError || query.error?.message === NOT_FOUND_MESSAGE;
    return (
      <Page className="max-w-3xl">
        <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
          <Link to="/automacoes" hash="jornadas">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Automações
          </Link>
        </Button>
        {notFound ? (
          <div className="rounded-xl border border-border bg-card/80 px-4 py-8 text-center">
            <p className="text-body font-medium">Jornada não encontrada</p>
            <p className="mt-1 text-meta text-muted-foreground">
              Ela pode ter sido apagada ou pertencer a outra casa.
            </p>
          </div>
        ) : (
          <LoadError
            title="Não foi possível carregar a jornada"
            message="Verifique a conexão e tente de novo."
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </Page>
    );
  }
  return (
    <JourneyEditor
      // A save of an active journey opens its new draft revision: remount with its data.
      key={journeyId}
      id={journeyId}
      initial={query.data.journey}
      initialSteps={query.data.steps}
      metrics={query.data.metrics}
    />
  );
}
