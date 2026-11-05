// Cartões de métricas da Área do Expert (Fase 3, Task 5): reaproveitados
// tanto no Início do próprio expert quanto no detalhe do admin (Task 6).
// Puramente apresentacional — não busca dados.
import { useMoney } from "@/hooks/use-tenant-currency";
import type { ExpertMetrics } from "@/lib/expert-metrics.functions";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Kpi } from "@/components/crm-results/shared";

export function ExpertMetricCards({
  metrics,
  className,
}: {
  metrics: ExpertMetrics;
  className?: string;
}) {
  // Depositado atribuído é valor da casa: moeda dela.
  const { money } = useMoney();
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>
      <Kpi
        label="Depositado atribuído"
        value={money(metrics.depositado)}
        detail={`por clique ${money(metrics.depositadoClique)} · por afiliado ${money(metrics.depositadoAfiliado)}`}
      />
      <Kpi label="Reativados" value={num(metrics.reativacoes)} />
      <Kpi label="Primeiros depósitos" value={num(metrics.ftds)} />
      <Kpi label="Cliques / links" value={`${num(metrics.cliques)} / ${num(metrics.links)}`} />
    </div>
  );
}
