// ESCOPO_ORIGEM_UTM_2026-11-14: aba Origem de Aquisição e LTV. Lê só a UTM e o afiliado
// gravados no cadastro; não depende da Meta conectada. U1 leitura, U2 apelidos e regras,
// U3 jogadores, janelas de 7/30 dias e comparação com o período anterior.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, Copy, Download, Link2, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { MediaPeriodPicker } from "@/components/midia-ltv/period-picker";
import { ChannelRuleButton, LabelEditor } from "@/components/midia-ltv/origin-row-actions";
import { OriginRulesCard } from "@/components/midia-ltv/origin-rules-card";
import {
  OriginPlayersSheet,
  type PlayersTarget,
} from "@/components/midia-ltv/origin-players-sheet";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { tourAnchor } from "@/help/anchor";
import { useMoney } from "@/hooks/use-tenant-currency";
import { CHART_COLORS, chartAxisProps, chartGridProps, chartTooltipStyle } from "@/lib/chart-theme";
import type { PeriodPreset } from "@/lib/marketing-overview";
import {
  buildUtmLink,
  canLabel,
  canRule,
  delta,
  perSignupWindow,
  previousRange,
  type OriginFilters,
  CHANNEL_HINTS,
  CHANNEL_LABELS,
  conversion,
  coverageLevel,
  FEW_SIGNUPS,
  GROUP_LABELS,
  GROUP_PARAM,
  META_UTM_PRESET,
  net,
  nextGroup,
  ORIGIN_GROUPS,
  originCsv,
  pathFilters,
  rowDisplay,
  type OriginBreakdown,
  type OriginGroup,
  type OriginMetrics,
  type OriginStep,
} from "@/lib/origin-breakdown";
import { getOriginBreakdown } from "@/lib/origin.functions";
import { cn } from "@/lib/utils";

const MAX_DAYS = 93;
// Excel só lê acento no CSV com o BOM no começo.
const BOM = String.fromCharCode(0xfeff);

const num = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
const pct = (value: number | null) =>
  value == null ? "—" : `${(value * 100).toFixed(1).replace(".", ",")}%`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

type Props = {
  range: { from: string; to: string; days: number };
  period: PeriodPreset;
  customRange: { from: string; to: string } | null;
  onPeriodChange: (value: PeriodPreset) => void;
  onCustomRangeChange: (value: { from: string; to: string }) => void;
};

export function OriginPanel({
  range,
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
}: Props) {
  const fetchBreakdown = useServerFn(getOriginBreakdown);
  const { money, currency } = useMoney();
  const [group, setGroup] = useState<OriginGroup>("channel");
  const [path, setPath] = useState<OriginStep[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [onlyFtd, setOnlyFtd] = useState(false);
  const [players, setPlayers] = useState<PlayersTarget>(null);
  const isDemo = useIsDemoTenant();

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const tooLong = range.days > MAX_DAYS;
  const filters = useMemo(
    () => ({
      ...pathFilters(path),
      ...(search ? { search } : {}),
      ...(onlyFtd ? { onlyFtd: true } : {}),
    }),
    [path, search, onlyFtd],
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["origin-breakdown", range.from, range.to, group, JSON.stringify(filters)],
    queryFn: () =>
      fetchBreakdown({
        data: { from: range.from, to: range.to, group, filters, includeCrm: false, limit: 100 },
      }) as Promise<OriginBreakdown>,
    enabled: !tooLong,
    placeholderData: (previous) => previous,
  });

  // Só os totais do período anterior de mesmo tamanho, com os mesmos filtros (U3).
  const prev = useMemo(() => previousRange(range.from, range.to), [range.from, range.to]);
  const { data: previous } = useQuery({
    queryKey: ["origin-breakdown", prev.from, prev.to, "channel", JSON.stringify(filters), "prev"],
    queryFn: () =>
      fetchBreakdown({
        data: {
          from: prev.from,
          to: prev.to,
          group: "channel",
          filters,
          includeCrm: false,
          limit: 1,
        },
      }) as Promise<OriginBreakdown>,
    enabled: !tooLong && Boolean(data),
    staleTime: 5 * 60_000,
  });
  const canEdit = Boolean(data?.canEdit) && !isDemo;

  const open = (row: { key: string | null; name: string }) => {
    const next = nextGroup(group, row.key);
    if (!next) return;
    setPath((current) => [...current, { group, key: row.key, name: row.name }]);
    setGroup(next);
  };

  const goTo = (index: number) => {
    // index -1 = "Todas as origens".
    const step = path[index + 1];
    setPath(path.slice(0, index + 1));
    setGroup(step ? step.group : "channel");
  };

  // Um nível já fixado pelo caminho não vira chip: agrupar por ele daria uma linha só.
  const fixed = new Set(path.map((step) => step.group));
  const groupOptions = ORIGIN_GROUPS.filter((g) => !fixed.has(g));

  const exportCsv = () => {
    if (!data) return;
    const csv = originCsv(data, path, currency);
    const blob = new Blob([`${BOM}${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `origem-${GROUP_LABELS[group].toLowerCase()}-${range.from}-a-${range.to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const coverage = data ? coverageLevel(data.coverage) : null;
  const noData = data && data.coverage.signups === 0;
  const nothingKnown = coverage?.level === "none";

  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        De onde vieram os cadastros, pela UTM ou pelo código de afiliado que a casa mandou no
        cadastro. Não precisa da Meta conectada.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <MediaPeriodPicker
          range={range}
          period={period}
          customRange={customRange}
          onPeriodChange={onPeriodChange}
          onCustomRangeChange={onCustomRangeChange}
        />
      </div>

      {tooLong && (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
        >
          A aba Origem abre até {MAX_DAYS} dias de cadastros por vez. Escolha um período menor.
        </div>
      )}

      {error && !tooLong && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
        >
          <span>
            Não foi possível carregar a origem dos cadastros deste período.
            {error instanceof Error && error.message ? ` (${error.message})` : ""}
          </span>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Tentar novamente
          </Button>
        </div>
      )}

      {isLoading && !tooLong && (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando a origem dos cadastros…
        </div>
      )}

      {data && !tooLong && noData && (
        <DataCard>
          <EmptyState
            title="Nenhum cadastro neste período"
            description={`Não houve cadastro entre ${ddmm(range.from)} e ${ddmm(range.to)}. Escolha outro período.`}
          />
        </DataCard>
      )}

      {data && !tooLong && !noData && (
        <>
          <Kpis data={data} previous={previous} money={money} />
          <CoverageNote data={data} />

          {nothingKnown && path.length === 0 && !search && !onlyFtd ? (
            <UtmHelp />
          ) : (
            <>
              <div className="space-y-3" {...tourAnchor("midia.origem.agrupar")}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-label text-muted-foreground">Agrupar por</span>
                  {groupOptions.map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={group === g}
                      onClick={() => setGroup(g)}
                      className={cn(
                        "h-8 rounded-full border px-3 text-[13px] font-medium transition-colors",
                        group === g
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {GROUP_LABELS[g]}
                    </button>
                  ))}
                </div>
                <nav
                  aria-label="Caminho"
                  className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground"
                >
                  <button
                    type="button"
                    className={cn("hover:text-foreground", path.length === 0 && "text-foreground")}
                    onClick={() => goTo(-1)}
                  >
                    Todas as origens
                  </button>
                  {path.map((step, index) => (
                    <span key={`${step.group}-${index}`} className="flex items-center gap-1">
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      <button
                        type="button"
                        className={cn(
                          "max-w-[16rem] truncate hover:text-foreground",
                          index === path.length - 1 && "text-foreground",
                        )}
                        title={`${GROUP_LABELS[step.group]}: ${step.name}`}
                        onClick={() => goTo(index)}
                      >
                        {step.name}
                      </button>
                    </span>
                  ))}
                  {path.length > 0 && (
                    <button
                      type="button"
                      aria-label="Limpar caminho"
                      className="ml-1 rounded p-0.5 hover:text-foreground"
                      onClick={() => goTo(-1)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </nav>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative w-full sm:w-72">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      aria-label="Buscar campanha, fonte ou afiliado"
                      placeholder="Buscar campanha, fonte, ID ou afiliado"
                      className="h-9 pl-8"
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                    />
                  </div>
                  <label
                    htmlFor="origem-so-ftd"
                    className="flex items-center gap-2 text-[13px] text-muted-foreground"
                  >
                    <Checkbox
                      id="origem-so-ftd"
                      checked={onlyFtd}
                      onCheckedChange={(value) => setOnlyFtd(value === true)}
                    />
                    Só quem fez o 1º depósito
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto gap-2"
                    onClick={exportCsv}
                    {...tourAnchor("midia.origem.csv")}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Exportar CSV
                  </Button>
                  {isFetching && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      aria-label="Atualizando"
                    />
                  )}
                </div>
              </div>

              <DailyChart data={data} />
              <OriginTable
                data={data}
                money={money}
                actions={{
                  onOpen: open,
                  onPlayers: setPlayers,
                  baseFilters: filters,
                  canEdit,
                }}
              />
              <OriginRulesCard canEdit={canEdit} />
            </>
          )}
        </>
      )}

      <OriginPlayersSheet target={players} range={range} onClose={() => setPlayers(null)} />
    </div>
  );
}

type Money = (value: number | null | undefined) => string;

function Kpis({
  data,
  previous,
  money,
}: {
  data: OriginBreakdown;
  previous: OriginBreakdown | undefined;
  money: Money;
}) {
  const { totals, coverage } = data;
  const known = coverage.signups - coverage.noOrigin;
  const period = `${ddmm(data.period.from)} a ${ddmm(data.period.to)}`;
  const vs = previous ? ` vs. ${ddmm(previous.period.from)} a ${ddmm(previous.period.to)}` : "";
  const change = (current: number, before: number | undefined) => {
    const d = delta(current, before);
    if (d == null) return undefined;
    const sign = d > 0 ? "+" : "";
    return { value: `${sign}${(d * 100).toFixed(0)}%${vs}`, positive: d >= 0 };
  };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard
        label="Cadastros"
        value={num(totals.signups)}
        hint={`feitos de ${period}`}
        delta={change(totals.signups, previous?.totals.signups)}
        {...tourAnchor("midia.origem.kpis")}
      />
      <MetricCard
        label="Com origem"
        value={num(known)}
        hint={`${pct(coverage.signups > 0 ? known / coverage.signups : null)} dos cadastros do período`}
      />
      <MetricCard
        label="1º depósito"
        value={num(totals.ftd)}
        hint={`${pct(conversion(totals))} desses cadastros, até hoje`}
        delta={change(totals.ftd, previous?.totals.ftd)}
      />
      <MetricCard
        label="Depósito líquido"
        value={money(totals.net)}
        hint="depósitos − saques desses cadastros, até hoje"
        delta={change(totals.net, previous?.totals.net)}
      />
    </div>
  );
}

function CoverageNote({ data }: { data: OriginBreakdown }) {
  const { coverage, crm } = data;
  const level = coverageLevel(coverage);
  const period = `${ddmm(data.period.from)} a ${ddmm(data.period.to)}`;
  const parts = [
    coverage.withUtm > 0 && `${num(coverage.withUtm)} com UTM`,
    coverage.affiliateOnly > 0 && `${num(coverage.affiliateOnly)} só com código de afiliado`,
    coverage.clickOnly > 0 && `${num(coverage.clickOnly)} só com o clique da Meta (fbclid)`,
    coverage.noOrigin > 0 && `${num(coverage.noOrigin)} sem nada`,
  ].filter(Boolean);
  const tone =
    level.level === "low" || level.level === "none"
      ? "border-warning/30 bg-warning/10 text-warning"
      : "border-border bg-card/70 text-muted-foreground";
  return (
    <div className="space-y-2" {...tourAnchor("midia.origem.cobertura")}>
      {level.level !== "good" && (
        <div role="note" className={cn("rounded-lg border px-4 py-3 text-sm", tone)}>
          <p className="font-semibold">
            {level.level === "none"
              ? `Nenhum cadastro de ${period} chegou com origem.`
              : `${pct(level.share)} dos cadastros de ${period} chegaram com origem.`}
          </p>
          <p className="mt-1">
            {parts.join(" · ")}. Os cadastros sem nada aparecem na linha "Sem origem informada" e
            não são divididos entre as campanhas.
          </p>
        </div>
      )}
      <p className="text-meta text-muted-foreground">
        Cada linha conta os cadastros feitos no período e tudo o que eles depositaram desde o
        cadastro até hoje. Depósito líquido é depósitos menos saques, não é GGR.
        {crm.signups > 0 &&
          ` ${num(crm.signups)} ${crm.signups === 1 ? "cadastro veio" : "cadastros vieram"} de link das mensagens do próprio CRM e ${crm.signups === 1 ? "fica" : "ficam"} fora da conta: não são aquisição.`}
      </p>
    </div>
  );
}

function DailyChart({ data }: { data: OriginBreakdown }) {
  const points = data.daily.map((d) => ({
    label: ddmm(d.date),
    withOrigin: d.withOrigin,
    noOrigin: d.signups - d.withOrigin,
    ftd: d.ftd,
  }));
  if (points.length < 2) return null;
  return (
    <DataCard
      title="Cadastros por dia"
      description="Com e sem origem, e quantos deles já fizeram o 1º depósito"
    >
      <div className="h-56 px-2 pb-3 pt-2 sm:px-4">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartAxisProps} minTickGap={16} />
            <YAxis {...chartAxisProps} allowDecimals={false} />
            <Tooltip
              contentStyle={chartTooltipStyle}
              formatter={(value, name) => [
                num(Number(value)),
                name === "withOrigin"
                  ? "Com origem"
                  : name === "noOrigin"
                    ? "Sem origem"
                    : "1º depósito",
              ]}
            />
            <Bar
              dataKey="withOrigin"
              stackId="s"
              fill={CHART_COLORS.primary}
              radius={[0, 0, 0, 0]}
            />
            <Bar dataKey="noOrigin" stackId="s" fill={CHART_COLORS.muted} fillOpacity={0.35} />
            <Line
              type="monotone"
              dataKey="ftd"
              stroke={CHART_COLORS.green}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </DataCard>
  );
}

type RowActions = {
  onOpen: (row: { key: string | null; name: string }) => void;
  onPlayers: (target: { title: string; filters: OriginFilters }) => void;
  baseFilters: OriginFilters;
  canEdit: boolean;
};

function OriginTable({
  data,
  money,
  actions,
}: {
  data: OriginBreakdown;
  money: Money;
  actions: RowActions;
}) {
  const { group } = data;
  const rows = data.rows.map((row) => ({ row, display: rowDisplay(group, row) }));
  const few = data.totals.signups - data.noOrigin.signups < FEW_SIGNUPS;
  const param = GROUP_PARAM[group];
  const empty = rows.length === 0 && data.noOrigin.signups === 0;

  const rate = (m: OriginMetrics) => (few ? "poucos dados" : pct(conversion(m)));
  const windowValue = (m: OriginMetrics, days: 7 | 30) => {
    const value = perSignupWindow(m, days);
    return value == null ? "—" : money(value);
  };
  const playersOf = (key: string | null, title: string, extra?: OriginFilters) =>
    actions.onPlayers({
      title,
      filters: { ...actions.baseFilters, ...(extra ?? { [group]: key }) },
    });
  const noOriginFilters: OriginFilters = { channel: "sem_origem" };

  const metricCells = (m: OriginMetrics, onPlayers?: () => void) => (
    <>
      <TableCell className="text-right tabular-nums">
        {onPlayers ? (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            title="Ver os jogadores"
            onClick={(event) => {
              event.stopPropagation();
              onPlayers();
            }}
          >
            {num(m.signups)}
          </button>
        ) : (
          num(m.signups)
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{num(m.ftd)}</TableCell>
      <TableCell className="text-right tabular-nums">{rate(m)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(net(m))}</TableCell>
      <TableCell className="text-right tabular-nums">{windowValue(m, 7)}</TableCell>
      <TableCell className="text-right tabular-nums">{windowValue(m, 30)}</TableCell>
    </>
  );

  return (
    <DataCard
      title={`Por ${GROUP_LABELS[group].toLowerCase()}`}
      description={
        param
          ? `Valor que chegou em ${param}. Clique numa linha para abrir o próximo nível e no número de cadastros para ver os jogadores.`
          : group === "affiliate"
            ? "Código de afiliado ou de indicação que a casa mandou no cadastro. Clique no número de cadastros para ver os jogadores."
            : "Clique numa linha para ver as fontes e campanhas dela, e no número de cadastros para ver os jogadores."
      }
      {...tourAnchor("midia.origem.tabela")}
    >
      {empty ? (
        <EmptyState
          title="Nada com esse filtro"
          description="Nenhum cadastro do período bate com o caminho, a busca ou o filtro escolhido."
        />
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden px-2 pb-2 md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUP_LABELS[group]}</TableHead>
                  <TableHead className="text-right">Cadastros</TableHead>
                  <TableHead className="text-right">1º depósito</TableHead>
                  <TableHead className="text-right">Conversão</TableHead>
                  <TableHead className="text-right">Depósito líquido</TableHead>
                  <TableHead
                    className="text-right"
                    title="Depósitos menos saques nos 7 primeiros dias, dividido pelos cadastros que já têm 7 dias"
                  >
                    Líquido por cadastro em 7 dias
                  </TableHead>
                  <TableHead
                    className="text-right"
                    title="Depósitos menos saques nos 30 primeiros dias, dividido pelos cadastros que já têm 30 dias"
                  >
                    em 30 dias
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ row, display }) => {
                  const canOpen = nextGroup(group, row.key) != null;
                  return (
                    <TableRow
                      key={row.key ?? "(vazio)"}
                      className={cn(canOpen && "cursor-pointer")}
                      onClick={
                        canOpen
                          ? () => actions.onOpen({ key: row.key, name: display.name })
                          : undefined
                      }
                    >
                      <TableCell className="max-w-[24rem]">
                        <NameCell
                          group={group}
                          row={row}
                          display={display}
                          canOpen={canOpen}
                          actions={actions}
                        />
                      </TableCell>
                      {metricCells(row, () => playersOf(row.key, display.name))}
                    </TableRow>
                  );
                })}
                {data.others.count > 0 && (
                  <TableRow className="text-muted-foreground">
                    <TableCell>
                      Outros {num(data.others.count)} (use a busca para achar um deles)
                    </TableCell>
                    {metricCells(data.others)}
                  </TableRow>
                )}
                {data.noOrigin.signups > 0 && (
                  <TableRow className="text-muted-foreground">
                    <TableCell>
                      {CHANNEL_LABELS.sem_origem}
                      <span className="block text-meta">sem UTM, sem afiliado e sem clique</span>
                    </TableCell>
                    {metricCells(data.noOrigin, () =>
                      playersOf(null, CHANNEL_LABELS.sem_origem, noOriginFilters),
                    )}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Celular */}
          <ul className="space-y-2 px-3 pb-3 md:hidden">
            {rows.map(({ row, display }) => {
              const canOpen = nextGroup(group, row.key) != null;
              return (
                <li
                  key={row.key ?? "(vazio)"}
                  className="rounded-xl border border-border bg-background/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <NameText group={group} row={row} display={display} />
                    <EditActions group={group} row={row} canEdit={actions.canEdit} />
                    {canOpen && (
                      <button
                        type="button"
                        aria-label={`Abrir ${display.name}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground"
                        onClick={() => actions.onOpen({ key: row.key, name: display.name })}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <MobileMetrics m={row} money={money} rate={rate(row)} />
                  <button
                    type="button"
                    className="mt-2 text-meta text-primary"
                    onClick={() => playersOf(row.key, display.name)}
                  >
                    Ver jogadores
                  </button>
                </li>
              );
            })}
            {data.others.count > 0 && (
              <li className="rounded-xl border border-border p-3 text-muted-foreground">
                <p className="text-sm">Outros {num(data.others.count)}</p>
                <MobileMetrics m={data.others} money={money} rate={rate(data.others)} />
              </li>
            )}
            {data.noOrigin.signups > 0 && (
              <li className="rounded-xl border border-border p-3 text-muted-foreground">
                <p className="text-sm">{CHANNEL_LABELS.sem_origem}</p>
                <MobileMetrics
                  m={data.noOrigin}
                  money={money}
                  rate={pct(conversion(data.noOrigin))}
                />
              </li>
            )}
          </ul>
        </>
      )}
    </DataCard>
  );
}

type Display = ReturnType<typeof rowDisplay>;
type RowLike = OriginBreakdown["rows"][number];

const SOURCE_NOTE: Record<NonNullable<Display["source"]>, string> = {
  label: "nome dado pela casa",
  meta: "nome da Meta",
  expert: "código",
};

function NameText({ group, row, display }: { group: OriginGroup; row: RowLike; display: Display }) {
  const hint = group === "channel" ? CHANNEL_HINTS[row.key ?? ""] : null;
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium" title={display.detail ?? display.name}>
        {display.name}
        {display.unnamedId && (
          <span className="ml-1.5 text-meta font-normal text-muted-foreground">(sem nome)</span>
        )}
      </span>
      {display.detail && (
        <span className="block truncate font-mono text-meta text-muted-foreground">
          {display.detail}
          {display.source && ` · ${SOURCE_NOTE[display.source]}`}
        </span>
      )}
      {hint && <span className="block text-meta text-muted-foreground">{hint}</span>}
    </span>
  );
}

function EditActions({
  group,
  row,
  canEdit,
}: {
  group: OriginGroup;
  row: RowLike;
  canEdit: boolean;
}) {
  if (!canEdit || row.key == null) return null;
  const value = row.raw ?? row.key;
  return (
    <span className="flex shrink-0 items-center">
      {canLabel(group, row.key) && group !== "channel" && (
        <LabelEditor group={group} value={value} current={row.label} />
      )}
      {canRule(group, row.key) &&
        (group === "source" || group === "medium" || group === "campaign") && (
          <ChannelRuleButton group={group} value={value} />
        )}
    </span>
  );
}

function NameCell({
  group,
  row,
  display,
  canOpen,
  actions,
}: {
  group: OriginGroup;
  row: RowLike;
  display: Display;
  canOpen: boolean;
  actions: RowActions;
}) {
  return (
    <div className="flex items-center gap-1">
      <NameText group={group} row={row} display={display} />
      <EditActions group={group} row={row} canEdit={actions.canEdit} />
      {canOpen && (
        <button
          type="button"
          aria-label={`Abrir ${display.name}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            actions.onOpen({ key: row.key, name: display.name });
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function MobileMetrics({ m, money, rate }: { m: OriginMetrics; money: Money; rate: string }) {
  return (
    <dl className="mt-2 grid grid-cols-3 gap-2 text-[13px]">
      <div>
        <dt className="text-meta text-muted-foreground">Cadastros</dt>
        <dd className="tabular-nums">{num(m.signups)}</dd>
      </div>
      <div>
        <dt className="text-meta text-muted-foreground">1º depósito</dt>
        <dd className="tabular-nums">
          {num(m.ftd)} <span className="text-muted-foreground">· {rate}</span>
        </dd>
      </div>
      <div>
        <dt className="text-meta text-muted-foreground">Líquido</dt>
        <dd className="tabular-nums">{money(net(m))}</dd>
      </div>
    </dl>
  );
}

/** Estado vazio: a casa ainda não manda UTM. Ensina a montar o link. */
function UtmHelp() {
  const [base, setBase] = useState("");
  const [source, setSource] = useState("");
  const [medium, setMedium] = useState("");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [term, setTerm] = useState("");
  const link = base ? buildUtmLink(base, { source, medium, campaign, content, term }) : null;

  const applyMeta = () => {
    setSource(META_UTM_PRESET.source);
    setMedium(META_UTM_PRESET.medium);
    setCampaign(META_UTM_PRESET.campaign);
    setTerm(META_UTM_PRESET.term);
    setContent(META_UTM_PRESET.content);
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copiado");
    } catch {
      toast.error("Não foi possível copiar. Selecione o link e copie à mão.");
    }
  };

  return (
    <DataCard {...tourAnchor("midia.origem.montar-link")}>
      <EmptyState
        icon={<Link2 />}
        title="Ainda não sabemos de onde vêm seus cadastros"
        description="UTM são etiquetas no fim do link do anúncio (utm_source, utm_campaign…) que dizem de onde a pessoa veio. Sem elas, todo cadastro cai em “Sem origem informada”."
      />
      <div className="space-y-3 px-4 pb-5 sm:px-5">
        <p className="text-sm text-muted-foreground">
          1. Monte o link com UTM e use nos anúncios, lives e influenciadores. 2. Peça para a
          plataforma da casa repassar as UTMs no webhook de cadastro.
        </p>
        <Input
          aria-label="Link da casa"
          placeholder="https://suacasa.com/cadastro"
          value={base}
          onChange={(event) => setBase(event.target.value)}
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            aria-label="Fonte (utm_source)"
            placeholder="Fonte: instagram, kwai, tiktok"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <Input
            aria-label="Meio (utm_medium)"
            placeholder="Meio: paid, live, influencer"
            value={medium}
            onChange={(event) => setMedium(event.target.value)}
          />
          <Input
            aria-label="Campanha (utm_campaign)"
            placeholder="Campanha: black_novembro"
            value={campaign}
            onChange={(event) => setCampaign(event.target.value)}
          />
          <Input
            aria-label="Conjunto (utm_term)"
            placeholder="Conjunto (opcional)"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <Input
            aria-label="Anúncio (utm_content)"
            placeholder="Anúncio (opcional)"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <Button variant="outline" onClick={applyMeta}>
            Preencher para Meta Ads
          </Button>
        </div>
        {base && !link && (
          <p className="text-sm text-warning">Coloque o link completo, começando com https://</p>
        )}
        {link && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 p-3">
            <code className="min-w-0 flex-1 break-all text-[13px]">{link}</code>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => void copy()}>
              <Copy className="h-3.5 w-3.5" /> Copiar
            </Button>
          </div>
        )}
      </div>
    </DataCard>
  );
}
