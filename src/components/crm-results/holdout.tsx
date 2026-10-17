import { Link } from "@tanstack/react-router";

import { HOLDOUT_MIN_PLAYERS, HOLDOUT_MIN_RETURNS } from "@/lib/crm-results";
import { num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Data, money, pct } from "./format";

export function Holdout({ data }: { data: Data }) {
  const withResults = new Set(data.holdout.map((row) => row.journeyId));
  const pending = data.holdoutSetup.filter((journey) => !withResults.has(journey.journeyId));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Teste de controle</CardTitle>
          <CardDescription>
            Uma parte sorteada dos jogadores que entram na jornada não recebe mensagens. Comparar a
            volta dos dois grupos em até 7 dias mostra o efeito real da jornada, sem contar quem
            voltaria de qualquer jeito.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          {[
            ["1", "Sorteio", "Na entrada, cada jogador cai no grupo que recebe ou no controle."],
            ["2", "7 dias", "Os dois grupos são acompanhados por 7 dias depois da entrada."],
            ["3", "Resultado", "A diferença na volta entre os grupos é o que a jornada causou."],
          ].map(([step, title, text]) => (
            <div key={step} className="flex gap-3 rounded-lg border p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {step}
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{text}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.holdout.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resultados</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jornada</TableHead>
                  <TableHead className="text-right">Receberam: voltaram</TableHead>
                  <TableHead className="text-right">Controle: voltaram</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                  <TableHead className="text-right">Jogadores a mais</TableHead>
                  <TableHead className="text-right">Valor a mais</TableHead>
                  <TableHead>Leitura</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.holdout.map((row) => (
                  <TableRow key={row.journeyId}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(row.treatedRate)}
                      <div className="text-xs text-muted-foreground">
                        de {num(row.treated.players)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(row.controlRate)}
                      <div className="text-xs text-muted-foreground">
                        de {num(row.control.players)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.lift == null ? (
                        "—"
                      ) : (
                        <>
                          <span
                            className={
                              !row.significant
                                ? ""
                                : row.lift > 0
                                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                                  : "font-medium text-red-600 dark:text-red-400"
                            }
                          >
                            {row.lift >= 0 ? "+" : ""}
                            {pct(row.lift)}
                          </span>
                          <div className="text-xs text-muted-foreground">
                            {pct(row.ciLow)} a {pct(row.ciHigh)}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.incrementalPlayers == null
                        ? "—"
                        : num(Math.round(row.incrementalPlayers))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.incrementalRevenue)}
                    </TableCell>
                    <TableCell>
                      {!row.sufficient ? (
                        <Badge variant="outline">amostra insuficiente</Badge>
                      ) : row.significant && (row.lift ?? 0) > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        >
                          traz jogadores de volta
                        </Badge>
                      ) : row.significant ? (
                        <Badge
                          variant="outline"
                          className="border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
                        >
                          pior que não enviar
                        </Badge>
                      ) : (
                        <Badge variant="outline">sem diferença comprovada</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Testes em andamento</CardTitle>
            <CardDescription>
              Ainda sem resultado: nenhum jogador destas jornadas completou os 7 dias. Para uma
              leitura confiável, cada grupo precisa de pelo menos {HOLDOUT_MIN_PLAYERS} jogadores.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pending.map((journey) => {
              const progress = Math.min(1, journey.control / HOLDOUT_MIN_PLAYERS);
              return (
                <div key={journey.journeyId} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-tight">{journey.name}</p>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      controle {journey.percent}%
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm tabular-nums">
                    <div>
                      <p className="text-lg font-semibold">{num(journey.treated)}</p>
                      <p className="text-xs text-muted-foreground">recebem mensagens</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold">{num(journey.control)}</p>
                      <p className="text-xs text-muted-foreground">no controle</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${Math.max(2, progress * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Amostra do controle: {num(journey.control)} de {HOLDOUT_MIN_PLAYERS}
                      {journey.firstResultAt
                        ? ` · primeiro resultado em ${new Date(journey.firstResultAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`
                        : " · aguardando a primeira entrada"}
                      {journey.status !== "active" ? " · jornada desligada" : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {data.holdout.length === 0 && pending.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm">
            <p className="font-medium">Nenhuma jornada com grupo de controle</p>
            <p className="max-w-md text-muted-foreground">
              Ative em Jornadas → editar → Grupo de controle. Os primeiros resultados aparecem 7
              dias depois das primeiras entradas.
            </p>
            <Button size="sm" variant="outline" asChild>
              <Link to="/jornadas">Ir para Jornadas</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Intervalo de 95%. “Amostra insuficiente” abaixo de {HOLDOUT_MIN_PLAYERS} jogadores por grupo
        ou {HOLDOUT_MIN_RETURNS} retornos. Jogadores do controle ficam fora das campanhas em massa,
        mas ainda recebem envios individuais.
      </p>
    </div>
  );
}
