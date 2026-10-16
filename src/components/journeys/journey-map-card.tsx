import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildJourneyMap, type MapJourney } from "@/lib/journey-map";

/** P3: the tenant's journeys as lanes a player goes through, with who is in each. */
export function JourneyMapCard({ journeys }: { journeys: MapJourney[] }) {
  const lanes = buildJourneyMap(journeys);
  if (lanes.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mapa das réguas</CardTitle>
        <CardDescription>
          Como as jornadas se encaixam e quantos jogadores estão em cada uma agora.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {lanes.map((lane) => (
          <section key={lane.key} aria-label={lane.title}>
            <div className="mb-2">
              <h3 className="text-sm font-semibold">{lane.title}</h3>
              <p className="text-xs text-muted-foreground">{lane.description}</p>
            </div>
            <ol className="flex flex-wrap items-stretch gap-2">
              {lane.items.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2">
                  <Link
                    to="/jornadas/$journeyId"
                    params={{ journeyId: item.id }}
                    className={`block min-w-40 rounded-lg border p-3 text-sm hover:bg-muted/40 ${
                      item.status === "active" ? "" : "border-dashed opacity-70"
                    }`}
                  >
                    <span className="block font-medium">{item.name}</span>
                    {item.detail && (
                      <span className="block text-xs text-muted-foreground">{item.detail}</span>
                    )}
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {(item.inProgress ?? 0).toLocaleString("pt-BR")} jogador(es)
                      </Badge>
                      {item.status !== "active" && (
                        <Badge variant="outline" className="text-[10px]">
                          {item.status === "paused" ? "desligada" : "rascunho"}
                        </Badge>
                      )}
                      {Number(item.holdout_percent ?? 0) > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          controle {item.holdout_percent}%
                        </Badge>
                      )}
                    </span>
                  </Link>
                  {lane.key !== "events" &&
                    lane.key !== "acquisition" &&
                    index < lane.items.length - 1 && (
                      <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
