import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui-premium";
import { getLinkTrackingOverview } from "@/lib/shortio.functions";

export const Route = createFileRoute("/links")({ component: LinksPage });

function LinksPage() {
  const overview = useQuery({
    queryKey: ["shortio-overview"],
    queryFn: () => getLinkTrackingOverview(),
  });
  const data = overview.data;
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Links rastreados"
        description="Cliques Short.io dos últimos 30 dias."
        icon={<Link2 className="h-5 w-5" />}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Metric title="Links enviados" value={data?.sent ?? 0} />
        <Metric title="Cliques" value={data?.clicks ?? 0} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> Por canal e origem
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <p>Carregando métricas…</p>
          ) : (
            <div className="space-y-2">
              {data?.rows.map((row) => (
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
              )) ?? <p>Sem links enviados no período.</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
function Metric({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold">{value.toLocaleString("pt-BR")}</p>
      </CardContent>
    </Card>
  );
}
