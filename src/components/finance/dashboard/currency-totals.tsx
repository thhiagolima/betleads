// Totais por moeda: o lugar da faixa de resultado, da cascata, dos KPIs e do
// gráfico de 12 meses quando o escopo (grupo ou todas as casas) tem casas em
// moedas diferentes. Sem câmbio nada é somado entre moedas: uma linha por
// moeda, com os valores da casa nela; o Lucro líquido só existe em BRL. Os
// envios são BRL e somam todas as casas.
import { formatBRL, formatInt, formatMoneyIn } from "@/components/finance/format";
import type { TenantCurrency } from "@/lib/currency";
import { mixedCurrencyNote, profitComputable } from "@/lib/finance/money";
import type { PeriodSummary, SendLine } from "@/lib/finance/types";
import { round2 } from "@/lib/finance/calc";
import { cn } from "@/lib/utils";

export type CurrencyTotalRow = {
  currency: TenantCurrency;
  houses: number;
  current: PeriodSummary;
};

/** "Casas em BRL e ARS: os totais aparecem por moeda, sem conversão de câmbio." */
export function mixedScopeNote(currencies: TenantCurrency[]): string {
  const list =
    currencies.length > 1
      ? `${currencies.slice(0, -1).join(", ")} e ${currencies[currencies.length - 1]}`
      : (currencies[0] ?? "");
  return `Casas em ${list}: os totais aparecem por moeda, sem conversão de câmbio.`;
}

const COLUMNS: Array<{ key: string; label: string; pick: (s: PeriodSummary) => number | null }> = [
  { key: "depositAmount", label: "Depósitos", pick: (s) => s.depositAmount },
  { key: "withdrawalAmount", label: "Saques", pick: (s) => s.withdrawalAmount },
  { key: "net", label: "Net", pick: (s) => s.net },
  { key: "ggr", label: "GGR", pick: (s) => s.ggr },
  { key: "adSpend", label: "Anúncios", pick: (s) => s.adSpend },
  { key: "cashResult", label: "Lucro líquido", pick: (s) => s.cashResult },
];

export function CurrencyTotals({ rows, sends }: { rows: CurrencyTotalRow[]; sends: SendLine[] }) {
  const sendCost = round2(sends.reduce((total, line) => total + line.amount, 0));
  const partial = sends.some((line) => line.missingCost);
  const foreign = rows.filter((row) => !profitComputable(row.currency));

  return (
    <div className="space-y-3">
      <p data-note="mixed-scope" className="text-sm text-muted-foreground">
        {mixedScopeNote(rows.map((row) => row.currency))}
      </p>
      <div className="overflow-x-auto rounded-lg border border-border/40">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b border-border/40 text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 text-left">Moeda</th>
              <th className="px-3 py-2 text-right">Casas</th>
              {COLUMNS.map((column) => (
                <th key={column.key} className="px-3 py-2 text-right">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.currency}
                data-currency={row.currency}
                className="border-b border-border/20 last:border-0"
              >
                <td className="px-3 py-2 font-medium">{row.currency}</td>
                <td className="px-3 py-2 text-right">{formatInt(row.houses)}</td>
                {COLUMNS.map((column) => {
                  const value = column.pick(row.current);
                  return (
                    <td
                      key={column.key}
                      className={cn(
                        "whitespace-nowrap px-3 py-2 text-right tabular-nums",
                        value === null && "text-muted-foreground",
                        value !== null &&
                          column.key === "cashResult" &&
                          value < 0 &&
                          "text-rose-400",
                      )}
                    >
                      {value === null ? "—" : formatMoneyIn(value, row.currency)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Envios de todas as casas (BRL): </span>
        <span className="font-medium tabular-nums">{formatBRL(sendCost)}</span>
        {partial && (
          <span className="ml-1 text-xs text-amber-500 dark:text-amber-300">parcial</span>
        )}
      </p>
      {foreign.map((row) => (
        <p key={row.currency} className="text-xs text-muted-foreground">
          Lucro líquido em {row.currency} (—): {mixedCurrencyNote(row.currency)}.
        </p>
      ))}
    </div>
  );
}
