import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getCrmRetention } from "@/lib/crm-results.functions";
import { PLAYER_STATE_LABELS, RECOVERABLE_STATES } from "@/lib/crm-results";
import { brl, num } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Data, dayLabel, money, pct } from "./format";
import { EmptyCard, InfoTip, NotPeriodBadge, RoiValue } from "./shared";

const LIFECYCLE_ORDER = ["ativo", "esfriando", "dormindo", "perdido", "sem_ftd", "sem_historico"];
const TOP_ORIGINS = 15;

const percentOf = (value: number, total: number) => (total > 0 ? pct(value / total) : "—");
const pctValue = (value: number | null) =>
  value == null
    ? "—"
    : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const hours = (value: number | null) =>
  value == null
    ? "—"
    : value < 24
      ? `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`
      : `${(value / 24).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;

export function BasePlayers({ data }: { data: Data }) {
  const load = useServerFn(getCrmRetention);
  const query = useQuery({
    queryKey: ["crm-retention", data.days, data.endOffset],
    queryFn: () => load({ data: { days: data.days, endOffset: data.endOffset } }),
    staleTime: 5 * 60_000,
  });
  return (
    <div className="space-y-4">
      <States data={data} />
      {query.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : query.isError || !query.data ? (
        <EmptyCard>Não foi possível carregar retenção e aquisição.</EmptyCard>
      ) : (
        <>
          <Lifecycle retention={query.data} />
          <Acquisition retention={query.data} days={data.days} endOffset={data.endOffset} />
          <Cohorts retention={query.data} />
        </>
      )}
    </div>
  );
}

type Retention = Awaited<ReturnType<typeof getCrmRetention>>;

function Bars({ items, total }: { items: Array<{ label: string; value: number }>; total: number }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex justify-between text-sm">
            <span>{item.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {num(item.value)} · {percentOf(item.value, total)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted/40">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${total ? (item.value / total) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Where the money goes by the player's situation at send, and where it converts (C-06). */
function States({ data }: { data: Data }) {
  const states = data.states.filter((state) => state.sent > 0 || state.directPlayers > 0);
  if (states.length === 0) return null;
  const totalCost = states.reduce((sum, state) => sum + state.cost, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          Para quem vai o dinheiro
          <InfoTip text="Situação do jogador no momento em que recebeu a mensagem. Envios a jogadores ativos são relacionamento, não reativação." />
        </CardTitle>
        <CardDescription>
          Custo em SMS e conversão por clique pela situação do jogador no envio.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Situação no envio</TableHead>
              <TableHead className="min-w-40">Parte do custo</TableHead>
              <TableHead className="text-right">Jogadores</TableHead>
              <TableHead className="text-right">Convertidos</TableHead>
              <TableHead className="text-right">Custo / convertido</TableHead>
              <TableHead className="text-right">Retorno</TableHead>
              <TableHead className="text-right">Recuperados</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {states.map((state) => (
              <TableRow key={state.state}>
                <TableCell>
                  {state.label}
                  {!RECOVERABLE_STATES.has(state.state) && (
                    <div className="text-xs text-muted-foreground">relacionamento</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-baseline justify-between gap-2 tabular-nums">
                    <span>{brl(state.cost)}</span>
                    <span className="text-xs text-muted-foreground">
                      {percentOf(state.cost, totalCost)}
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden="true">
                    <div
                      className={`h-1 rounded-full ${
                        state.state === "ativo" ? "bg-amber-500/70" : "bg-primary/70"
                      }`}
                      style={{ width: `${totalCost ? (state.cost / totalCost) * 100 : 0}%` }}
                    />
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(state.recipients)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(state.directPlayers)}
                  <div className="text-xs text-muted-foreground">{brl(state.directRevenue)}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(state.costPerConversion)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <RoiValue roi={state.clickRoi} smallSample={state.smallSample} />
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {RECOVERABLE_STATES.has(state.state) ? num(state.influencedPlayers) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Lifecycle({ retention }: { retention: Retention }) {
  const { lifecycle } = retention;
  const totalPlayers = lifecycle.reduce((sum, row) => sum + row.players, 0);
  const ordered = [...lifecycle].sort(
    (a, b) => LIFECYCLE_ORDER.indexOf(a.state) - LIFECYCLE_ORDER.indexOf(b.state),
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Onde a base está agora
            <NotPeriodBadge />
          </CardTitle>
          <CardDescription>Pelo tempo desde o último depósito de cada jogador.</CardDescription>
        </CardHeader>
        <CardContent>
          <Bars
            total={totalPlayers}
            items={ordered.map((row) => ({
              label: PLAYER_STATE_LABELS[row.state] ?? row.state,
              value: row.players,
            }))}
          />
        </CardContent>
      </Card>
      {retention.lifecycleDaily.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Evolução da base</CardTitle>
            <CardDescription>
              Jogadores em cada situação ao fim de cada dia. Ativos que viram “esfriando” são os que
              o CRM precisa trazer de volta.
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={retention.lifecycleDaily.map((day) => ({
                  ...day,
                  label: dayLabel(day.date),
                }))}
              >
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis fontSize={12} tickLine={false} axisLine={false} width={60} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    num(Number(value)),
                    PLAYER_STATE_LABELS[name] ?? name,
                  ]}
                />
                <Legend formatter={(name: string) => PLAYER_STATE_LABELS[name] ?? name} />
                <Line dataKey="ativo" stroke="oklch(0.72 0.18 150)" strokeWidth={2} dot={false} />
                <Line
                  dataKey="esfriando"
                  stroke="oklch(0.75 0.15 75)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line dataKey="dormindo" stroke="oklch(0.65 0.2 30)" strokeWidth={2} dot={false} />
                <Line dataKey="perdido" stroke="oklch(0.6 0.03 260)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      ) : (
        <EmptyCard>A evolução da base aparece em períodos de 7 dias ou mais.</EmptyCard>
      )}
    </div>
  );
}

/** Background tint for a cohort cell: stronger green = more second deposits (C-08). */
const heat = (value: number | null, max: number) =>
  value == null || max <= 0
    ? undefined
    : { backgroundColor: `oklch(0.72 0.18 150 / ${((value / max) * 0.35).toFixed(3)})` };

function Cohorts({ retention }: { retention: Retention }) {
  const { cohorts } = retention;
  const max = Math.max(
    0,
    ...cohorts.flatMap((row) => [row.second7d ?? 0, row.second14d ?? 0, row.second30d ?? 0]),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Retenção dos novos depositantes
          <NotPeriodBadge />
        </CardTitle>
        <CardDescription>
          Últimas 12 semanas, pela semana do 1º depósito. Verde mais forte = mais jogadores fizeram
          o 2º depósito. A taxa só aparece depois que a janela se fecha para todos do grupo.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {cohorts.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Sem primeiros depósitos no período.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Semana do 1º depósito</TableHead>
                <TableHead className="text-right">Jogadores</TableHead>
                <TableHead className="text-right">2º depósito em 7 dias</TableHead>
                <TableHead className="text-right">em 14 dias</TableHead>
                <TableHead className="text-right">em 30 dias</TableHead>
                <TableHead className="text-right">Tempo até o 2º (mediana)</TableHead>
                <TableHead className="text-right">Depositado em 30 dias</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((row) => (
                <TableRow key={row.week}>
                  <TableCell>{dayLabel(row.week)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(row.size)}</TableCell>
                  {[row.second7d, row.second14d, row.second30d].map((value, index) => (
                    <TableCell
                      key={index}
                      className="text-right tabular-nums"
                      style={heat(value, max)}
                    >
                      {pctValue(value)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">
                    {hours(row.medianHoursToSecond)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.revenue30d)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="px-6 py-3 text-xs text-muted-foreground">
          O histórico de depósitos começa em 02/09/2026; jogadores que já depositavam antes disso
          não entram como novos.
        </p>
      </CardContent>
    </Card>
  );
}

function Acquisition({
  retention,
  days,
  endOffset,
}: {
  retention: Retention;
  days: number;
  endOffset: number;
}) {
  const { total, byOrigin } = retention.funnel;
  const when = days === 1 ? (endOffset === 1 ? "ontem" : "hoje") : `nos últimos ${num(days)} dias`;
  if (!total || total.signups === 0) return <EmptyCard>Nenhum cadastro {when}.</EmptyCard>;
  const top = byOrigin.slice(0, TOP_ORIGINS);
  const rest = byOrigin.slice(TOP_ORIGINS);
  const others = rest.length
    ? {
        origin: `Outras (${num(rest.length)} origens)`,
        signups: rest.reduce((sum, row) => sum + row.signups, 0),
        firstDeposit: rest.reduce((sum, row) => sum + row.firstDeposit, 0),
        secondDeposit: rest.reduce((sum, row) => sum + row.secondDeposit, 0),
        medianHoursToFtd: null,
      }
    : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Funil dos cadastros</CardTitle>
          <CardDescription>
            Quem se cadastrou {when} e até onde chegou. Mediana do cadastro ao 1º depósito:{" "}
            {hours(total.medianHoursToFtd)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Bars
            total={total.signups}
            items={[
              { label: "Cadastros", value: total.signups },
              { label: "1º depósito", value: total.firstDeposit },
              { label: "2º depósito", value: total.secondDeposit },
              { label: "3 ou mais depósitos", value: total.thirdPlus },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por origem do cadastro</CardTitle>
          <CardDescription>Origem informada no cadastro (utm_source).</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Origem</TableHead>
                <TableHead className="text-right">Cadastros</TableHead>
                <TableHead className="text-right">Viraram depositantes</TableHead>
                <TableHead className="text-right">2º depósito</TableHead>
                <TableHead className="text-right">Tempo até o 1º</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...top, ...(others ? [others] : [])].map((row) => (
                <TableRow key={row.origin}>
                  <TableCell>{row.origin}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(row.signups)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="font-medium">{percentOf(row.firstDeposit, row.signups)}</span>
                    <div className="text-xs text-muted-foreground">{num(row.firstDeposit)}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentOf(row.secondDeposit, row.signups)}
                    <div className="text-xs text-muted-foreground">{num(row.secondDeposit)}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {hours(row.medianHoursToFtd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
