// Display helpers for the finance close grid (spec §5). Money and fraction
// values that are missing render as "n.a." everywhere in that page, whether
// they are literally absent (no rate yet) or not applicable (division by
// zero upstream in src/lib/finance/calc.ts).

const NA = "n.a.";

/** toLocaleString("pt-BR", {style:"currency"}) puts a NBSP after "R$"; normalize to a plain space. */
function stripNbsp(value: string) {
  return value.replace(/ /g, " ");
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
