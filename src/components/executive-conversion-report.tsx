import { useQuery } from "@tanstack/react-query";
import { getExecutiveConversionReport } from "@/lib/conversion-p2.functions";

const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function ExecutiveConversionReport() {
  const query = useQuery({
    queryKey: ["executive-conversion-report", 30],
    queryFn: () => getExecutiveConversionReport({ data: {} }),
  });
  if (query.isLoading) return <main className="p-6">Carregando relatório executivo…</main>;
  if (query.isError || !query.data)
    return <main className="p-6">Não foi possível carregar o relatório executivo.</main>;
  const { rows, totals, from, to } = query.data;
  const ordered = [...rows].sort((a, b) => b.directRevenue - a.directRevenue);
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Conversão executiva</h1>
        <p className="text-sm text-muted-foreground">
          Últimos 30 dias · {new Date(from).toLocaleDateString("pt-BR")} a{" "}
          {new Date(to).toLocaleDateString("pt-BR")}
        </p>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Envios rastreados" value={totals.sent.toLocaleString("pt-BR")} />
        <Metric label="Conversões diretas" value={totals.conversions.toLocaleString("pt-BR")} />
        <Metric label="Receita direta" value={money(totals.directRevenue)} />
        <Metric
          label="Receita assistida"
          value={money(totals.assistedRevenue)}
          hint="Separada · janela de 14 dias"
        />
      </section>
      <section className="overflow-hidden rounded-lg border">
        <div className="border-b p-4">
          <h2 className="font-semibold">Comparação equivalente</h2>
          <p className="text-xs text-muted-foreground">
            Mesma janela e mesmo modelo para todas as origens.
          </p>
        </div>
        {ordered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            Ainda não há origens rastreadas neste período.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="p-3">Origem</th>
                  <th className="p-3">Envios</th>
                  <th className="p-3">Conversões</th>
                  <th className="p-3">Taxa</th>
                  <th className="p-3">Receita direta</th>
                  <th className="p-3">Assistida</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => (
                  <tr className="border-t" key={`${row.sourceType}:${row.sourceId}`}>
                    <td className="p-3">
                      <span className="font-medium">{row.name}</span>
                      <br />
                      <span className="text-xs text-muted-foreground">{row.sourceId}</span>
                    </td>
                    <td className="p-3">{row.sent}</td>
                    <td className="p-3">{row.conversions}</td>
                    <td className="p-3">
                      {row.sent ? `${((row.conversions / row.sent) * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="p-3">{money(row.directRevenue)}</td>
                    <td className="p-3 text-muted-foreground">{money(row.assistedRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
