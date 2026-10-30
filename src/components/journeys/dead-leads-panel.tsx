import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Inbox, Info, RotateCcw, Search, Skull } from "lucide-react";
import { toast } from "sonner";
import { listDeadLeads, reviveDeadLeadFn, runDeadLeadBackfill } from "@/lib/journeys.functions";
import {
  DEAD_LEADS_AUDIENCE_ID,
  DEAD_LEADS_AUDIENCE_LABEL,
  deadLeadActionLabel,
  deadLeadRevivedReasonLabel,
  runBackfillRounds,
  type DeadLeadBackfillProgress,
  type DeadLeadStatus,
} from "@/lib/dead-leads.shared";
import { timeAgo } from "@/lib/format";
import { requestConfirmation } from "@/components/system-dialog-host";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PAGE_SIZE = 25;

const STATUS_OPTIONS: ReadonlyArray<{ value: DeadLeadStatus; label: string }> = [
  { value: "dead", label: "Mortos" },
  { value: "revived", label: "Reativados" },
];

export type DeadLeadRow = {
  playerId: string;
  nome: string | null;
  telefone: string | null;
  email: string | null;
  externalId: string | null;
  markedAt: string;
  messagesCount: number;
  lastActionAt: string | null;
  lastActionType: string | null;
  lastJourneyId: string | null;
  lastJourneyName: string | null;
  exitedEnrollments: number;
  revivedAt: string | null;
  revivedReason: string | null;
  totalDepositado: number;
  hasFtd: boolean;
  ftdAt: string | null;
  ultimoDeposito: string | null;
  ultimoLogin: string | null;
  vip: boolean;
  playerCreatedAt: string | null;
};

type DeadLeadsPage = {
  rows: DeadLeadRow[];
  total: number;
  searchCapped: boolean;
  summary: { dead: number; revivedLast30d: number; enabled: boolean; threshold: number };
};

const brl = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const absoluteDate = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function RelativeDate({ value, empty = "—" }: { value: string | null; empty?: string }) {
  if (!value) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <time dateTime={value} title={absoluteDate(value)} className="whitespace-nowrap">
      {timeAgo(value)}
    </time>
  );
}

export function DeadLeadsPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const queryClient = useQueryClient();
  const listFn = useServerFn(listDeadLeads);
  const reviveFn = useServerFn(reviveDeadLeadFn);
  const backfillFn = useServerFn(runDeadLeadBackfill);
  const [status, setStatus] = useState<DeadLeadStatus>("dead");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [backfill, setBackfill] = useState<
    (DeadLeadBackfillProgress & { running: boolean; complete?: boolean }) | null
  >(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const list = useQuery({
    queryKey: ["dead-leads", status, search, page],
    queryFn: () => listFn({ data: { status, search, page, pageSize: PAGE_SIZE } }),
    placeholderData: (previous) => previous,
  });
  const data = list.data as DeadLeadsPage | undefined;
  const summary = data?.summary;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const revive = useMutation({
    mutationFn: (playerId: string) => reviveFn({ data: { playerId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["dead-leads"] });
      if (result.revived) toast.success("Lead reativado. Ele pode voltar a entrar nas jornadas.");
      else toast.info("Este lead já estava ativo.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const startBackfill = async () => {
    setBackfill({ rounds: 0, evaluated: 0, marked: 0, running: true });
    try {
      const result = await runBackfillRounds(
        () => backfillFn(),
        (progress) => setBackfill({ ...progress, running: true }),
      );
      setBackfill({ ...result, running: false });
      await queryClient.invalidateQueries({ queryKey: ["dead-leads"] });
      const marked = result.marked.toLocaleString("pt-BR");
      if (result.complete)
        toast.success(`Base avaliada. ${marked} lead(s) marcado(s) como mortos.`);
      else
        toast.warning(
          `${marked} lead(s) marcado(s) até agora. Ainda há jogadores para avaliar: rode de novo.`,
        );
    } catch (error) {
      setBackfill((current) => (current ? { ...current, running: false } : null));
      toast.error(error instanceof Error ? error.message : "Não foi possível avaliar a base.");
    }
  };

  const confirmRevive = async (row: DeadLeadRow) => {
    const confirmed = await requestConfirmation({
      title: "Reativar este lead?",
      description: `${row.nome ?? "O jogador"} sai de Leads mortos e volta a poder entrar nas jornadas. Se receber de novo ${summary?.threshold ?? "N"} mensagens seguidas sem agir, volta para a lista.`,
      confirmLabel: "Reativar lead",
    });
    if (confirmed) revive.mutate(row.playerId);
  };

  const enabled = summary?.enabled ?? false;
  const backfillRunning = backfill?.running === true;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          title="Leads mortos agora"
          value={summary ? summary.dead.toLocaleString("pt-BR") : "—"}
          detail="Fora de todas as jornadas"
        />
        <KpiCard
          title="Reativados em 30 dias"
          value={summary ? summary.revivedLast30d.toLocaleString("pt-BR") : "—"}
          detail="Voltaram a agir ou foram reativados manualmente"
        />
        <KpiCard
          title="Regra"
          value={summary ? (enabled ? "Ligada" : "Desligada") : "—"}
          detail={
            summary
              ? enabled
                ? `Após ${summary.threshold} mensagens seguidas sem ação`
                : "Nenhum lead novo é marcado"
              : undefined
          }
        />
      </div>

      {summary && !enabled && (
        <HomeCard className="flex flex-col gap-3 border-dashed p-4 sm:flex-row sm:items-center sm:p-5">
          <Info className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">A regra de leads mortos está desligada.</p>
            <p>
              Quando ligada, quem recebe várias mensagens seguidas de jornada (SMS, e-mail ou voz)
              sem nenhuma ação na casa — depósito, login, jogo ou clique — sai de todas as jornadas
              e vai para o público {DEAD_LEADS_AUDIENCE_LABEL}. Se voltar a agir, é reativado
              automaticamente.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            Ligar em Limites de contato
          </Button>
        </HomeCard>
      )}

      {summary && enabled && (
        <HomeCard className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">Avaliar a base atual</p>
            <p>
              A regra vale para as próximas mensagens. Para marcar agora quem já recebeu{" "}
              {summary.threshold} mensagens seguidas sem agir, avalie a base atual.
            </p>
            {backfill && (
              <p className="mt-1 text-foreground" role="status" aria-live="polite">
                {backfill.running ? "Avaliando… " : "Concluído: "}
                {backfill.evaluated.toLocaleString("pt-BR")} jogador(es) avaliado(s),{" "}
                {backfill.marked.toLocaleString("pt-BR")} marcado(s) como mortos
                {!backfill.running && backfill.complete === false
                  ? " — ainda há jogadores para avaliar."
                  : "."}
              </p>
            )}
          </div>
          <Button size="sm" disabled={backfillRunning} onClick={() => void startBackfill()}>
            {backfillRunning ? "Avaliando…" : "Avaliar base atual agora"}
          </Button>
        </HomeCard>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Filtrar leads mortos"
          className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]"
        >
          {STATUS_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={status === item.value}
              onClick={() => {
                setStatus(item.value);
                setPage(0);
              }}
              className={
                status === item.value
                  ? "h-9 shrink-0 rounded-lg bg-secondary px-3 text-[13px] font-medium text-foreground"
                  : "h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="relative sm:w-80">
          <Label htmlFor="dead-leads-search" className="sr-only">
            Buscar lead
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="dead-leads-search"
            className="h-10 pl-9"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Nome, telefone, e-mail ou ID externo"
          />
        </div>
      </div>

      <HomeCard className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-section">
              {status === "dead" ? "Leads mortos" : "Leads reativados"}
            </h2>
            <span className="text-meta text-muted-foreground">
              {total.toLocaleString("pt-BR")} lead(s)
            </span>
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Para falar com eles em uma campanha, escolha o público “{DEAD_LEADS_AUDIENCE_LABEL}” (
            <code className="text-[11.5px]">{DEAD_LEADS_AUDIENCE_ID}</code>) em{" "}
            <Link to="/campanhas" className="underline underline-offset-2 hover:text-foreground">
              Campanhas
            </Link>
            .
            {data?.searchCapped
              ? " A busca encontrou muitos jogadores; refine o termo para ver todos."
              : ""}
          </p>
        </div>
        {list.isLoading ? (
          <p className="py-8 text-center text-body text-muted-foreground">Carregando…</p>
        ) : list.isError ? (
          <p className="py-8 text-center text-body text-danger">
            Não foi possível carregar os leads mortos.
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={search ? <Inbox /> : <Skull />}
            title={
              search
                ? "Nenhum lead encontrado"
                : status === "dead"
                  ? "Nenhum lead morto"
                  : "Nenhum lead reativado"
            }
            description={
              search
                ? "Mude a busca para ver outros leads."
                : status === "dead"
                  ? "Quem receber várias mensagens seguidas sem agir aparece aqui."
                  : "Leads que voltaram a agir ou foram reativados aparecem aqui."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-[13px]">
              <thead className="border-b border-border text-meta text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-normal sm:px-5">
                    Lead
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Mensagens sem ação
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Última ação
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Última jornada
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Depósitos
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Último login
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    {status === "dead" ? "Marcado" : "Reativado"}
                  </th>
                  {status === "dead" && (
                    <th scope="col" className="px-4 py-2 text-right font-normal sm:px-5">
                      <span className="sr-only">Ações</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <DeadLeadTableRow
                    key={row.playerId}
                    row={row}
                    status={status}
                    reviveBusy={revive.isPending}
                    onRevive={() => void confirmRevive(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-meta text-muted-foreground sm:px-5">
            <span>
              Página {(page + 1).toLocaleString("pt-BR")} de {pageCount.toLocaleString("pt-BR")}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || list.isFetching}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount || list.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </HomeCard>
    </div>
  );
}

function DeadLeadTableRow({
  row,
  status,
  reviveBusy,
  onRevive,
}: {
  row: DeadLeadRow;
  status: DeadLeadStatus;
  reviveBusy: boolean;
  onRevive: () => void;
}) {
  const contact = [row.telefone, row.email].filter(Boolean).join(" · ");
  const revivedReason = deadLeadRevivedReasonLabel(row.revivedReason);
  return (
    <tr className="align-top">
      <td className="px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            to="/players/$playerId"
            params={{ playerId: row.playerId }}
            search={{ id: undefined, focus: undefined }}
            className="font-medium hover:underline"
          >
            {row.nome ?? "Jogador"}
          </Link>
          {row.vip && (
            <Badge variant="outline" className="border-warning/30 bg-warning/15 text-warning">
              VIP
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{contact || "Sem contato"}</p>
        {row.externalId && <p className="text-[12px] text-muted-foreground">ID {row.externalId}</p>}
      </td>
      <td className="px-3 py-3 tabular-nums">
        {row.messagesCount.toLocaleString("pt-BR")}
        <p className="text-[12px] text-muted-foreground">
          saiu de {row.exitedEnrollments.toLocaleString("pt-BR")} jornada(s)
        </p>
      </td>
      <td className="px-3 py-3">
        {row.lastActionType ? (
          <>
            {deadLeadActionLabel(row.lastActionType)}
            <p className="text-[12px] text-muted-foreground">
              <RelativeDate value={row.lastActionAt} />
            </p>
          </>
        ) : (
          <span className="text-muted-foreground">Nunca agiu</span>
        )}
      </td>
      <td className="px-3 py-3">
        {row.lastJourneyId ? (
          <Link
            to="/jornadas/$journeyId"
            params={{ journeyId: row.lastJourneyId }}
            className="hover:underline"
          >
            {row.lastJourneyName ?? "Jornada"}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        <span className="tabular-nums">{brl(row.totalDepositado)}</span>
        <p className="text-[12px] text-muted-foreground">
          {row.hasFtd ? "Com FTD" : "Sem FTD"}
          {row.ultimoDeposito ? (
            <>
              {" · último "}
              <RelativeDate value={row.ultimoDeposito} />
            </>
          ) : null}
        </p>
      </td>
      <td className="px-3 py-3">
        <RelativeDate value={row.ultimoLogin} empty="Nunca" />
      </td>
      <td className="px-3 py-3">
        {status === "dead" ? (
          <RelativeDate value={row.markedAt} />
        ) : (
          <>
            <RelativeDate value={row.revivedAt} />
            {revivedReason && <p className="text-[12px] text-muted-foreground">{revivedReason}</p>}
          </>
        )}
      </td>
      {status === "dead" && (
        <td className="px-4 py-3 text-right sm:px-5">
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-9"
            disabled={reviveBusy}
            onClick={onRevive}
            aria-label={`Reativar ${row.nome ?? "jogador"}`}
          >
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" /> Reativar
          </Button>
        </td>
      )}
    </tr>
  );
}
