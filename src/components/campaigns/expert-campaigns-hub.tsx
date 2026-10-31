// Área do Expert §8 — /campanhas para o expert: a mesma tela da casa
// (linhas, rascunhos, compositor), com só as campanhas do próprio expert,
// os status de aprovação/teto e o cartão "Uso do mês". Sem saldo, relatório
// ou envio de teste (páginas e ações da casa).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Megaphone, PieChart, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";

import {
  CampaignDraftsCard,
  CampaignRow,
  ROW_GRID,
  type Campaign,
  type DraftSummary,
} from "@/components/campaigns/campaigns-hub";
import { ChannelCampaignComposer } from "@/components/campaigns/channel-campaign-composer";
import { ExpertUsageCard } from "@/components/campaigns/expert-usage-card";
import { KpiCard, HomeCard } from "@/components/home/home-cards";
import { SegmentedFilter } from "@/components/players/segmented-filter";
import { requestConfirmation } from "@/components/system-dialog-host";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageHeader } from "@/components/ui-premium/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCampaignDataSource } from "@/hooks/use-campaign-data-source";
import { audienceFromSearch } from "@/lib/channel-operation-state";
import {
  cancelExpertCampaign,
  getExpertCampaignUsage,
  listExpertCampaigns,
} from "@/lib/expert-campaigns.functions";
import {
  EXPERT_CAMPAIGNS_QUERY_KEY,
  EXPERT_STATUS_FILTERS,
  expertCampaignToRow,
  matchesExpertStatus,
  type ExpertCampaignItem,
  type ExpertStatusFilter,
} from "@/lib/expert-campaign-rows";
import { EXPERT_USAGE_QUERY_KEY, type ExpertCampaignUsageData } from "@/lib/expert-campaign-usage";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";

const KPI_WINDOW_DAYS = 30;

export function ExpertCampaignsHub() {
  const queryClient = useQueryClient();
  const source = useCampaignDataSource();
  const listCampaignsFn = useServerFn(listExpertCampaigns);
  const usageFn = useServerFn(getExpertCampaignUsage);
  const cancelFn = useServerFn(cancelExpertCampaign);
  const [composerOpen, setComposerOpen] = useState(false);
  const [initialChannel, setInitialChannel] = useState<"sms" | "email" | "voice">("sms");
  const [initialAudienceId, setInitialAudienceId] = useState("");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ExpertStatusFilter>("todos");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("newChannel");
    if (requested === "email" || requested === "voice" || requested === "sms") {
      setInitialChannel(requested);
      setComposerOpen(true);
    } else if (params.get("newCampaign") === "1") {
      setInitialChannel("sms");
      setInitialAudienceId(audienceFromSearch(params.get("audience")));
      setComposerOpen(true);
    }
  }, []);

  const campaigns = useQuery({
    queryKey: EXPERT_CAMPAIGNS_QUERY_KEY,
    queryFn: () => listCampaignsFn(),
    refetchInterval: 30_000,
  });
  const usage = useQuery({
    queryKey: EXPERT_USAGE_QUERY_KEY,
    queryFn: () => usageFn(),
    refetchInterval: 60_000,
  });
  const drafts = useQuery({
    queryKey: source.queryKeys.drafts,
    queryFn: () => source.listDrafts(),
    refetchInterval: 30_000,
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: EXPERT_CAMPAIGNS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: EXPERT_USAGE_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: source.queryKeys.drafts });
  };

  const cancel = useMutation({
    mutationFn: (campaign: Campaign) =>
      cancelFn({ data: { channel: campaign.channel, id: campaign.id } }),
    onSuccess: () => {
      toast.success("Campanha cancelada");
      refreshAll();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const removeDraft = useMutation({
    mutationFn: (id: string) => source.deleteDraft({ data: { id } }),
    onSuccess: () => {
      toast.success("Rascunho excluído");
      queryClient.invalidateQueries({ queryKey: source.queryKeys.drafts });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const all: Campaign[] = ((campaigns.data?.items ?? []) as ExpertCampaignItem[])
    .map(expertCampaignToRow)
    .sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime());
  const normalizedSearch = search.trim().toLowerCase();
  const rows = all.filter(
    (campaign) =>
      matchesExpertStatus(status, campaign.status) &&
      (!normalizedSearch ||
        String(campaign.name ?? "")
          .toLowerCase()
          .includes(normalizedSearch)),
  );
  const statusCounts = Object.fromEntries(
    EXPERT_STATUS_FILTERS.map((item) => [
      item.value,
      all.filter((campaign) => matchesExpertStatus(item.value, campaign.status)).length,
    ]),
  ) as Record<ExpertStatusFilter, number>;

  const kpiSince = Date.now() - KPI_WINDOW_DAYS * 86_400_000;
  const recent = all.filter((campaign) => new Date(campaign.scheduled_at).getTime() >= kpiSince);
  const sent = recent.reduce((sum, campaign) => sum + Number(campaign.sent_count ?? 0), 0);
  const failed = recent.reduce((sum, campaign) => sum + Number(campaign.failed_count ?? 0), 0);
  const queued = all.filter((campaign) =>
    ["agendada", "enviando", "enfileirada"].includes(campaign.status),
  ).length;
  const firstLoad = campaigns.isLoading && !campaigns.data;
  const draftItems = (drafts.data?.items ?? []) as DraftSummary[];

  const openNewCampaign = () => {
    setActiveDraftId(null);
    setInitialAudienceId("");
    setInitialChannel("sms");
    setComposerOpen(true);
  };

  return (
    <>
      <PageHeader
        subtitle="Envie SMS, e-mail ou voz para os seus leads e acompanhe cada envio."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/publicos">
                <PieChart /> Públicos
              </Link>
            </Button>
            <Button onClick={openNewCampaign}>
              <Plus /> Nova campanha
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          title="Enviados"
          value={firstLoad ? "—" : num(sent)}
          detail={`Campanhas dos últimos ${KPI_WINDOW_DAYS} dias`}
        />
        <KpiCard
          title="Falhas"
          value={firstLoad ? "—" : num(failed)}
          detail={`Recusados ou inválidos, últimos ${KPI_WINDOW_DAYS} dias`}
        />
        <KpiCard
          title="Em envio"
          value={firstLoad ? "—" : num(queued)}
          detail="Campanhas agendadas ou enviando agora"
        />
      </div>

      <ExpertUsageCard
        usage={usage.data as ExpertCampaignUsageData | undefined}
        loading={usage.isLoading}
        failed={usage.isError}
      />

      <CampaignDraftsCard
        items={draftItems}
        deleting={removeDraft.isPending}
        onContinue={(draft) => {
          setActiveDraftId(draft.id);
          setInitialChannel(draft.channel);
          setComposerOpen(true);
        }}
        onDelete={(id) => removeDraft.mutate(id)}
      />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <SegmentedFilter
          label="Status da campanha"
          value={status}
          onValueChange={setStatus}
          items={EXPERT_STATUS_FILTERS.map((item) => ({
            ...item,
            count: firstLoad ? null : statusCounts[item.value],
          }))}
        />
        <div className="relative w-full lg:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar campanha pelo nome"
            placeholder="Buscar campanha"
            className="h-10 bg-card pl-9 pr-10"
          />
          {search && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setSearch("")}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <HomeCard className="overflow-hidden">
        <div className="overflow-x-auto">
          <div className="xl:min-w-[920px]">
            <div
              className={cn(ROW_GRID, "hidden border-b border-border py-2.5 xl:grid")}
              aria-hidden="true"
            >
              <span className="text-meta text-muted-foreground">Campanha</span>
              <span className="text-meta text-muted-foreground">Status</span>
              <span className="text-right text-meta text-muted-foreground">Enviados</span>
              <span className="text-right text-meta text-muted-foreground">Falhas</span>
              <span className="text-right text-meta text-muted-foreground">Progresso</span>
              <span className="sr-only">Ações</span>
            </div>

            {firstLoad && (
              <div className="divide-y divide-border/70" aria-label="Carregando campanhas">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-2 px-4 py-4">
                    <Skeleton className="h-4 w-56 max-w-full" />
                    <Skeleton className="h-3 w-40 max-w-full" />
                  </div>
                ))}
              </div>
            )}

            {campaigns.isError && !campaigns.data ? (
              <p className="p-4 text-body text-destructive" role="status">
                Não foi possível carregar suas campanhas: {campaigns.error.message}
              </p>
            ) : null}

            {!firstLoad && !campaigns.isError && rows.length === 0 && (
              <EmptyState
                icon={<Megaphone />}
                title={
                  all.length === 0
                    ? "Nenhuma campanha ainda"
                    : "Nenhuma campanha corresponde aos filtros"
                }
                description={
                  all.length === 0
                    ? "Escolha o canal, um público dos seus leads e a mensagem do primeiro envio."
                    : "Ajuste a busca ou o status para ver outras campanhas."
                }
                action={
                  all.length === 0 ? (
                    <Button onClick={openNewCampaign}>
                      <Plus /> Nova campanha
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setStatus("todos");
                      }}
                    >
                      Limpar filtros
                    </Button>
                  )
                }
              />
            )}

            {!firstLoad && rows.length > 0 && (
              <ul>
                {rows.map((campaign) => (
                  <CampaignRow
                    key={`${campaign.channel}-${campaign.id}`}
                    variant="expert"
                    campaign={campaign}
                    cancelPending={cancel.isPending}
                    resumePending={false}
                    onResume={() => undefined}
                    onCancel={async () => {
                      const confirmed = await requestConfirmation({
                        title: "Cancelar esta campanha?",
                        description: `Os envios ainda não feitos de "${campaign.name}" serão cancelados e a campanha não poderá ser retomada. O que já foi enviado não é desfeito.`,
                        confirmLabel: "Cancelar campanha",
                        cancelLabel: "Manter campanha",
                        destructive: true,
                      });
                      if (confirmed) cancel.mutate(campaign);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </HomeCard>

      <ChannelCampaignComposer
        open={composerOpen}
        onOpenChange={setComposerOpen}
        initialChannel={initialChannel}
        initialDraftId={activeDraftId}
        initialAudienceId={initialAudienceId}
        onCreated={refreshAll}
      />
    </>
  );
}
