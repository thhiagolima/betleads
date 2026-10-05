import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { JourneyEditor } from "@/components/journeys/journey-editor";
import { getJourney } from "@/lib/journeys.functions";
export const Route = createFileRoute("/jornadas/$journeyId")({ component: JourneyDetailPage });
function JourneyDetailPage() {
  const { journeyId } = Route.useParams();
  const load = useServerFn(getJourney);
  const query = useQuery({
    queryKey: ["journey", journeyId],
    queryFn: () => load({ data: { id: journeyId } }),
  });
  if (query.isLoading)
    return <div className="p-6 text-sm text-muted-foreground">Carregando jornada…</div>;
  if (!query.data)
    return <div className="p-6 text-sm text-destructive">Jornada não encontrada.</div>;
  return <JourneyEditor id={journeyId} initial={query.data.journey} />;
}
