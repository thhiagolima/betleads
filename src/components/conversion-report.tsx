import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  exportConversionDrilldownCsv,
  getConversionDataHealth,
  getConversionDrilldown,
  getConversionReport,
} from "@/lib/conversion-report.functions";
import { ConversionExperimentPanel } from "@/components/conversion-experiment-panel";

export function ConversionReport({
  sourceType,
  sourceId,
}: {
  sourceType: "campaign" | "journey";
  sourceId: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const query = useQuery({
    queryKey: ["conversion-report", sourceType, sourceId],
    queryFn: () => getConversionReport({ data: { sourceType, sourceId } }),
  });
  const details = useQuery({
    queryKey: ["conversion-drilldown", sourceType, sourceId],
    queryFn: () => getConversionDrilldown({ data: { sourceType, sourceId, limit: 100 } }),
    enabled: detailsOpen,
    retry: false,
  });
  const health = useQuery({
    queryKey: ["conversion-data-health", sourceType, sourceId],
    queryFn: () => getConversionDataHealth({ data: { sourceType, sourceId } }),
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
    [
      "Entregue",
      data.delivered,
      data.delivered === null ? "Indisponível: sem callback confiável" : rate(data.delivered),
    ],
    [
      "Clique",
      data.clicked,
      data.clicked === null
        ? "Indisponível: sincronização pendente"
        : `${data.clicked.toLocaleString("pt-BR")} cliques agregados`,
    ],
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
          {health.data?.alerts.map((alert) => (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
              key={alert.code}
            >
              {alert.message}
            </div>
          ))}
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
            <p className="mt-2 text-sm text-muted-foreground">
              Receita assistida (8–14 dias, separada):{" "}
              {data.assistedRevenue.toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL",
              })}
            </p>
          </section>
          {data.canViewSensitive ? (
            <ConversionExperimentPanel sourceType={sourceType} sourceId={sourceId} />
          ) : null}
          {sourceType === "journey" && data.byStepChannel.length > 0 ? (
            <section className="rounded-lg border p-4">
              <h2 className="font-semibold">Desempenho por etapa e canal</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Cada destinatário conta uma vez por envio, mesmo quando a mensagem possui vários
                links.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Etapa</th>
                      <th className="p-2">Canal</th>
                      <th className="p-2">Enviados</th>
                      <th className="p-2">Entregues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byStepChannel.map((row) => (
                      <tr
                        className="border-b"
                        key={`${row.stepId ?? row.stepPosition}:${row.channel}`}
                      >
                        <td className="p-2">
                          {row.stepPosition === null ? "Legado" : `Etapa ${row.stepPosition + 1}`}
                        </td>
                        <td className="p-2 uppercase">{row.channel}</td>
                        <td className="p-2">{row.sent}</td>
                        <td className="p-2">{row.delivered || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {data.canViewSensitive ? (
            <section className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-semibold">Conversões auditáveis</h2>
                  <p className="text-xs text-muted-foreground">
                    Restrito a administradores e super administradores.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={() => setDetailsOpen(true)}
                  >
                    Ver conversões
                  </button>
                  <button
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={async () => {
                      const result = await exportConversionDrilldownCsv({
                        data: { sourceType, sourceId },
                      });
                      const url = URL.createObjectURL(
                        new Blob([result.csv], { type: "text/csv;charset=utf-8" }),
                      );
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `conversoes-${sourceId}.csv`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Exportar CSV
                  </button>
                </div>
              </div>
              {detailsOpen && details.isError ? (
                <p className="mt-3 text-sm text-destructive">
                  Acesso restrito ou falha ao carregar.
                </p>
              ) : null}
              {details.data ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Jogador</th>
                        <th className="p-2">Evento</th>
                        <th className="p-2">Data</th>
                        <th className="p-2">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.data.rows.map((row: any) => (
                        <tr className="border-b" key={`${row.event_type}:${row.event_id}`}>
                          <td className="p-2">
                            {row.players?.nome ?? "—"}
                            <br />
                            <span className="text-xs text-muted-foreground">
                              {row.players?.email ?? row.players?.telefone ?? ""}
                            </span>
                          </td>
                          <td className="p-2">{row.event_type}</td>
                          <td className="p-2">
                            {new Date(row.occurred_at).toLocaleString("pt-BR")}
                          </td>
                          <td className="p-2">
                            {Number(row.monetary_value ?? 0).toLocaleString("pt-BR", {
                              style: "currency",
                              currency: "BRL",
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
