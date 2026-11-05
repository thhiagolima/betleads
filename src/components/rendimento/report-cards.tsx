// Relatório de rendimento, bloco 1 ("Resultado do período", spec §4): os
// quatro cartões com a variação contra o período anterior de mesma duração.
// Puramente apresentacional — os números vêm de `getExpertReport`.
import { Kpi } from "@/components/crm-results/shared";
import { useMoney } from "@/hooks/use-tenant-currency";
import type { ReportBlock } from "@/lib/expert-report.functions";
import { num } from "@/lib/format";

export type ReportVariacao = {
  depositado: number | null;
  ftds: number | null;
  redepositos: number | null;
  reativados: number | null;
};

const pct = (value: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "▲ 12,5%" (verde) / "▼ 3,0%" (vermelho), "0,0%" neutro sem variação, ou "—" sem base no período anterior. `value` já em percentual. */
export function VariationTag({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-xs font-medium text-muted-foreground">
        —<span className="sr-only"> sem base no período anterior</span>
      </span>
    );
  }
  if (value === 0) {
    return (
      <span className="text-xs font-medium text-muted-foreground">
        {pct(0)}%<span className="sr-only"> em relação ao período anterior</span>
      </span>
    );
  }
  return (
    <span className={`text-xs font-medium ${value >= 0 ? "text-success" : "text-danger"}`}>
      {value >= 0 ? "▲" : "▼"} {pct(Math.abs(value))}%
      <span className="sr-only"> em relação ao período anterior</span>
    </span>
  );
}

export function ReportCards({
  current,
  variacao,
}: {
  current: ReportBlock;
  variacao: ReportVariacao;
}) {
  // Depósitos creditados são valores da casa: moeda dela.
  const { money } = useMoney();
  const ticket = current.ticketRedeposito === null ? "—" : money(current.ticketRedeposito);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="Depositado creditado"
        value={money(current.depositado)}
        delta={<VariationTag value={variacao.depositado} />}
        detail={`clique ${money(current.depositadoClique)} · afiliado ${money(current.depositadoAfiliado)}`}
      />
      <Kpi
        label="FTDs"
        value={num(current.ftds)}
        delta={<VariationTag value={variacao.ftds} />}
        detail={`${money(current.valorFtd)} em 1º depósito`}
      />
      <Kpi
        label="Redepósitos"
        value={num(current.redepositos)}
        delta={<VariationTag value={variacao.redepositos} />}
        detail={`${money(current.valorRedeposito)} · ticket ${ticket}`}
      />
      <Kpi
        label="Reativados"
        value={num(current.reativados)}
        delta={<VariationTag value={variacao.reativados} />}
        detail="leads que estavam dormindo"
      />
    </div>
  );
}
