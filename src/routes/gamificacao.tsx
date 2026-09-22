import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Crown,
  Gem,
  Medal,
  MessageSquareText,
  RefreshCw,
  Search,
  Sprout,
  Trophy,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { brl, num } from "@/lib/format";
import {
  getGamificationData,
  saveGamificationSettings,
  type GamificationData,
  type GamificationPlayer,
  type LevelSlug,
  type PaidLevelSlug,
  type PlayerStatus,
} from "@/lib/gamification.functions";

export const Route = createFileRoute("/gamificacao")({
  component: GamificacaoPage,
  head: () => ({
    meta: [
      { title: "Gamificacao - BetLeads" },
      { name: "description", content: "Niveis de jogadores, faixas e ranking por tenant." },
    ],
  }),
});

const PAID_LEVELS: PaidLevelSlug[] = ["bronze", "silver", "gold", "diamond", "black"];
const LEVEL_OPTIONS: Array<{ value: "all" | LevelSlug; label: string }> = [
  { value: "all", label: "Todos os niveis" },
  { value: "novice", label: "Novato" },
  { value: "bronze", label: "Bronze" },
  { value: "silver", label: "Prata" },
  { value: "gold", label: "Ouro" },
  { value: "diamond", label: "Diamante" },
  { value: "black", label: "Black VIP" },
];

function GamificacaoPage() {
  const queryClient = useQueryClient();
  const fetchGamification = useServerFn(getGamificationData);
  const saveSettings = useServerFn(saveGamificationSettings);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["gamification"],
    queryFn: () => fetchGamification(),
    staleTime: 20_000,
  });

  const [draft, setDraft] = useState(() => defaultDraft());
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | LevelSlug>("all");
  const [sort, setSort] = useState<"deposit" | "stopped" | "name">("deposit");
  const [onlyStopped, setOnlyStopped] = useState(false);
  const [page, setPage] = useState(1);

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
      toast.success("Gamificacao salva.");
    },
    onError: (error: any) => toast.error(error?.message ?? "Erro ao salvar gamificacao."),
  });

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(toDraft(data)) : false;
  const rows = useMemo(() => {
    const base = data?.ranking ?? [];
    const term = search.trim().toLowerCase();
    const filtered = base.filter((player) => {
      if (levelFilter !== "all" && player.level !== levelFilter) return false;
      if (onlyStopped && player.status === "active") return false;
      if (!term) return true;
      return (
        player.nome.toLowerCase().includes(term) ||
        (player.telefone ?? "").toLowerCase().includes(term) ||
        (player.player_external_id ?? "").toLowerCase().includes(term)
      );
    });

    return filtered.sort((a, b) => {
      if (sort === "name") return a.nome.localeCompare(b.nome);
      if (sort === "stopped") return (b.daysWithoutDeposit ?? -1) - (a.daysWithoutDeposit ?? -1);
      return b.total_depositado - a.total_depositado;
    });
  }, [data, search, levelFilter, onlyStopped, sort]);

  useEffect(() => setPage(1), [search, levelFilter, onlyStopped, sort]);

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState onRetry={() => refetch()} />;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-normal">Gamificacao</h1>
        <p className="mt-2 max-w-4xl text-sm text-muted-foreground">
          Cada jogador ganha um nivel pelo total que ja depositou. Os melhores ficam visiveis e viram publico de campanha.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" asChild className="h-12 px-5">
          <Link to="/sms" hash="campanhas">
            <MessageSquareText className="h-4 w-4" />
            Mensagens por evento
          </Link>
        </Button>
        <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
        <div className="inline-flex h-10 items-center gap-2 rounded-md border border-border/60 bg-card/70 px-4 text-sm text-muted-foreground">
          <WalletCards className="h-4 w-4" />
          <span className="font-semibold text-foreground">SMS</span>
          creditos conectados
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        {data.levels.map((level) => (
          <LevelCard key={level.slug} level={level} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_0.7fr]">
        <Card className="overflow-hidden border-border/50 bg-card/70">
          <div className="border-b border-border/50 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">VIPs que pararam de depositar</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {levelLabel(data.settings.vipMinLevel)} para cima, sem depositar ha {data.settings.coolingAfterDays}+ dias.
                  Segurar quem mais vale e a campanha de maior retorno.
                </p>
              </div>
              <Button asChild className="h-11 px-5">
                <Link to="/sms" hash="massa">Criar campanha</Link>
              </Button>
            </div>
          </div>
          <CardContent className="p-5">
            <div className="space-y-3">
              {data.vipStopped.length === 0 && (
                <div className="rounded-md border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
                  Nenhum VIP parado dentro da regra atual.
                </div>
              )}
              {data.vipStopped.map((player) => (
                <VipStoppedRow key={player.id} player={player} />
              ))}
              {data.totals.stoppedVipCount > data.vipStopped.length && (
                <p className="text-sm text-muted-foreground">
                  e mais {data.totals.stoppedVipCount - data.vipStopped.length} na base completa abaixo com so quem parou.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="overflow-hidden border-border/50 bg-card/70">
            <div className="border-b border-border/50 p-5">
              <h2 className="text-lg font-semibold">Faixas de nivel</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Total depositado a partir do qual o jogador entra em cada nivel. Os numeros acima recalculam quando voce salva.
              </p>
              <Button
                className="mt-4 h-10 px-5"
                disabled={!dirty || mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? "Salvando..." : dirty ? "Salvar" : "Tudo salvo"}
              </Button>
            </div>
            <CardContent className="space-y-3 p-5">
              {PAID_LEVELS.map((level) => (
                <ThresholdInput
                  key={level}
                  level={level}
                  value={draft[level]}
                  onChange={(value) => setDraft((cur) => ({ ...cur, [level]: value }))}
                />
              ))}
              <div className="border-t border-border/50 pt-4">
                <h3 className="font-semibold">Quando o jogador esfria</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Nivel e valor. Situacao e tempo sem depositar.
                </p>
                <div className="mt-4 space-y-3">
                  <DaysInput
                    label="Esfriando apos"
                    tone="cooling"
                    value={draft.coolingAfterDays}
                    onChange={(value) => setDraft((cur) => ({ ...cur, coolingAfterDays: value }))}
                  />
                  <DaysInput
                    label="Dormindo apos"
                    tone="sleeping"
                    value={draft.sleepingAfterDays}
                    onChange={(value) => setDraft((cur) => ({ ...cur, sleepingAfterDays: value }))}
                  />
                  <div className="grid gap-2 sm:grid-cols-[160px_1fr] sm:items-center">
                    <span className="text-sm font-medium">VIP a partir de</span>
                    <Select
                      value={draft.vipMinLevel}
                      onValueChange={(value) =>
                        setDraft((cur) => ({ ...cur, vipMinLevel: value as PaidLevelSlug }))
                      }
                    >
                      <SelectTrigger className="h-12 bg-background/70">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAID_LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {levelLabel(level)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/70">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold">O que fazer com isso</h2>
              <p className="mt-1 text-sm text-muted-foreground">Nivel nao e enfeite: e publico de campanha</p>
              <div className="mt-5 space-y-4 text-sm leading-relaxed">
                <p><strong>Black VIP e Diamante que pararam</strong> - atendimento humano, nao disparo. Um cliente desses vale mais que mil Novatos.</p>
                <p><strong>Bronze que virou Prata</strong> - vale uma mensagem de reconhecimento no dia em que sobe de nivel.</p>
                <p><strong>Novato ha mais de 7 dias</strong> - cadastrou e nunca depositou. E publico de oferta de primeiro deposito, nao de reativacao.</p>
              </div>
              <Button variant="outline" asChild className="mt-5 h-10 w-full">
                <Link to="/players">Ver a base completa</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden border-border/50 bg-card/70">
        <div className="border-b border-border/50 p-5">
          <h2 className="text-lg font-semibold">Jogadores por nivel</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sem filtro, e o ranking da casa por total depositado</p>
        </div>
        <CardContent className="p-0">
          <div className="grid gap-3 border-b border-border/50 p-5 lg:grid-cols-[1fr_190px_210px_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nome, telefone ou ID..."
                className="h-12 bg-background/70 pl-9"
              />
            </div>
            <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value as "all" | LevelSlug)}>
              <SelectTrigger className="h-12 bg-background/70">
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
              <SelectTrigger className="h-12 bg-background/70">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">Mais depositaram</SelectItem>
                <SelectItem value="stopped">Mais tempo parados</SelectItem>
                <SelectItem value="name">Nome</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant={onlyStopped ? "default" : "secondary"}
              className="h-12 px-5"
              onClick={() => setOnlyStopped((value) => !value)}
            >
              So quem parou
            </Button>
          </div>
          <div className="flex items-center justify-between px-5 py-3 text-sm text-muted-foreground">
            <span>{rows.length === 0 ? "0" : `${(currentPage - 1) * pageSize + 1}-${(currentPage - 1) * pageSize + visibleRows.length}`} de {rows.length} jogadores</span>
            <span>base de {num(data.totals.players)}</span>
          </div>
          <div className="divide-y divide-border/50">
            {visibleRows.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">Nenhum jogador encontrado.</div>
            )}
            {visibleRows.map((player, index) => (
              <RankingRow
                key={player.id}
                player={player}
                position={(currentPage - 1) * pageSize + index + 1}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 p-5">
            <Button
              variant="secondary"
              size="icon"
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {pageButtons(currentPage, totalPages).map((item, index) =>
              item === "dots" ? (
                <span key={`${item}-${index}`} className="px-2 text-muted-foreground">...</span>
              ) : (
                <Button
                  key={item}
                  variant={item === currentPage ? "default" : "secondary"}
                  className="h-11 w-14"
                  onClick={() => setPage(item)}
                >
                  {item}
                </Button>
              ),
            )}
            <Button
              variant="secondary"
              size="icon"
              disabled={currentPage === totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LevelCard({ level }: { level: GamificationData["levels"][number] }) {
  const Icon = levelIcon(level.slug);
  return (
    <Card className="border-border/50 bg-card/70">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wide ${levelColor(level.slug)}`}>
              {level.label}
            </div>
            <div className="mt-4 flex items-end gap-2">
              <span className="text-3xl font-bold">{num(level.count)}</span>
              <span className="pb-1 text-sm text-muted-foreground">{level.percent}%</span>
            </div>
          </div>
          <Icon className={`h-5 w-5 ${levelColor(level.slug)}`} />
        </div>
        <div className="mt-3 text-sm text-muted-foreground">{brl(level.totalDeposited)} depositados</div>
        {level.slug !== "novice" && (
          <div className="mt-2 text-xs font-semibold text-amber-400">{num(level.stopped)} sem depositar</div>
        )}
      </CardContent>
    </Card>
  );
}

function VipStoppedRow({ player }: { player: GamificationPlayer }) {
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: player.id }}
      className="grid grid-cols-[120px_1fr_auto_auto] items-center gap-4 rounded-lg border border-border/40 bg-background/50 px-4 py-3 transition-colors hover:border-primary/50 hover:bg-primary/5"
    >
      <LevelBadge level={player.level} />
      <span className="truncate font-semibold">{player.nome}</span>
      <span className="text-sm font-medium text-amber-400">ha {player.daysWithoutDeposit ?? 0} dias</span>
      <span className="font-bold">{brl(player.total_depositado)}</span>
    </Link>
  );
}

function RankingRow({ player, position }: { player: GamificationPlayer; position: number }) {
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId: player.id }}
      className="grid grid-cols-[52px_1.2fr_180px_130px_120px] items-center gap-4 px-5 py-4 transition-colors hover:bg-primary/5"
    >
      <span className="text-sm text-muted-foreground">{position}º</span>
      <div className="min-w-0">
        <div className="truncate font-semibold">{player.nome}</div>
        <div className="truncate text-xs text-muted-foreground">
          {player.player_external_id ?? "..."} - deposito {player.daysWithoutDeposit == null ? "nunca" : `ha ${player.daysWithoutDeposit} dias`}
        </div>
      </div>
      <LevelBadge level={player.level} />
      <StatusText status={player.status} />
      <span className="text-right font-bold">{brl(player.total_depositado)}</span>
    </Link>
  );
}

function ThresholdInput({
  level,
  value,
  onChange,
}: {
  level: PaidLevelSlug;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[150px_70px_1fr] sm:items-center">
      <div className={`flex items-center gap-2 text-sm font-semibold ${levelColor(level)}`}>
        {levelLabel(level)}
      </div>
      <span className="text-sm text-muted-foreground">a partir de R$</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} className="h-12 bg-background/70" type="number" min={0} />
    </div>
  );
}

function DaysInput({
  label,
  value,
  onChange,
  tone,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  tone: "cooling" | "sleeping";
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[160px_1fr_110px] sm:items-center">
      <span className={`text-sm font-medium ${tone === "cooling" ? "text-amber-400" : "text-rose-400"}`}>{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} className="h-12 bg-background/70" type="number" min={1} />
      <span className="text-sm text-muted-foreground">dias sem depositar</span>
    </div>
  );
}

function LevelBadge({ level }: { level: LevelSlug }) {
  const Icon = levelIcon(level);
  return (
    <Badge variant="outline" className={`w-fit gap-1.5 border-border/70 bg-background/50 ${levelColor(level)}`}>
      <Icon className="h-3.5 w-3.5" />
      {levelLabel(level)}
    </Badge>
  );
}

function StatusText({ status }: { status: PlayerStatus }) {
  const label =
    status === "active" ? "Ativo"
    : status === "cooling" ? "Esfriando"
    : status === "sleeping" ? "Dormindo"
    : "Sem deposito";
  const color =
    status === "active" ? "text-emerald-400"
    : status === "cooling" ? "text-amber-400"
    : status === "sleeping" ? "text-rose-400"
    : "text-primary";
  return <span className={`text-sm font-medium ${color}`}>{label}</span>;
}

function LoadingState() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-40" />)}
      </div>
      <Skeleton className="h-[540px] w-full" />
    </div>
  );
}

function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="border-border/50 bg-card/70">
      <CardContent className="p-8 text-center">
        <div className="text-lg font-semibold">Nao foi possivel carregar a gamificacao</div>
        <Button className="mt-4" onClick={onRetry}>Tentar novamente</Button>
      </CardContent>
    </Card>
  );
}

function defaultDraft() {
  return {
    bronze: "10",
    silver: "200",
    gold: "500",
    diamond: "1000",
    black: "3000",
    coolingAfterDays: "2",
    sleepingAfterDays: "7",
    vipMinLevel: "diamond" as PaidLevelSlug,
  };
}

function toDraft(data: GamificationData) {
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

function levelLabel(level: LevelSlug | PaidLevelSlug) {
  if (level === "novice") return "Novato";
  if (level === "bronze") return "Bronze";
  if (level === "silver") return "Prata";
  if (level === "gold") return "Ouro";
  if (level === "diamond") return "Diamante";
  return "Black VIP";
}

function levelColor(level: LevelSlug) {
  if (level === "novice") return "text-emerald-300";
  if (level === "bronze") return "text-orange-400";
  if (level === "silver") return "text-sky-200";
  if (level === "gold") return "text-amber-400";
  if (level === "diamond") return "text-cyan-300";
  return "text-violet-300";
}

function levelIcon(level: LevelSlug) {
  if (level === "novice") return Sprout;
  if (level === "diamond") return Gem;
  if (level === "black") return Crown;
  if (level === "gold") return Trophy;
  if (level === "silver") return Medal;
  return Activity;
}

function pageButtons(current: number, total: number): Array<number | "dots"> {
  if (total <= 10) return Array.from({ length: total }, (_, index) => index + 1);
  const out: Array<number | "dots"> = [1];
  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);
  if (start > 2) out.push("dots");
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < total - 1) out.push("dots");
  out.push(total);
  return out;
}
