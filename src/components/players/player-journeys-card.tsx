import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { num } from "@/lib/format";
import { getPlayerJourneys } from "@/lib/player-journeys.functions";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

/** Journeys of the player: where he is, what comes next, and why he left (P3). */
export function PlayerJourneysCard({ playerId }: { playerId: string }) {
  const load = useServerFn(getPlayerJourneys);
  const query = useQuery({
    queryKey: ["player-journeys", playerId],
    queryFn: () => load({ data: { playerId } }),
    staleTime: 15_000,
  });

  return (
    <Card className="border-border/50 bg-card/70">
      <CardContent className="space-y-4 p-5">
        <div>
          <div className="text-base font-semibold">Jornadas</div>
          <div className="text-sm text-muted-foreground">
            Em que réguas o jogador está, o próximo envio e por que saiu das anteriores.
          </div>
        </div>
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError || !query.data ? (
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar as jornadas deste jogador.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline">
                {num(query.data.messages.last24h)}
                {query.data.messages.limit24h ? ` de ${num(query.data.messages.limit24h)}` : ""} SMS
                nas últimas 24 h
              </Badge>
              <Badge variant="outline">
                {num(query.data.messages.last7d)}
                {query.data.messages.limit7d ? ` de ${num(query.data.messages.limit7d)}` : ""} SMS
                em 7 dias
              </Badge>
              {query.data.messages.byOrigin.slice(0, 4).map((item) => (
                <Badge key={item.name} variant="secondary">
                  {item.name}: {num(item.count)}
                </Badge>
              ))}
            </div>
            {query.data.journeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Este jogador nunca entrou em uma jornada.
              </p>
            ) : (
              <ul className="space-y-2">
                {query.data.journeys.map((journey) => (
                  <li
                    key={journey.id}
                    className={`rounded-md border p-3 text-sm ${
                      journey.open ? "border-primary/40" : "border-border/50 opacity-80"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        to="/jornadas/$journeyId/relatorio"
                        params={{ journeyId: journey.journeyId }}
                        className="font-medium hover:underline"
                      >
                        {journey.journeyName}
                      </Link>
                      <div className="flex flex-wrap gap-1">
                        {journey.holdout && (
                          <Badge variant="outline" title="Grupo de controle: não recebe mensagens">
                            grupo de controle
                          </Badge>
                        )}
                        <Badge variant={journey.open ? "default" : "outline"}>
                          {journey.statusLabel}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {journey.open ? (
                        <>
                          {journey.stepLabel ?? "Sem etapas de envio"}
                          {journey.loopIteration > 0 &&
                            ` · repetição ${num(journey.loopIteration)}`}
                          {journey.pausedBy
                            ? ` · aguardando "${journey.pausedBy}" terminar`
                            : journey.holdout
                              ? " · sem envio (controle)"
                              : ` · próximo envio ${when(journey.nextRunAt)}`}
                        </>
                      ) : (
                        <>
                          Entrou {when(journey.enteredAt)} · saiu {when(journey.endedAt)}
                          {journey.exitLabel && ` · ${journey.exitLabel}`}
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
