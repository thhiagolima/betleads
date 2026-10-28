// Display helpers for the finance close grid (spec §5). Money and fraction
// values that are missing render as "n.a." everywhere in that page, whether
// they are literally absent (no rate yet) or not applicable (division by
// zero upstream in src/lib/finance/calc.ts).

const NA = "n.a.";

/** The GGR value as the platforms' "GGR PAINEL" names it ("Taxa de GGR (x%)" stays as is). */
export const GGR_COLUMN_LABEL = "GGR (Perdas na casa)";

/** toLocaleString("pt-BR", {style:"currency"}) puts a NBSP after "R$"; normalize to a plain space. */
function stripNbsp(value: string) {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

export function formatBRL(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  return stripNbsp(
    value.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
}

/** A fraction (0.3855) as a one-decimal percentage ("38,6%"). */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  const percent = (value * 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${stripNbsp(percent)}%`;
}

/** Same shape as formatPct, used for ratios like ROI caixa (cashResult / adSpend). */
export function formatRatio(value: number | null | undefined): string {
  return formatPct(value);
}

/** An integer count (FTDs, cadastros) with pt-BR thousands separators ("1.234"). */
export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  return new Intl.NumberFormat("pt-BR").format(value);
}

/** A difference in percentage points (ROI vs ROI), signed: "+12,3 p.p.". */
export function formatPp(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  const points = Math.abs(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${value < 0 ? "-" : "+"}${stripNbsp(points)} p.p.`;
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2026-10" → "out" (chart axis) or "out/2026" (tooltip, notes). */
export function monthLabel(month: string, withYear = false) {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name}/${month.slice(0, 4)}` : name;
}

/**
 * The "no Betleads data" note (spec §7.2), the same wording in the 12-month
 * chart and the Lançamentos grid: "Sem dado de custo Betleads antes de
 * out/2026", or "Sem dado de custo Betleads" for a scope with no data at all.
 */
export function betleadsMissingNote(betleadsSince: string | null): string {
  return betleadsSince === null
    ? "Sem dado de custo Betleads"
    : `Sem dado de custo Betleads antes de ${monthLabel(betleadsSince.slice(0, 7), true)}`;
}

/**
 * Note under the month's Betleads cost: Betleads cost is only known from
 * `betleadsSince` (first day with data) on, so a month before it — or any
 * month of a house that never had data — shows that the zero means "no
 * data". `month` is "YYYY-MM".
 */
export function betleadsUsageNote(month: string, betleadsSince: string | null): string | null {
  if (betleadsSince !== null && month >= betleadsSince.slice(0, 7)) return null;
  return betleadsMissingNote(betleadsSince);
}
