import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { HomeCard } from "@/components/home/home-cards";
import {
  LevelRulesCard,
  LevelStrip,
  PlayerLine,
  VipStoppedCard,
  type LevelDraft,
} from "@/components/gamification/level-sections";
import { NEW_CAMPAIGN_SEARCH } from "@/components/gamification/level-rules";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { num } from "@/lib/format";
import {
  getGamificationData,
  saveGamificationSettings,
  searchGamificationRanking,
  RANKING_SEARCH_LIMIT,
  type GamificationData,
  type LevelSlug,
} from "@/lib/gamification.functions";
import { LEVEL_LABEL } from "@/lib/player-level";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/gamificacao")({
  component: GamificacaoPage,
});

const LEVEL_OPTIONS: Array<{ value: "all" | LevelSlug; label: string }> = [
  { value: "all", label: "Todos os níveis" },
  ...(["novice", "bronze", "silver", "gold", "diamond", "black"] as LevelSlug[]).map((value) => ({
    value,
    label: LEVEL_LABEL[value],
  })),
];

const SUBTITLE = "O nível de cada jogador vem do total que ele já depositou.";
const PAGE_SIZE = 10;

function GamificacaoPage() {
  const queryClient = useQueryClient();
  const fetchGamification = useServerFn(getGamificationData);
  const saveSettings = useServerFn(saveGamificationSettings);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["gamification"],
    queryFn: () => fetchGamification(),
    staleTime: 20_000,
  });

  const [draft, setDraft] = useState<LevelDraft>(() => defaultDraft());
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | LevelSlug>("all");
  const [sort, setSort] = useState<"deposit" | "stopped" | "name">("deposit");
  const [onlyStopped, setOnlyStopped] = useState(false);
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const rankingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (data) setDraft(toDraft(data));
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          thresholds: {
            bronze: Number(draft.bronze),
            silver: Number(draft.silver),
            gold: Number(draft.gold),
            diamond: Number(draft.diamond),
            black: Number(draft.black),
          },
          coolingAfterDays: Number(draft.coolingAfterDays),
          sleepingAfterDays: Number(draft.sleepingAfterDays),
          vipMinLevel: draft.vipMinLevel,
        },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(["gamification"], next);
      setDraft(toDraft(next));
      toast.success("Faixas e regras salvas.");
    },
    onError: (error: Error) => toast.error(error?.message || "Não foi possível salvar as faixas."),
  });

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(toDraft(data)) : false;

  // C-07: sem filtro, o ranking é o top 200 do snapshot. Com busca, nível ou
  // "só quem parou", a consulta vai à base inteira no servidor.
  const searchRanking = useServerFn(searchGamificationRanking);
  const hasRankingFilter = debouncedSearch !== "" || levelFilter !== "all" || onlyStopped;
  const rankingSearch = useQuery({
    queryKey: ["gamification-ranking-search", debouncedSearch, levelFilter, onlyStopped],
    queryFn: () =>
      searchRanking({ data: { search: debouncedSearch, level: levelFilter, onlyStopped } }),
    enabled: hasRankingFilter,
    placeholderData: (previous) => previous,
    staleTime: 20_000,
  });
  const rankingTotal = hasRankingFilter
    ? (rankingSearch.data?.total ?? 0)
    : (data?.totals.players ?? 0);

  const rows = useMemo(() => {
    const base = hasRankingFilter ? (rankingSearch.data?.players ?? []) : (data?.ranking ?? []);
    return [...base].sort((a, b) => {
      if (sort === "name") return a.nome.localeCompare(b.nome);
      if (sort === "stopped") return (b.daysWithoutDeposit ?? -1) - (a.daysWithoutDeposit ?? -1);
      return b.total_depositado - a.total_depositado;
    });
  }, [data, hasRankingFilter, rankingSearch.data, sort]);

  useEffect(() => setPage(1), [search, levelFilter, onlyStopped, sort]);

  if (isLoading) return <LoadingState />;
  if (!data)
    return (
      <Page>
        <PageHeader subtitle={SUBTITLE} />
        <HomeCard>
          <EmptyState
            title="Não foi possível carregar os níveis"
            description="Verifique a conexão e tente de novo."
            action={
              <Button className="h-9" onClick={() => refetch()}>
                Tentar novamente
              </Button>
            }
          />
        </HomeCard>
      </Page>
    );

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const visibleRows = rows.slice(firstIndex, firstIndex + PAGE_SIZE);
  const searching = rankingSearch.isFetching && hasRankingFilter;

  function showStoppedInRanking() {
    setOnlyStopped(true);
    setSort("deposit");
    rankingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <Page>
      <PageHeader
        subtitle={SUBTITLE}
        actions={
          <>
            <Button asChild className="h-9">
              <Link to="/campanhas" search={NEW_CAMPAIGN_SEARCH}>
                <Plus className="size-4" aria-hidden="true" />
                Criar campanha
              </Link>
            </Button>
            <IconButton
              variant="outline"
              label="Atualizar dados"
              onClick={() => refetch()}
              disabled={isFetching}
              icon={<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />}
            />
          </>
        }
      />

      <LevelStrip data={data} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          <VipStoppedCard data={data} onShowAll={showStoppedInRanking} />

          <section ref={rankingRef} aria-labelledby="ranking-title" className="scroll-mt-4">
            <HomeCard>
              <div className="p-4 sm:p-5">
                <h2 id="ranking-title" className="text-section">
                  Quem mais depositou
                </h2>
                <p className="mt-1 text-body text-muted-foreground">
                  Sem filtro, mostra os {num(RANKING_SEARCH_LIMIT)} maiores. Busca, nível e “Só quem
                  parou” procuram na base inteira.
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px_190px_auto]">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Nome, telefone ou ID"
                      aria-label="Buscar jogador"
                      className="h-10 pl-9"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:contents">
                    <Select
                      value={levelFilter}
                      onValueChange={(value) => setLevelFilter(value as "all" | LevelSlug)}
                    >
                      <SelectTrigger className="h-10" aria-label="Filtrar por nível">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEVEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                      <SelectTrigger className="h-10" aria-label="Ordenar">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="deposit">Mais depositaram</SelectItem>
                        <SelectItem value="stopped">Mais tempo parados</SelectItem>
                        <SelectItem value="name">Nome</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant={onlyStopped ? "default" : "outline"}
                    aria-pressed={onlyStopped}
                    className="h-10"
                    onClick={() => setOnlyStopped((value) => !value)}
                  >
                    Só quem parou
                  </Button>
                </div>
                <p className="mt-3 text-meta text-muted-foreground" aria-live="polite">
                  {searching
                    ? "Buscando na base…"
                    : `${
                        rows.length === 0
                          ? "0"
                          : `${firstIndex + 1}–${firstIndex + visibleRows.length}`
                      } de ${num(rows.length)} jogadores`}
                  {!searching &&
                    rankingTotal > rows.length &&
                    ` · os ${num(RANKING_SEARCH_LIMIT)} maiores de ${num(rankingTotal)} ${
                      hasRankingFilter ? "que atendem ao filtro" : "na base"
                    }`}
                  {rankingTotal > rows.length && (
                    <>
                      {" · "}
                      <Link
                        to="/players"
                        search={{ id: undefined, focus: undefined }}
                        className="font-medium text-primary hover:underline"
                      >
                        Ver todos em Jogadores
                      </Link>
                    </>
                  )}
                </p>
              </div>

              <div className="divide-y divide-border/70 border-t border-border/70">
                {visibleRows.length === 0 ? (
                  <p className="px-4 py-8 text-center text-body text-muted-foreground">
                    {hasRankingFilter && rankingSearch.isError
                      ? `Não foi possível buscar na base: ${
                          rankingSearch.error instanceof Error
                            ? rankingSearch.error.message
                            : "tente novamente."
                        }`
                      : hasRankingFilter && rankingSearch.isLoading
                        ? "Buscando na base…"
                        : "Nenhum jogador encontrado."}
                  </p>
                ) : (
                  visibleRows.map((player, index) => (
                    <PlayerLine key={player.id} player={player} position={firstIndex + index + 1} />
                  ))
                )}
              </div>

              {totalPages > 1 && (
                <nav
                  aria-label="Páginas do ranking"
                  className="flex flex-wrap items-center gap-1 border-t border-border/70 p-3 sm:px-5"
                >
                  <IconButton
                    variant="outline"
                    label="Página anterior"
                    disabled={currentPage === 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    icon={<ChevronLeft className="size-4" />}
                  />
                  {pageButtons(currentPage, totalPages).map((item, index) =>
                    item === "dots" ? (
                      <span
                        key={`dots-${index}`}
                        className="px-1 text-muted-foreground"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <Button
                        key={item}
                        variant={item === currentPage ? "default" : "ghost"}
                        aria-label={`Página ${item}`}
                        aria-current={item === currentPage ? "page" : undefined}
                        className="size-11 px-0 tabular-nums sm:size-9"
                        onClick={() => setPage(item)}
                      >
                        {item}
                      </Button>
                    ),
                  )}
                  <IconButton
                    variant="outline"
                    label="Próxima página"
                    disabled={currentPage === totalPages}
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    icon={<ChevronRight className="size-4" />}
                  />
                </nav>
              )}
            </HomeCard>
          </section>
        </div>

        <div className="min-w-0">
          <LevelRulesCard
            draft={draft}
            setDraft={setDraft}
            dirty={dirty}
            saving={mutation.isPending}
            onSave={() => mutation.mutate()}
          />
        </div>
      </div>
    </Page>
  );
}

function LoadingState() {
  return (
    <Page>
      <PageHeader subtitle={SUBTITLE} />
      <div className="grid grid-cols-[repeat(6,minmax(140px,1fr))] gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Skeleton className="h-[480px] rounded-2xl" />
        <Skeleton className="h-[480px] rounded-2xl" />
      </div>
    </Page>
  );
}

function defaultDraft(): LevelDraft {
  return {
    bronze: "10",
    silver: "200",
    gold: "500",
    diamond: "1000",
    black: "3000",
    coolingAfterDays: "2",
    sleepingAfterDays: "7",
    vipMinLevel: "diamond",
  };
}

function toDraft(data: GamificationData): LevelDraft {
  return {
    bronze: String(data.settings.thresholds.bronze),
    silver: String(data.settings.thresholds.silver),
    gold: String(data.settings.thresholds.gold),
    diamond: String(data.settings.thresholds.diamond),
    black: String(data.settings.thresholds.black),
    coolingAfterDays: String(data.settings.coolingAfterDays),
    sleepingAfterDays: String(data.settings.sleepingAfterDays),
    vipMinLevel: data.settings.vipMinLevel,
  };
}

function pageButtons(current: number, total: number): Array<number | "dots"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const out: Array<number | "dots"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push("dots");
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < total - 1) out.push("dots");
  out.push(total);
  return out;
}
