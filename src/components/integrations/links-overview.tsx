import { useQuery } from "@tanstack/react-query";

import { HomeCard, KpiCard, MetricRow } from "@/components/home/home-cards";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { useUpdatedAgo } from "@/hooks/use-updated-ago";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";
import { num } from "@/lib/format";
import { getLinkTrackingOverview } from "@/lib/shortio.functions";
import { linkOriginLabel } from "./link-labels";

function pct(value: number) {
  return `${(value * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

const syncStatusLabels: Record<string, string> = {
  completed: "leitura concluída",
  running: "leitura em andamento",
  failed: "leitura falhou",
};

/** Links curtos: envios e cliques dos últimos 30 dias (agregados no banco). */
export function LinksOverview() {
  const isDemo = useIsDemoTenant();
  const overview = useQuery({
    queryKey: ["shortio-overview"],
    queryFn: () => getLinkTrackingOverview(),
  });
  const data = overview.data;
  const lastSync = data?.lastSync;
  const syncTs = lastSync?.finished_at ? Date.parse(lastSync.finished_at) : undefined;
  const syncAgo = useUpdatedAgo(Number.isFinite(syncTs) ? syncTs : undefined);
  const ctr = data?.sent ? data.clicks / data.sent : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {overview.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
        ) : (
          <>
            <KpiCard title="Links enviados" value={num(data?.sent)} detail="últimos 30 dias" />
            <KpiCard title="Cliques" value={num(data?.clicks)} detail="últimos 30 dias" />
            <KpiCard title="Taxa de clique" value={pct(ctr)} detail="cliques ÷ links enviados" />
          </>
        )}
      </div>

      <p className="text-meta text-muted-foreground">
        {lastSync ? (
          <>
            {syncTs ? `Atualizado ${syncAgo} · ` : ""}
            {num(lastSync.links_processed)} links lidos ·{" "}
            {syncStatusLabels[lastSync.status ?? ""] ?? "leitura sem estado"}
            {lastSync.error ? ` · ${lastSync.error}` : ""}
          </>
        ) : (
          "A leitura de cliques ainda não rodou para esta casa."
        )}
      </p>

      <HomeCard className="p-4 sm:p-5">
        <h2 className="text-section font-semibold">Por canal e origem</h2>
        <div className="mt-2">
          {overview.isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          ) : overview.isError ? (
            <p className="py-3 text-sm text-danger">
              Não foi possível carregar os números de links. Tente de novo em instantes.
            </p>
          ) : !data?.rows.length ? (
            <p className="py-3 text-sm text-muted-foreground">
              {isDemo ? DEMO_EMPTY_STATE_TEXT : "Nenhum link enviado nos últimos 30 dias."}
            </p>
          ) : (
            data.rows.map((row) => (
              <MetricRow
                key={`${row.channel}:${row.sourceType}`}
                label={linkOriginLabel(row.channel, row.sourceType)}
                value={`${num(row.clicks)} cliques / ${num(row.sent)} envios (${pct(row.ctr)})`}
              />
            ))
          )}
        </div>
      </HomeCard>
    </div>
  );
}
