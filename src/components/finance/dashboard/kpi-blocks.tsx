// Blocos de KPIs (spec §3.2.3): four titled blocks — Movimentação,
// Aquisição, GGR and Envios e CRM (SendsBlock) — two per row from `sm` up,
// one column on a phone. Each row has its variation vs the compared window;
// ratios vary in percentage points and the cost-shaped rows (anúncios,
// saques, custos) invert the color. The Meta KPIs (CPM, CTR, Custo por
// clique) only show when the house has Meta data (not null). Relies on a
// TooltipProvider above it (the dashboard root).
import type { ReactNode } from "react";

import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { formatBRL, formatInt, formatPct } from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { FinanceKpis, PeriodSummary, SendLine } from "@/lib/finance/types";

import { SendsBlock } from "./sends-block";
import { Variation } from "./variation";

/** Rule 6 of the GGR do mês: the window holds only part of a month whose GGR came as a total. */
export const GGR_ESTIMATED_NOTE = "GGR estimado a partir do total do mês.";

type Format = "money" | "int" | "pct" | "decimal";

type KpiRow = {
  key: string;
  label: string;
  term?: TermKey;
  format: Format;
  current: number | null;
  previous: number | null;
  /** Secondary line under the label (e.g. the count next to an amount). */
  detail?: string;
  invert?: boolean;
};

function formatDecimal(value: number | null) {
  if (value === null) return "n.a.";
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function formatValue(format: Format, value: number | null) {
  if (format === "money") return formatBRL(value);
  if (format === "pct") return formatPct(value);
  if (format === "decimal") return formatDecimal(value);
  return formatInt(value);
}

function KpiRowView({ row }: { row: KpiRow }) {
  return (
    <div
      data-kpi={row.key}
      className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5 text-sm last:border-0"
    >
      <div className="min-w-0">
        <p>
          {row.label}
          {row.term && <TermTooltip term={row.term} />}
        </p>
        {row.detail && <p className="text-xs text-muted-foreground">{row.detail}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p>{formatValue(row.format, row.current)}</p>
        <Variation
          current={row.current}
          previous={row.previous}
          points={row.format === "pct"}
          invert={row.invert}
        />
      </div>
    </div>
  );
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-block={id} className="rounded-lg border border-border/40 p-3">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const count = (value: number, singular: string, plural: string) =>
  `${formatInt(value)} ${value === 1 ? singular : plural}`;

export function KpiBlocks({
  totals,
  kpis,
  sends,
  exemptHouse,
  betleadsNote,
}: {
  totals: { current: PeriodSummary; previous: PeriodSummary };
  kpis: { current: FinanceKpis; previous: FinanceKpis };
  sends: SendLine[];
  exemptHouse: boolean;
  betleadsNote: string | null;
}) {
  const { current: s, previous: ps } = totals;
  const { current: k, previous: pk } = kpis;

  const movement: KpiRow[] = [
    {
      key: "deposits",
      label: "Depósitos",
      format: "money",
      current: s.depositAmount,
      previous: ps.depositAmount,
      detail: count(k.depositCount, "depósito", "depósitos"),
    },
    {
      key: "depositorsPerDay",
      label: "Depositantes por dia",
      format: "decimal",
      current: k.depositorsPerDay,
      previous: pk.depositorsPerDay,
    },
    {
      key: "ticketMedio",
      label: "Ticket médio",
      format: "money",
      current: k.ticketMedio,
      previous: pk.ticketMedio,
    },
    {
      key: "withdrawals",
      label: "Saques",
      format: "money",
      current: s.withdrawalAmount,
      previous: ps.withdrawalAmount,
      detail: count(k.withdrawalCount, "saque", "saques"),
      invert: true,
    },
    {
      key: "saqueMedio",
      label: "Saque médio",
      format: "money",
      current: k.saqueMedio,
      previous: pk.saqueMedio,
      invert: true,
    },
    {
      key: "net",
      label: FINANCE_TERMS.net.label,
      term: "net",
      format: "money",
      current: s.net,
      previous: ps.net,
    },
    {
      key: "withdrawalShare",
      label: "Saques ÷ depósitos",
      format: "pct",
      current: k.withdrawalShare,
      previous: pk.withdrawalShare,
      invert: true,
    },
    {
      key: "pixConversion",
      label: "Pix gerado → pago",
      format: "pct",
      current: k.pixConversion,
      previous: pk.pixConversion,
    },
  ];

  const acquisition: KpiRow[] = [
    {
      key: "adSpend",
      label: "Anúncios",
      format: "money",
      current: s.adSpend,
      previous: ps.adSpend,
      invert: true,
    },
    {
      key: "registrations",
      label: "Cadastros",
      format: "int",
      current: s.registrations,
      previous: ps.registrations,
    },
    { key: "ftds", label: "FTDs", format: "int", current: s.ftds, previous: ps.ftds },
    {
      key: "registrationToFtd",
      label: "Cadastro → FTD",
      format: "pct",
      current: k.registrationToFtd,
      previous: pk.registrationToFtd,
    },
    {
      key: "costPerRegistration",
      label: "Custo por cadastro",
      format: "money",
      current: s.costPerRegistration,
      previous: ps.costPerRegistration,
      invert: true,
    },
    {
      key: "costPerFtd",
      label: "Custo por FTD",
      format: "money",
      current: s.costPerFtd,
      previous: ps.costPerFtd,
      invert: true,
    },
    {
      key: "ftdMedio",
      label: "FTD médio",
      format: "money",
      current: k.ftdMedio,
      previous: pk.ftdMedio,
    },
    // From the Meta: only when the house has impressions in the window.
    ...(k.cpm !== null
      ? [
          {
            key: "cpm",
            label: "CPM",
            format: "money",
            current: k.cpm,
            previous: pk.cpm,
            invert: true,
          } satisfies KpiRow,
        ]
      : []),
    ...(k.ctr !== null
      ? [
          {
            key: "ctr",
            label: "CTR",
            format: "pct",
            current: k.ctr,
            previous: pk.ctr,
          } satisfies KpiRow,
        ]
      : []),
    ...(k.costPerClick !== null
      ? [
          {
            key: "costPerClick",
            label: "Custo por clique",
            format: "money",
            current: k.costPerClick,
            previous: pk.costPerClick,
            invert: true,
          } satisfies KpiRow,
        ]
      : []),
  ];

  const ggr: KpiRow[] = [
    {
      key: "ggr",
      label: FINANCE_TERMS.ggr.label,
      term: "ggr",
      format: "money",
      current: s.ggr,
      previous: ps.ggr,
    },
    {
      key: "ggrFee",
      label: FINANCE_TERMS.ggrFee.label,
      term: "ggrFee",
      format: "money",
      current: s.ggrFee,
      previous: ps.ggrFee,
      invert: true,
    },
    {
      key: "ggrShareOfDeposits",
      label: "GGR ÷ depósitos",
      format: "pct",
      current: k.ggrShareOfDeposits,
      previous: pk.ggrShareOfDeposits,
    },
  ];

  const rows = (list: KpiRow[]) => list.map((row) => <KpiRowView key={row.key} row={row} />);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Block id="movement" title="Movimentação">
        {rows(movement)}
      </Block>
      <Block id="acquisition" title="Aquisição">
        {rows(acquisition)}
      </Block>
      <Block id="ggr" title="GGR">
        {rows(ggr)}
        {s.ggrEstimated && (
          <p data-note="ggr-estimated" className="pt-2 text-xs text-muted-foreground">
            {GGR_ESTIMATED_NOTE}
          </p>
        )}
      </Block>
      <Block id="sends" title="Envios e CRM">
        <SendsBlock
          lines={sends}
          kpis={kpis}
          exemptHouse={exemptHouse}
          betleadsNote={betleadsNote}
        />
      </Block>
    </div>
  );
}
