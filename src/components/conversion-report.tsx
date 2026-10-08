import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getConversionReport } from "@/lib/conversion-report.functions";

export function ConversionReport({
  sourceType,
  sourceId,
}: {
  sourceType: "campaign" | "journey";
  sourceId: string;
}) {
  const query = useQuery({
    queryKey: ["conversion-report", sourceType, sourceId],
    queryFn: () => getConversionReport({ data: { sourceType, sourceId } }),
  });
  if (query.isLoading) return <main className="p-6">Carregando relatório…</main>;
  if (query.isError || !query.data)
    return <main className="p-6">Não foi possível carregar o relatório.</main>;
  const data = query.data;
  const denominator = data.sent || 0;
  const rate = (value: number) =>
    denominator ? `${((value / denominator) * 100).toFixed(1)}%` : "—";
  const stages = [
    ["Enviado", data.sent, rate(data.sent)],
    ["Entregue", data.delivered, "Indisponível: sem callback confiável"],
    ["Clique", data.clicked, "Indisponível: sincronização por destinatário pendente"],
    [
      sourceType === "journey" ? "Login ou jogo" : "Cadastro",
      sourceType === "journey" ? data.loginOrGame : data.registered,
      rate(sourceType === "journey" ? data.loginOrGame : data.registered),
    ],
    ["Depósito aprovado", data.deposits, rate(data.deposits)],
  ] as const;
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Relatório de conversão</h1>
          <p className="text-sm text-muted-foreground">
            Último clique rastreado · janela de 7 dias · America/Sao_Paulo
          </p>
        </div>
        <Link to={sourceType === "campaign" ? "/campanhas" : "/jornadas"}>Voltar</Link>
      </div>
      {data.historical ? (
        <div className="rounded-lg border p-4 text-sm">
          Ainda não há envios rastreáveis desta origem. Dados históricos não recebem atribuição
          retroativa.
        </div>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-5">
            {stages.map(([label, value, detail]) => (
              <div className="rounded-lg border p-4" key={label}>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold">{value ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{detail}</p>
              </div>
            ))}
          </section>
          <section className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">Receita diretamente atribuída</p>
            <p className="text-3xl font-semibold">
              {data.revenue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
            </p>
            <p className="text-sm text-muted-foreground">
              FTD: {data.ftd} · Atualizado:{" "}
              {data.latest ? new Date(data.latest).toLocaleString("pt-BR") : "—"}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
