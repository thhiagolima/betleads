import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { getLinkTrackingOverview } from "@/lib/shortio.functions";

export const Route = createFileRoute("/links")({ component: LinksPage });

function LinksPage() {
  // /links é pai de /links/configuracoes: nas rotas filhas renderiza só a filha.
  const pathname = useLocation({ select: (l) => l.pathname });
  if (pathname !== "/links") return <Outlet />;
  return <LinksOverview />;
}

function LinksOverview() {
  const overview = useQuery({
    queryKey: ["shortio-overview"],
    queryFn: () => getLinkTrackingOverview(),
  });
  const data = overview.data;
  return (
    <Page>
      <PageHeader subtitle="Cliques Short.io dos últimos 30 dias." />
      <div className="grid gap-4 md:grid-cols-2">
        <Metric title="Links enviados" value={data?.sent ?? 0} />
        <Metric title="Cliques" value={data?.clicks ?? 0} />
      </div>
      <p className="text-xs text-muted-foreground">
        Último sync: {data?.lastSync?.finished_at ?? "ainda não executado"} ·{" "}
        {data?.lastSync?.links_processed ?? 0} links · {data?.lastSync?.status ?? "sem estado"}
        {data?.lastSync?.error ? ` · ${data.lastSync.error}` : ""}
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> Por canal e origem
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <p>Carregando métricas…</p>
          ) : overview.isError ? (
            <p className="text-sm text-destructive">
              Não foi possível carregar as métricas de links.
            </p>
          ) : !data?.rows.length ? (
            <p className="text-sm text-muted-foreground">Sem links enviados no período.</p>
          ) : (
            <div className="space-y-2">
              {data.rows.map((row) => (
                <div
                  key={`${row.channel}:${row.sourceType}`}
                  className="flex justify-between rounded border p-3 text-sm"
                >
                  <span>
                    {row.channel} · {row.sourceType}
                  </span>
                  <span>
                    {row.clicks} cliques / {row.sent} envios ({(row.ctr * 100).toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
function Metric({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-kpi tabular-nums">{value.toLocaleString("pt-BR")}</p>
      </CardContent>
    </Card>
  );
}
