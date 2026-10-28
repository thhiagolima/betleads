// Relatório de rendimento — histórico do lead com a pessoa (spec §4): painel
// lateral aberto pelos blocos 4 e 6. Resumo (creditado em todo o histórico,
// depósitos creditados, desde), linha do tempo (links, cliques, contatos e
// depósitos aprovados, do mais novo para o mais antigo) e "Carregar mais"
// por cursor de data. No mobile o painel ocupa a tela inteira.
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatBrtDate, formatBrtDateTime } from "@/components/expert/sheet-format";
import type { LeadRef } from "@/components/rendimento/portfolio-table";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { getExpertLeadTimeline, type TimelineItem } from "@/lib/expert-report.functions";
import { brl, num } from "@/lib/format";
import { cn } from "@/lib/utils";

type DepositStatus = NonNullable<TimelineItem["status"]>;

const STATUS_LABEL: Record<DepositStatus, string> = {
  creditado: "Creditado",
  outra_pessoa: "Outra pessoa",
  nao_creditado: "Não creditado",
  pendente: "Aguardando cálculo",
};

const STATUS_CLASS: Record<DepositStatus, string> = {
  creditado: "border-success/40 text-success",
  outra_pessoa: "border-border text-foreground",
  nao_creditado: "border-border text-muted-foreground",
  pendente: "border-dashed border-border text-foreground",
};

function TimelineEntry({ item }: { item: TimelineItem }) {
  const status = item.kind === "deposito" ? item.status : null;
  // Não creditado em cinza; o creditado ganha a cor da casa com o motivo.
  const muted = status === "nao_creditado";
  return (
    <li
      className={cn("relative border-l border-border pb-4 pl-4", muted && "text-muted-foreground")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full",
          status === "creditado" ? "bg-success" : "bg-muted-foreground/60",
        )}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">
          {item.titulo}
          {item.valor !== null && (
            <span className={cn("ml-2 tabular-nums", status === "creditado" && "text-success")}>
              {brl(item.valor)}
            </span>
          )}
        </span>
        <span className="text-label text-muted-foreground">{formatBrtDateTime(item.at)}</span>
      </div>
      {status && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-meta font-medium",
              STATUS_CLASS[status],
            )}
          >
            {STATUS_LABEL[status]}
          </span>
          {status !== "pendente" && item.detalhe && (
            <span
              className={cn(
                "text-label",
                status === "creditado" ? "text-success" : "text-muted-foreground",
              )}
            >
              {item.detalhe}
            </span>
          )}
        </div>
      )}
      {!status && item.detalhe && (
        <p className="mt-0.5 whitespace-pre-line text-label text-muted-foreground">
          {item.detalhe}
        </p>
      )}
    </li>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function LeadHistorySheet({
  lead,
  expertId,
  onClose,
}: {
  /** O lead aberto; `null` fecha o painel. */
  lead: LeadRef | null;
  expertId?: string;
  onClose: () => void;
}) {
  const { data: switcher, active } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;
  // Quem vê é o próprio expert: a ficha dele; para a equipe e o admin, a da casa.
  const fichaDoExpert = !expertId && active?.role === "expert";

  const timelineFn = useServerFn(getExpertLeadTimeline);
  const timelineQuery = useInfiniteQuery({
    queryKey: ["rendimento-lead-timeline", tenantId, expertId ?? "self", lead?.playerId ?? null],
    queryFn: ({ pageParam }) =>
      timelineFn({ data: { playerId: lead!.playerId, expertId, before: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    enabled: !!tenantId && !!lead,
  });

  const pages = timelineQuery.data?.pages ?? [];
  const resumo = pages[0]?.resumo;
  const items = pages.flatMap((page) => page.items);

  return (
    <Sheet open={!!lead} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full max-w-none flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="space-y-1 border-b border-border p-6 pr-12 text-left">
          <SheetTitle>{lead?.nome ?? ""}</SheetTitle>
          <SheetDescription>Histórico do lead com a pessoa</SheetDescription>
          {lead && (
            <Link
              to={fichaDoExpert ? "/expert/leads/$playerId" : "/players/$playerId"}
              params={{ playerId: lead.playerId }}
              className="inline-flex w-fit items-center gap-1.5 text-label font-medium text-primary hover:underline"
            >
              Abrir ficha do lead
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
        </SheetHeader>

        <div className="space-y-5 p-6">
          {timelineQuery.isLoading ? (
            <p className="py-6 text-center text-muted-foreground">Carregando…</p>
          ) : timelineQuery.isError ? (
            <p className="py-6 text-center text-muted-foreground">{timelineQuery.error.message}</p>
          ) : (
            <>
              {resumo && (
                <div className="grid grid-cols-3 gap-3 rounded-lg border border-border/70 p-3">
                  <SummaryStat label="Creditado" value={brl(resumo.creditado)} />
                  <SummaryStat label="Depósitos" value={num(resumo.depositos)} />
                  <SummaryStat
                    label="Desde"
                    value={resumo.desde ? formatBrtDate(resumo.desde) : "—"}
                  />
                </div>
              )}
              {items.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">Nada no histórico.</p>
              ) : (
                <ol className="ml-1.5">
                  {items.map((item, index) => (
                    <TimelineEntry key={`${item.kind}-${item.at}-${index}`} item={item} />
                  ))}
                </ol>
              )}
              {timelineQuery.hasNextPage && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => timelineQuery.fetchNextPage()}
                  disabled={timelineQuery.isFetchingNextPage}
                >
                  {timelineQuery.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
