// Blocos de KPIs (spec §3.2.3): four titled blocks — Movimentação,
// Aquisição, GGR and Envios e CRM (SendsBlock) — two per row from `sm` up,
// one column on a phone. Each block has a title, a one-line description and
// rows grouped under small headings; totals (Net) are emphasized. A row shows
// its variation vs the compared window only when there is one to show;
// ratios vary in percentage points and the cost-shaped rows (anúncios,
// saques, custos) invert the color. A value missing for a known reason reads
// "—" plus the reason ("sem anúncios", "não lançado"). The Meta KPIs (CPM,
// CTR, Custo por clique) only show when the house has Meta data (not null).
// Relies on a TooltipProvider above it (the dashboard root).

import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { formatBRL, formatInt, formatPct } from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { FinanceKpis, PeriodSummary, SendLine } from "@/lib/finance/types";

import { costPerPlayerReason, ggrNotLaunched, periodHasData } from "./display";
import { KpiBlock, KpiFooter, KpiRowShell, KpiSubheading } from "./kpi-row";
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
  /** Emphasized total row. */
  total?: boolean;
  /** The value is missing for a known reason: "—" plus `missing.reason`. */
  missing?: { reason: string | null };
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

function KpiRowView({ row, hasPrevious }: { row: KpiRow; hasPrevious: boolean }) {
  return (
    <KpiRowShell
      attrs={{ "data-kpi": row.key }}
      total={row.total}
      muted={!!row.missing}
      label={
        <>
          {row.label}
          {row.term && <TermTooltip term={row.term} />}
        </>
      }
      detail={row.detail}
      value={row.missing ? "—" : formatValue(row.format, row.current)}
      sub={row.missing?.reason ?? undefined}
      variation={
        row.missing ? undefined : (
          <Variation
            className="mt-0.5 block"
            current={row.current}
            previous={row.previous}
            hasPrevious={hasPrevious}
            points={row.format === "pct"}
            invert={row.invert}
          />
        )
      }
    />
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
  const hasPrevious = periodHasData(ps);
  const noAds = costPerPlayerReason(s);
  const ggrMissing = ggrNotLaunched(s);

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
      key: "withdrawals",
      label: "Saques",
      format: "money",
      current: s.withdrawalAmount,
      previous: ps.withdrawalAmount,
      detail: count(k.withdrawalCount, "saque", "saques"),
      invert: true,
    },
    {
      key: "net",
      label: FINANCE_TERMS.net.label,
      term: "net",
      format: "money",
      current: s.net,
      previous: ps.net,
      total: true,
    },
  ];

  const behavior: KpiRow[] = [
    {
      key: "ticketMedio",
      label: "Ticket médio",
      format: "money",
      current: k.ticketMedio,
      previous: pk.ticketMedio,
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
      key: "depositorsPerDay",
      label: "Depositantes por dia",
      format: "decimal",
      current: k.depositorsPerDay,
      previous: pk.depositorsPerDay,
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
    {
      key: "ftds",
      label: "FTDs",
      detail: "primeiros depósitos",
      format: "int",
      current: s.ftds,
      previous: ps.ftds,
    },
    {
      key: "registrationToFtd",
      label: "Cadastro → FTD",
      format: "pct",
      current: k.registrationToFtd,
      previous: pk.registrationToFtd,
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

  const costPerPlayer: KpiRow[] = [
    {
      key: "costPerRegistration",
      label: "Custo por cadastro",
      format: "money",
      current: s.costPerRegistration,
      previous: ps.costPerRegistration,
      invert: true,
      missing: noAds ? { reason: noAds } : undefined,
    },
    {
      key: "costPerFtd",
      label: "Custo por FTD",
      format: "money",
      current: s.costPerFtd,
      previous: ps.costPerFtd,
      invert: true,
      missing: noAds ? { reason: noAds } : undefined,
    },
  ];

  const ggr: KpiRow[] = [
    {
      key: "ggr",
      label: FINANCE_TERMS.ggr.label,
      term: "ggr",
      format: "money",
      current: s.ggr,
      previous: ps.ggr,
      missing: ggrMissing ? { reason: "não lançado" } : undefined,
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
      missing: ggrMissing ? { reason: null } : undefined,
    },
  ];

  const rows = (list: KpiRow[]) =>
    list.map((row) => <KpiRowView key={row.key} row={row} hasPrevious={hasPrevious} />);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <KpiBlock
        id="movement"
        title="Movimentação"
        description="Dinheiro que entrou e saiu da casa."
      >
        {rows(movement)}
        <KpiSubheading>Comportamento</KpiSubheading>
        {rows(behavior)}
      </KpiBlock>
      <KpiBlock id="acquisition" title="Aquisição" description="Quanto custou trazer jogadores.">
        {rows(acquisition)}
        <KpiSubheading>Custo por jogador</KpiSubheading>
        {rows(costPerPlayer)}
      </KpiBlock>
      <KpiBlock id="ggr" title="GGR" description="Perdas na casa e a taxa cobrada sobre elas.">
        {rows(ggr)}
        {s.ggrEstimated && (
          <KpiFooter>
            <span data-note="ggr-estimated">{GGR_ESTIMATED_NOTE}</span>
          </KpiFooter>
        )}
      </KpiBlock>
      <KpiBlock
        id="sends"
        title="Envios e CRM"
        description="Custo dos envios e o que eles trouxeram de volta."
      >
        <SendsBlock
          lines={sends}
          kpis={kpis}
          hasPrevious={hasPrevious}
          exemptHouse={exemptHouse}
          betleadsNote={betleadsNote}
        />
      </KpiBlock>
    </div>
  );
}
