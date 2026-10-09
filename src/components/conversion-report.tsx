import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import {
  exportCampaignRecipientsCsv,
  getCampaignReportDetails,
  getConversionDataHealth,
  getConversionReport,
} from "@/lib/conversion-report.functions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Recipient = {
  id: string;
  playerName: string;
  contact: string;
  sendStatus: string;
  deliveryStatus: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  clicked: boolean;
  clickCount: number;
  clickedAt: string | null;
  depositAt: string | null;
  depositValue: number;
  historicalDepositCount: number;
  historicalDepositValue: number;
};

type RecipientFilter =
  "all" | "sent" | "delivered" | "clicked" | "not-clicked" | "deposited" | "clicked-no-deposit";

const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const number = (value: number) => value.toLocaleString("pt-BR");
const dateTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

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
  const health = useQuery({
    queryKey: ["conversion-data-health", sourceType, sourceId],
    queryFn: () => getConversionDataHealth({ data: { sourceType, sourceId } }),
  });
  const campaignDetails = useQuery({
    queryKey: ["campaign-report-details", sourceId],
    queryFn: () => getCampaignReportDetails({ data: { campaignId: sourceId, limit: 500 } }),
    enabled: sourceType === "campaign",
  });

  if (query.isLoading || (sourceType === "campaign" && campaignDetails.isLoading))
    return <ReportState>Carregando relatório…</ReportState>;
  if (query.isError || !query.data)
    return <ReportState>Não foi possível carregar o relatório.</ReportState>;

  if (sourceType === "journey")
    return (
      <JourneyReport data={query.data} sourceId={sourceId} alerts={health.data?.alerts ?? []} />
    );

  return (
    <CampaignReport
      sourceId={sourceId}
      data={query.data}
      details={campaignDetails.data}
      detailsError={campaignDetails.isError}
      alerts={health.data?.alerts ?? []}
    />
  );
}

function CampaignReport({
  sourceId,
  data,
  details,
  detailsError,
  alerts,
}: {
  sourceId: string;
  data: Awaited<ReturnType<typeof getConversionReport>>;
  details: Awaited<ReturnType<typeof getCampaignReportDetails>> | undefined;
  detailsError: boolean;
  alerts: Array<{ code: string; message: string }>;
}) {
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const campaign = details?.campaign;
  const recipients = useMemo(
    () => (details?.recipients ?? []) as Recipient[],
    [details?.recipients],
  );
  const delivered = data.delivered ?? 0;
  const clicked = recipients.filter((row) => row.clicked).length || data.clicked || 0;
  const deposited = recipients.filter((row) => row.depositAt).length || data.deposits;
  const notClicked = Math.max(0, delivered - clicked);
  const clickedNoDeposit = Math.max(0, clicked - deposited);
  const audience = campaign?.total || campaign?.audience || details?.trackedDeliveries || data.sent;
  const filtered = useMemo(
    () =>
      recipients.filter((row) => {
        if (filter === "sent") return row.sendStatus === "sent";
        if (filter === "delivered") return row.deliveryStatus === "delivered";
        if (filter === "clicked") return row.clicked;
        if (filter === "not-clicked") return !row.clicked;
        if (filter === "deposited") return Boolean(row.depositAt);
        if (filter === "clicked-no-deposit") return row.clicked && !row.depositAt;
        return true;
      }),
    [filter, recipients],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const failureReasons = Object.entries(details?.failureReasons ?? {}).sort((a, b) => b[1] - a[1]);
  const directRevenue = data.revenue;
  const costPerReturn = deposited ? directRevenue / deposited : 0;

  const setActiveFilter = (next: RecipientFilter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm">
      <main className="mx-auto min-h-full max-w-5xl border-x border-border/70 bg-background shadow-2xl">
        <header className="sticky top-0 z-20 flex items-start justify-between gap-4 border-b border-border/70 bg-background/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Link
                to="/campanhas"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Voltar"
              >
                <ArrowLeft className="size-4" />
              </Link>
              <h1 className="truncate text-base font-bold">
                {campaign?.name ?? "Relatório da campanha"}
              </h1>
            </div>
            <p className="text-xs text-sky-400">
              {data.deposits
                ? `${number(data.deposits)} jogador${data.deposits === 1 ? "" : "es"} depositou após a campanha`
                : `${number(audience)} destinatários no público`}
            </p>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/campanhas" aria-label="Fechar relatório">
              <X className="size-4" />
            </Link>
          </Button>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          <section className="grid gap-3 rounded-xl bg-card/60 p-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
            <TimelineValue label="Criada em" value={dateTime(campaign?.createdAt)} />
            <TimelineValue label="Disparo iniciado" value={dateTime(campaign?.scheduledAt)} />
            <TimelineValue label="Disparo concluído" value={dateTime(campaign?.finishedAt)} />
            <TimelineValue
              label="Atribuição"
              value="até 7 dias após o clique"
              className="sm:col-span-2"
            />
            <TimelineValue
              label="Medição"
              value="link curto — clique é contado"
              className="sm:col-span-2 lg:col-span-3"
            />
          </section>

          {alerts.map((alert) => (
            <div
              key={alert.code}
              className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
              {alert.message}
            </div>
          ))}

          {campaign?.failed || failureReasons.length > 0 ? (
            <section className="rounded-2xl border border-border/80 p-4">
              <h2 className="mb-3 text-sm font-semibold">Por que não saiu</h2>
              <div className="space-y-2">
                {failureReasons.length ? (
                  failureReasons.slice(0, 4).map(([reason, count]) => (
                    <div key={reason} className="rounded-xl bg-card/60 p-3">
                      <p className="text-sm font-semibold">
                        <span className="mr-2 text-sky-300">{number(count)}</span>
                        {reason}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Este envio não foi aceito ou concluído pelo provedor.
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-card/60 p-3">
                    <p className="text-sm font-semibold">
                      <span className="mr-2 text-sky-300">{number(campaign?.failed ?? 0)}</span>Não
                      enviados
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      O provedor não retornou um motivo individual para estes destinatários.
                    </p>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Enviados" value={number(data.sent)} />
            <Metric label="Entregues" value={data.delivered === null ? "—" : number(delivered)} />
            <Metric
              label="Clicaram"
              value={data.clicked === null ? "—" : number(clicked)}
              hint={
                delivered
                  ? `${Math.round((clicked / delivered) * 100)}% de quem recebeu`
                  : undefined
              }
            />
            <Metric
              label="Depositaram"
              value={number(data.deposits)}
              hint={
                clicked
                  ? `${Math.round((data.deposits / clicked) * 100)}% de quem clicou`
                  : undefined
              }
              accent
            />
          </section>

          <section className="rounded-xl border border-emerald-500/10 bg-emerald-500/10 p-4">
            <p className="text-xs text-emerald-300">Total da campanha, desde o disparo</p>
            <p className="mt-1 text-2xl font-bold text-emerald-400">{money(directRevenue)}</p>
            <p className="mt-1 text-xs text-sky-300">
              de {number(data.deposits)} jogadores atribuídos pelo último clique em até 7 dias
            </p>
            {data.assistedRevenue > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Receita assistida, separada: {money(data.assistedRevenue)}
              </p>
            ) : null}
          </section>

          <section className="grid gap-2 sm:grid-cols-3">
            <Metric
              label={campaign?.channel === "email" ? "Consumo de e-mail" : "Consumo de SMS"}
              value={`${number(data.sent)} envios`}
              hint="custo financeiro indisponível"
            />
            <Metric label="ROAS" value="—" hint="aguardando custo confirmado" />
            <Metric
              label="Valor médio por jogador que voltou"
              value={deposited ? money(costPerReturn) : "—"}
              hint={`${number(deposited)} retornos atribuídos`}
            />
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">A mensagem que foi enviada</h2>
              <Button size="sm" asChild>
                <a href="/campanhas?newCampaign=1">Usar</a>
              </Button>
            </div>
            <div className="rounded-xl border bg-card/40 p-3 text-sm font-medium">
              {campaign?.content ?? "O conteúdo original não está disponível para esta campanha."}
            </div>
            <p className="mt-2 text-xs text-sky-300">
              Os links saíram encurtados e medidos. “Usar” abre uma nova campanha sem alterar esta.
            </p>
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Destinatários</h2>
              <Button
                size="sm"
                variant="ghost"
                disabled={!data.canViewSensitive}
                onClick={() => void downloadRecipients(sourceId)}
              >
                <Download className="mr-1.5 size-4" /> Baixar CSV
              </Button>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <FilterButton active={filter === "all"} onClick={() => setActiveFilter("all")}>
                Todos {number(audience)}
              </FilterButton>
              <FilterButton active={filter === "sent"} onClick={() => setActiveFilter("sent")}>
                Enviados {number(data.sent)}
              </FilterButton>
              <FilterButton
                active={filter === "delivered"}
                onClick={() => setActiveFilter("delivered")}
              >
                Entregues {number(delivered)}
              </FilterButton>
              <FilterButton
                active={filter === "clicked"}
                onClick={() => setActiveFilter("clicked")}
              >
                Clicaram {number(clicked)}
              </FilterButton>
              <FilterButton
                active={filter === "not-clicked"}
                onClick={() => setActiveFilter("not-clicked")}
              >
                Não clicaram {number(notClicked)}
              </FilterButton>
              <FilterButton
                active={filter === "deposited"}
                onClick={() => setActiveFilter("deposited")}
                tone="green"
              >
                Depositaram {number(deposited)}
              </FilterButton>
              <FilterButton
                active={filter === "clicked-no-deposit"}
                onClick={() => setActiveFilter("clicked-no-deposit")}
                tone="orange"
              >
                Clicaram e não depositaram {number(clickedNoDeposit)}
              </FilterButton>
            </div>

            {detailsError ? (
              <div className="rounded-xl border p-5 text-sm text-muted-foreground">
                Os totais estão disponíveis, mas não foi possível carregar a lista individual.
              </div>
            ) : recipients.length === 0 ? (
              <div className="rounded-xl border p-5 text-sm text-muted-foreground">
                Esta campanha não possui destinatários rastreáveis individualmente.
              </div>
            ) : (
              <>
                <RecipientTable rows={visible} />
                <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-sky-300">
                  <span>
                    {number(filtered.length)} linhas · página {page} de {pages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page === 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      <ChevronLeft className="mr-1 size-4" />
                      Anterior
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page === pages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Próxima
                      <ChevronRight className="ml-1 size-4" />
                    </Button>
                  </div>
                </div>
                {details && audience > details.recipientsShown ? (
                  <p className="text-xs text-muted-foreground">
                    Mostrando os primeiros {number(details.recipientsShown)} de {number(audience)} —
                    o CSV traz todos os registros rastreados.
                  </p>
                ) : null}
              </>
            )}
          </section>

          {recipients.some((row) => row.depositAt) ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Quem clicou e depositou</h2>
              <ConversionTable rows={recipients.filter((row) => row.depositAt)} />
              <p className="mt-3 text-xs text-sky-300">
                A atribuição exige vínculo individual com o clique; depósitos sem esse vínculo não
                inflam este resultado.
              </p>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function RecipientTable({ rows }: { rows: Recipient[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b text-left text-sky-200">
            <th className="p-3">Jogador</th>
            <th className="p-3">Envio</th>
            <th className="p-3">Clique</th>
            <th className="p-3 text-right">Cliques</th>
            <th className="p-3">Depósito</th>
            <th className="p-3 text-right">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="p-3">
                <strong className="block max-w-48 truncate text-sm">{row.playerName}</strong>
                <span className="text-sky-300">
                  {row.deliveryStatus === "delivered" ? "entregue" : row.sendStatus}
                </span>
              </td>
              <td className="p-3 text-sky-300">{dateTime(row.sentAt)}</td>
              <td className={cn("p-3", row.clicked && "font-medium text-blue-400")}>
                {dateTime(row.clickedAt)}
              </td>
              <td className="p-3 text-right font-semibold">{row.clickCount || "—"}</td>
              <td className="p-3 text-sky-300">{dateTime(row.depositAt)}</td>
              <td
                className={cn(
                  "p-3 text-right",
                  row.depositValue > 0 && "font-bold text-emerald-400",
                )}
              >
                {row.depositValue ? money(row.depositValue) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConversionTable({ rows }: { rows: Recipient[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[680px] text-xs">
        <thead>
          <tr className="border-b text-left text-sky-200">
            <th className="p-3">Jogador</th>
            <th className="p-3">Clicou</th>
            <th className="p-3">Depositou</th>
            <th className="p-3">Depois de</th>
            <th className="p-3 text-right">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const elapsed =
              row.clickedAt && row.depositAt
                ? Math.max(0, new Date(row.depositAt).getTime() - new Date(row.clickedAt).getTime())
                : null;
            return (
              <tr key={row.id} className="border-b last:border-0">
                <td className="p-3">
                  <strong className="block text-sm">{row.playerName}</strong>
                  <span className="text-sky-300">
                    {number(row.historicalDepositCount)} depósitos no histórico ·{" "}
                    {money(row.historicalDepositValue)}
                  </span>
                </td>
                <td className="p-3 text-sky-300">{dateTime(row.clickedAt)}</td>
                <td className="p-3 font-semibold">{dateTime(row.depositAt)}</td>
                <td className="p-3 text-sky-300">{formatElapsed(elapsed)}</td>
                <td className="p-3 text-right font-bold text-emerald-400">
                  {money(row.depositValue)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function JourneyReport({
  data,
  sourceId,
  alerts,
}: {
  data: Awaited<ReturnType<typeof getConversionReport>>;
  sourceId: string;
  alerts: Array<{ code: string; message: string }>;
}) {
  return (
    <main className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Relatório da jornada</h1>
          <p className="text-sm text-muted-foreground">
            Último clique rastreado · janela de 7 dias · America/Sao_Paulo
          </p>
        </div>
        <Link to="/jornadas">Voltar</Link>
      </div>
      {alerts.map((alert) => (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
          key={alert.code}
        >
          {alert.message}
        </div>
      ))}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Enviados" value={number(data.sent)} />
        <Metric label="Entregues" value={data.delivered === null ? "—" : number(data.delivered)} />
        <Metric label="Login ou jogo" value={number(data.loginOrGame)} />
        <Metric label="Depósitos" value={number(data.deposits)} accent />
      </section>
      <section className="rounded-xl border p-4">
        <p className="text-sm text-muted-foreground">Receita diretamente atribuída</p>
        <p className="text-3xl font-semibold text-emerald-400">{money(data.revenue)}</p>
      </section>
      {data.byStepChannel.length ? (
        <section className="rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">Desempenho por etapa e canal</h2>
          {data.byStepChannel.map((row) => (
            <div
              key={`${row.stepId ?? row.stepPosition}:${row.channel}`}
              className="grid grid-cols-3 border-b py-2 text-sm"
            >
              <span>{row.stepPosition === null ? "Legado" : `Etapa ${row.stepPosition + 1}`}</span>
              <span className="uppercase">{row.channel}</span>
              <span>{number(row.sent)} enviados</span>
            </div>
          ))}
        </section>
      ) : null}
      <p className="hidden">{sourceId}</p>
    </main>
  );
}

function Metric({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={cn("rounded-xl bg-card/60 p-3", accent && "bg-emerald-500/10")}>
      <p className={cn("text-xs text-sky-300", accent && "text-emerald-300")}>{label}</p>
      <p className={cn("mt-1 text-xl font-bold", accent && "text-emerald-400")}>{value}</p>
      {hint ? <p className="text-xs text-sky-300">{hint}</p> : null}
    </div>
  );
}

function TimelineValue({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-sky-300">{label}</p>
      <p className="font-semibold text-foreground">{value}</p>
    </div>
  );
}

function FilterButton({
  active,
  tone = "blue",
  onClick,
  children,
}: {
  active: boolean;
  tone?: "blue" | "green" | "orange";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
        active ? "border-blue-500 bg-blue-600 text-white" : "bg-card/60 hover:bg-card",
        tone === "green" && !active && "border-emerald-500/30 text-emerald-400",
        tone === "orange" && !active && "border-orange-500/30 text-orange-400",
      )}
    >
      {children}
    </button>
  );
}

function ReportState({ children }: { children: React.ReactNode }) {
  return (
    <main className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6 text-sm text-muted-foreground">
      {children}
    </main>
  );
}

function formatElapsed(value: number | null) {
  if (value === null) return "—";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

async function downloadRecipients(sourceId: string) {
  const result = await exportCampaignRecipientsCsv({ data: { campaignId: sourceId } });
  const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `destinatarios-${sourceId}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
