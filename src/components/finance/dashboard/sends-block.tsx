// "Envios e CRM" (spec §3.2.3, §3.3, §4.2): one row per channel (SMS, Voz,
// E-mail) with quantity, cost, unit cost and the cost variation; the total
// Envios; the CRM's direct and influenced revenue, each with its return
// (revenue ÷ Envios). A channel whose provider cost is not registered says so
// instead of showing R$ 0; the total then reads "R$ X + custo do provedor não
// cadastrado" and the returns are marked "parcial". The notes about this block (no Betleads data
// before a date, exempt house priced at provider cost) sit here, not in a
// page footer (spec §3.6).
import type { ReactNode } from "react";

import { FINANCE_TERMS } from "@/components/finance/definitions";
import {
  betleadsMissingNote,
  formatBRL,
  formatInt,
  formatRatio,
} from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { FinanceKpis, SendLine } from "@/lib/finance/types";

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

function Row({
  id,
  label,
  detail,
  value,
  variation,
  strong,
}: {
  id: string;
  label: ReactNode;
  detail?: ReactNode;
  value: ReactNode;
  variation?: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      data-send={id}
      className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5 text-sm last:border-0"
    >
      <div className="min-w-0">
        <p className={strong ? "font-medium" : undefined}>{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className={strong ? "font-semibold" : undefined}>{value}</p>
        {variation}
      </div>
    </div>
  );
}

export function SendsBlock({
  lines,
  kpis,
  exemptHouse,
  betleadsNote,
}: {
  lines: SendLine[];
  kpis: { current: FinanceKpis; previous: FinanceKpis };
  exemptHouse: boolean;
  /** sendsBetleadsNote(range.from, betleadsSince). */
  betleadsNote: string | null;
}) {
  const { current, previous } = kpis;

  return (
    <div>
      {lines.length === 0 && (
        <p className="py-1.5 text-sm text-muted-foreground">Sem envios no período.</p>
      )}
      {lines.map((line) => (
        <Row
          key={line.item}
          id={line.item}
          label={line.label}
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
            line.missingCost ? undefined : (
              <Variation current={line.amount} previous={line.previousAmount} invert />
            )
          }
        />
      ))}
      <Row
        id="total"
        strong
        label={
          <>
            {FINANCE_TERMS.sends.label}
            <TermTooltip term="sends" />
          </>
        }
        value={<SendCostAmount amount={current.sendCost} incomplete={current.sendCostIncomplete} />}
        variation={<Variation current={current.sendCost} previous={previous.sendCost} invert />}
      />
      <Row
        id="direct"
        label="Receita direta"
        value={formatBRL(current.crmDirectRevenue)}
        variation={
          <Variation current={current.crmDirectRevenue} previous={previous.crmDirectRevenue} />
        }
      />
      <Row
        id="direct-return"
        label="Retorno direto"
        value={
          <>
            {formatRatio(current.crmDirectReturn)}
            <Partial show={current.sendCostIncomplete && current.crmDirectReturn !== null} />
          </>
        }
        variation={
          <Variation current={current.crmDirectReturn} previous={previous.crmDirectReturn} points />
        }
      />
      <Row
        id="influenced"
        label="Receita influenciada"
        value={formatBRL(current.crmInfluencedRevenue)}
        variation={
          <Variation
            current={current.crmInfluencedRevenue}
            previous={previous.crmInfluencedRevenue}
          />
        }
      />
      <Row
        id="influenced-return"
        label="Retorno influenciado"
        value={
          <>
            {formatRatio(current.crmInfluencedReturn)}
            <Partial show={current.sendCostIncomplete && current.crmInfluencedReturn !== null} />
          </>
        }
        variation={
          <Variation
            current={current.crmInfluencedReturn}
            previous={previous.crmInfluencedReturn}
            points
          />
        }
      />
      {(betleadsNote || exemptHouse) && (
        <div className="space-y-1 pt-2 text-xs text-muted-foreground">
          {betleadsNote && <p data-note="betleads">{betleadsNote}</p>}
          {exemptHouse && <p data-note="exempt">{EXEMPT_HOUSE_NOTE}</p>}
        </div>
      )}
    </div>
  );
}
