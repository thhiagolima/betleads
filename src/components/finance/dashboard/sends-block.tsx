// "Envios e CRM" (spec §3.2.3, §3.3, §4.2): one row per channel (SMS, Voz,
// E-mail) with quantity, cost, unit cost and the cost variation (tagged
// "custo do provedor" in an exempt house); the emphasized Total de envios;
// under "Retorno do CRM", the direct and influenced revenue, each with its
// return (revenue ÷ Envios) as a multiple ("retorno 2,3×"). A channel whose
// provider cost is not registered says so instead of showing R$ 0; the total
// then reads "R$ X + custo do provedor não cadastrado" and the returns are
// marked "parcial". The notes about this block (no Betleads data before a
// date, exempt house priced at provider cost) sit in its muted footer, not
// in a page footer (spec §3.6).

import { betleadsMissingNote, formatBRL, formatInt } from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { FinanceKpis, SendLine } from "@/lib/finance/types";

import { formatMultiple } from "./display";
import { KpiFooter, KpiRowShell, KpiSubheading } from "./kpi-row";
import { Variation } from "./variation";

export const MISSING_PROVIDER_COST = "custo do provedor não cadastrado";

export const EXEMPT_HOUSE_NOTE = "Casa isenta: custo do provedor (situação atual da casa)";

/**
 * The "Sem dado de custo Betleads…" note when the window starts before the
 * scope's first Betleads data (or the scope has none); else null.
 */
export function sendsBetleadsNote(rangeFrom: string, betleadsSince: string | null): string | null {
  if (betleadsSince !== null && rangeFrom >= betleadsSince) return null;
  return betleadsMissingNote(betleadsSince);
}

const AMBER = "text-xs text-amber-500 dark:text-amber-300";

/**
 * An Envios amount that never reads as a real R$ 0 when a provider cost is
 * missing: "R$ X + custo do provedor não cadastrado", or only the text when
 * nothing has a cost.
 */
export function SendCostAmount({ amount, incomplete }: { amount: number; incomplete: boolean }) {
  if (!incomplete) return <>{formatBRL(amount)}</>;
  if (amount === 0) return <span className={AMBER}>{MISSING_PROVIDER_COST}</span>;
  return (
    <>
      {formatBRL(amount)} <span className={AMBER}>+ {MISSING_PROVIDER_COST}</span>
    </>
  );
}

/** "parcial" next to a value computed over a partial Envios. */
function Partial({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className={`ml-1 ${AMBER}`}>parcial</span>;
}

/** A unit cost keeps up to four decimals (e-mail costs R$ 0,0004). */
function formatUnitCost(value: number) {
  return value
    .toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })
    .replace(/\s/g, " "); // pt-BR puts a no-break space after "R$"
}

/** "retorno 2,3×" (+ "parcial"), or nothing when there is no return. */
function returnLine(value: number | null, partial: boolean) {
  if (value === null) return undefined;
  return (
    <>
      retorno {formatMultiple(value)}
      <Partial show={partial} />
    </>
  );
}

export function SendsBlock({
  lines,
  kpis,
  hasPrevious = true,
  exemptHouse,
  betleadsNote,
}: {
  lines: SendLine[];
  kpis: { current: FinanceKpis; previous: FinanceKpis };
  /** The compared period has data (periodHasData); variations hide otherwise. */
  hasPrevious?: boolean;
  exemptHouse: boolean;
  /** sendsBetleadsNote(range.from, betleadsSince). */
  betleadsNote: string | null;
}) {
  const { current, previous } = kpis;
  const variation = (cur: number | null, prev: number | null, invert = false) => (
    <Variation
      className="mt-0.5 block"
      current={cur}
      previous={prev}
      hasPrevious={hasPrevious}
      invert={invert}
    />
  );

  return (
    <div>
      {lines.length === 0 && (
        <p className="border-t border-border/50 py-[13px] text-sm text-muted-foreground">
          Sem envios no período.
        </p>
      )}
      {lines.map((line) => (
        <KpiRowShell
          key={line.item}
          attrs={{ "data-send": line.item }}
          label={
            <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {line.label}
              {exemptHouse && (
                <span
                  data-tag="provider-cost"
                  className="rounded-full border border-border px-2 text-[11px] text-muted-foreground"
                >
                  custo do provedor
                </span>
              )}
            </span>
          }
          detail={
            <>
              {formatInt(line.units)} {line.unitLabel}
              {!line.missingCost && line.unitCost !== null && (
                <> · {formatUnitCost(line.unitCost)} cada</>
              )}
            </>
          }
          value={
            line.missingCost ? (
              <span className="text-xs text-amber-300">{MISSING_PROVIDER_COST}</span>
            ) : (
              formatBRL(line.amount)
            )
          }
          variation={
            line.missingCost ? undefined : variation(line.amount, line.previousAmount, true)
          }
        />
      ))}
      <KpiRowShell
        attrs={{ "data-send": "total" }}
        total
        label={
          <>
            Total de envios
            <TermTooltip term="sends" />
          </>
        }
        value={<SendCostAmount amount={current.sendCost} incomplete={current.sendCostIncomplete} />}
        variation={variation(current.sendCost, previous.sendCost, true)}
      />
      <KpiSubheading>Retorno do CRM</KpiSubheading>
      <KpiRowShell
        attrs={{ "data-send": "direct" }}
        label="Receita direta"
        detail="clique → depósito"
        value={formatBRL(current.crmDirectRevenue)}
        sub={returnLine(current.crmDirectReturn, current.sendCostIncomplete)}
        variation={variation(current.crmDirectRevenue, previous.crmDirectRevenue)}
      />
      <KpiRowShell
        attrs={{ "data-send": "influenced" }}
        label="Receita influenciada"
        detail="regra da Central de Resultados"
        value={formatBRL(current.crmInfluencedRevenue)}
        sub={returnLine(current.crmInfluencedReturn, current.sendCostIncomplete)}
        variation={variation(current.crmInfluencedRevenue, previous.crmInfluencedRevenue)}
      />
      {(betleadsNote || exemptHouse) && (
        <KpiFooter>
          {exemptHouse && <span data-note="exempt">{EXEMPT_HOUSE_NOTE}.</span>}
          {exemptHouse && betleadsNote && " "}
          {betleadsNote && <span data-note="betleads">{betleadsNote}.</span>}
        </KpiFooter>
      )}
    </div>
  );
}
