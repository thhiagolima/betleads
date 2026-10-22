import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from "lucide-react";

import type { CrmMetricsWithRatios, CrmSource } from "@/lib/crm-results";
import { brl, num } from "@/lib/format";
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
import { type Data, isWaste, money, pct } from "./format";
import { EmptyCard, InfoTip, RoiValue } from "./shared";

type SortKey =
  | "name"
  | "sent"
  | "cost"
  | "clickRate"
  | "directPlayers"
  | "directRevenue"
  | "costPerConversion"
  | "clickRoi"
  | "influencedPlayers";

const COLUMNS: Array<{ key: SortKey; label: string; info?: string; align?: "left" }> = [
  { key: "sent", label: "Envios" },
  { key: "cost", label: "Custo em SMS" },
  { key: "clickRate", label: "Cliques", info: "SMS clicados e a taxa sobre os enviados." },
  {
    key: "directRevenue",
    label: "Recuperado pelo CRM",
    info: "Jogadores que clicaram e depositaram em até 7 dias, e o valor. A barra compara com a origem que mais converteu.",
    align: "left",
  },
  { key: "costPerConversion", label: "Custo / convertido" },
  {
    key: "clickRoi",
    label: "Retorno",
    info: "Recuperado pelo CRM ÷ custo. Verde paga o envio (1x ou mais), vermelho não paga. Menos de 5 convertidos: amostra pequena.",
  },
  {
    key: "influencedPlayers",
    label: "Recuperados (visão ampla)",
    info: "Parados há 2+ dias que voltaram até 3 dias após um SMS, com ou sem clique. Não some com o Recuperado pelo CRM.",
  },
];

const TYPE_FILTERS = [
  { key: "all", label: "Todas" },
  { key: "journey", label: "Jornadas" },
  { key: "campaign", label: "Campanhas" },
] as const;

const value = (source: CrmSource, key: SortKey): number | string => {
  if (key === "name") return source.name.toLocaleLowerCase("pt-BR");
  const raw = source[key];
  return raw == null ? -Infinity : raw;
};

export function Origins({
  data,
  search,
  onSearch,
}: {
  data: Data;
  search: string;
  onSearch: (value: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [type, setType] = useState<(typeof TYPE_FILTERS)[number]["key"]>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "directRevenue",
    desc: true,
  });

  const rows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    return data.sources
      .filter((source) => type === "all" || source.type === type)
      .filter((source) => !term || source.name.toLocaleLowerCase("pt-BR").includes(term))
      .sort((a, b) => {
        const left = value(a, sort.key);
        const right = value(b, sort.key);
        const order = left < right ? -1 : left > right ? 1 : 0;
        // Ties keep a stable, meaningful order: by cost, then name.
        return (
          (sort.desc ? -order : order) || b.cost - a.cost || a.name.localeCompare(b.name, "pt-BR")
        );
      });
  }, [data.sources, search, sort, type]);

  if (data.sources.length === 0)
    return <EmptyCard>Nenhuma jornada ou campanha com envio neste período.</EmptyCard>;

  const maxRevenue = Math.max(0, ...data.sources.map((source) => source.directRevenue));
  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key ? { key, desc: !current.desc } : { key, desc: key !== "name" },
    );

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="text-base">Origens</CardTitle>
          <CardDescription>
            Cada jornada e campanha do período. Clique no título de uma coluna para ordenar; abra
            uma jornada para ver cada mensagem.
          </CardDescription>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="inline-flex rounded-lg bg-muted p-1 text-sm"
            role="group"
            aria-label="Tipo"
          >
            {TYPE_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-pressed={type === filter.key}
                onClick={() => setType(filter.key)}
                className={
                  type === filter.key
                    ? "rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
                    : "px-3 py-1.5 text-muted-foreground"
                }
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm sm:w-64"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Buscar origem..."
              aria-label="Buscar origem"
            />
          </label>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="sticky left-0 z-10 min-w-56 bg-card"
                aria-sort={sort.key === "name" ? (sort.desc ? "descending" : "ascending") : "none"}
              >
                <SortButton
                  label="Origem"
                  active={sort.key === "name"}
                  desc={sort.desc}
                  onClick={() => toggleSort("name")}
                />
              </TableHead>
              {COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  className={column.align === "left" ? "min-w-44" : "text-right"}
                  aria-sort={
                    sort.key === column.key ? (sort.desc ? "descending" : "ascending") : "none"
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    <SortButton
                      label={column.label}
                      active={sort.key === column.key}
                      desc={sort.desc}
                      onClick={() => toggleSort(column.key)}
                    />
                    {column.info && <InfoTip text={column.info} />}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length + 1}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nenhuma origem com esse filtro.
                </TableCell>
              </TableRow>
            )}
            {rows.map((source) => {
              const id = `${source.type}:${source.key}`;
              const steps = source.steps.filter((step) => step.position >= 0 || step.sent > 0);
              const expandable = source.type === "journey" && steps.length > 1;
              const expanded = open === id;
              const names = (source.sourceId && data.stepNames[source.sourceId]) || {};
              return (
                <Fragment key={id}>
                  <TableRow>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <div className="flex items-start gap-1">
                        {expandable ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="-ml-2 h-7 w-7 shrink-0"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Fechar" : "Ver"} mensagens de ${source.name}`}
                            onClick={() => setOpen(expanded ? null : id)}
                          >
                            {expanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}
                        <SourceName source={source} />
                      </div>
                    </TableCell>
                    <MetricCells metrics={source} maxRevenue={maxRevenue} />
                  </TableRow>
                  {expanded &&
                    steps.map((step) => (
                      <TableRow key={`${id}:${step.position}`} className="bg-muted/30 text-xs">
                        <TableCell className="sticky left-0 z-10 bg-muted pl-10 text-muted-foreground">
                          {names[step.position] ??
                            (step.position < 0
                              ? "Sem etapa identificada"
                              : `Etapa ${step.position + 1}`)}
                        </TableCell>
                        <MetricCells metrics={step} maxRevenue={maxRevenue} compact />
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SortButton({
  label,
  active,
  desc,
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
    >
      {label}
      {active &&
        (desc ? (
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        ))}
    </button>
  );
}

function SourceName({ source }: { source: CrmSource }) {
  const label =
    source.type === "journey" ? "Jornada" : source.type === "campaign" ? "Campanha" : "Outro";
  return (
    <div className="min-w-0">
      {source.type === "journey" && source.sourceId ? (
        <Link
          to="/jornadas/$journeyId/relatorio"
          params={{ journeyId: source.sourceId }}
          className="font-medium hover:underline"
        >
          {source.name}
        </Link>
      ) : source.type === "campaign" && source.sourceId ? (
        <Link
          to="/campanhas/$campaignId/relatorio"
          params={{ campaignId: source.sourceId }}
          className="font-medium hover:underline"
        >
          {source.name}
        </Link>
      ) : (
        <span className="font-medium">{source.name}</span>
      )}
      <div className="mt-0.5 flex flex-wrap gap-1">
        <Badge variant="outline" className="text-[10px]">
          {label}
        </Badge>
        {isWaste(source) && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
          >
            gasta sem converter
          </Badge>
        )}
      </div>
    </div>
  );
}

function MetricCells({
  metrics,
  maxRevenue,
  compact = false,
}: {
  metrics: CrmMetricsWithRatios;
  maxRevenue: number;
  compact?: boolean;
}) {
  const share = maxRevenue > 0 ? metrics.directRevenue / maxRevenue : 0;
  const muted = <span className="text-muted-foreground">—</span>;
  return (
    <>
      <TableCell className="text-right tabular-nums">{num(metrics.sent)}</TableCell>
      <TableCell className="text-right tabular-nums">{brl(metrics.cost)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {num(metrics.humanClicks)}
        {metrics.clickRate != null && (
          <div className="text-xs text-muted-foreground">{pct(metrics.clickRate)}</div>
        )}
      </TableCell>
      <TableCell className="tabular-nums">
        {metrics.directPlayers === 0 ? (
          <span className="text-muted-foreground">nenhum</span>
        ) : (
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className={compact ? "font-medium" : "font-semibold"}>
                {num(metrics.directPlayers)} jog.
              </span>
              <span className="text-muted-foreground">{brl(metrics.directRevenue)}</span>
            </div>
            <div className="h-1 rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-1 rounded-full bg-emerald-500/70"
                style={{ width: `${Math.max(2, share * 100)}%` }}
              />
            </div>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {metrics.costPerConversion == null ? (
          muted
        ) : (
          <span className={metrics.smallSample ? "text-muted-foreground" : ""}>
            {money(metrics.costPerConversion)}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <RoiValue roi={metrics.clickRoi} smallSample={metrics.smallSample} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {metrics.influencedPlayers === 0 ? (
          "—"
        ) : (
          <>
            {num(metrics.influencedPlayers)}
            <div className="text-xs">{brl(metrics.influencedRevenue)}</div>
          </>
        )}
      </TableCell>
    </>
  );
}
