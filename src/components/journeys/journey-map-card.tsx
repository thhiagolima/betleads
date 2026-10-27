import { Link } from "@tanstack/react-router";
import { ArrowRight, Route } from "lucide-react";

import { EmptyState } from "@/components/ui-premium/empty-state";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildJourneyMap, type MapJourney } from "@/lib/journey-map";

const STATUS_LABEL: Record<string, string> = {
  paused: "pausada",
  draft: "rascunho",
  archived: "arquivada",
};

/** P3: the house's journeys as lanes a player goes through, with who is in each. */
export function JourneyMapCard({ journeys }: { journeys: MapJourney[] }) {
  const lanes = buildJourneyMap(journeys);
  if (lanes.length === 0)
    return (
      <Card>
        <EmptyState
          icon={<Route />}
          title="Nenhuma jornada no mapa"
          description="Crie uma jornada para ver aqui como elas se encaixam e quantos jogadores estão em cada uma."
        />
      </Card>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mapa das jornadas</CardTitle>
        <CardDescription>
          Como as jornadas se encaixam e quantos jogadores estão em cada uma agora. Jornadas
          pausadas ou em rascunho aparecem esmaecidas.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-6 gap-y-5 lg:grid-cols-2">
        {lanes.map((lane) => (
          <section key={lane.key} aria-label={lane.title}>
            <div className="mb-2">
              <h3 className="text-sm font-semibold">{lane.title}</h3>
              <p className="text-xs text-muted-foreground">{lane.description}</p>
            </div>
            <ol className="flex flex-wrap items-center gap-1.5">
              {lane.items.map((item, index) => {
                const inactive = item.status !== "active";
                return (
                  <li key={item.id} className="flex items-center gap-1.5">
                    <Link
                      to="/jornadas/$journeyId"
                      params={{ journeyId: item.id }}
                      title={item.detail ?? undefined}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted/40 ${
                        inactive ? "border-dashed opacity-60" : ""
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          inactive ? "bg-muted-foreground/50" : "bg-success"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="font-medium">{item.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {(item.inProgress ?? 0).toLocaleString("pt-BR")}
                        <span className="sr-only"> jogador(es)</span>
                      </span>
                      {inactive && <span className="sr-only">({STATUS_LABEL[item.status]})</span>}
                      {Number(item.holdout_percent ?? 0) > 0 && (
                        <Badge variant="outline" className="px-1 py-0 text-meta">
                          controle {item.holdout_percent}%
                        </Badge>
                      )}
                    </Link>
                    {lane.key !== "events" &&
                      lane.key !== "acquisition" &&
                      index < lane.items.length - 1 && (
                        <ArrowRight
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
