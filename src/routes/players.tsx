import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { brl, timeAgo } from "@/lib/format";
import {
  Search,
  Crown,
  ChevronLeft,
  ChevronRight,
  Download,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Copy,
  Check,
  Calendar as CalendarIcon,
  X,
  Eye,
  FileSearch,
  MessageSquareText,
  RefreshCw,
  Upload,
} from "lucide-react";
import { MessageCircle } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DateRange } from "react-day-picker";
import { parseBrtDayStart, parseBrtDayEnd } from "@/lib/tz";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  computeAlertsByPlayer,
  whatsappMessageFor,
  type AlertaTipo,
  type Alerta,
  type PlayerLike,
  type RawDepositRow,
  type RawFollowupRow,
  type RawPlayerRow,
  type RawSessionRow,
  type RawWithdrawalRow,
} from "@/lib/player-rules";
import { EnviarPeloWhatsAppDialog } from "@/components/whatsapp/send-dialog";
import { nextPrecallCopy } from "@/lib/precall-copy";
import { PlayerContactHistoryDialog } from "@/components/history/player-contact-history";
import { getQuedaDepositosPlayerIds } from "@/lib/queda-depositos.functions";
import { getLeadQuenteEsfriandoPlayerIds } from "@/lib/lead-quente-esfriando.functions";
import { getAlertPlayerIdsByTipo } from "@/lib/alert-ids.functions";
import {
  getPlayersPage,
  getPlayersFilteredExternalIds,
  getPlayersFilteredSmsAudience,
  type PlayerRow,
} from "@/lib/players-list.functions";
import { getGamificationData, type LevelSlug } from "@/lib/gamification.functions";
import {
  listPendingConversion,
  listRecentFollowupKeys,
  markConversionOutcome,
  listConvertedLeads,
  listNotConvertedLeads,
  type PendingConversionRow,
  type OutcomeRow,
} from "@/lib/pending-conversion.functions";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/players")({
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" && search.id.trim() ? search.id.trim() : undefined,
    focus:
      typeof search.focus === "string" && search.focus.trim() ? search.focus.trim() : undefined,
  }),
  component: PlayersPage,
});

type Player = PlayerRow;
type WhatsAppDialogPlayer = PlayerLike & Pick<PlayerRow, "id" | "nome" | "telefone" | "email">;
const EMPTY_PLAYERS: Player[] = [];

type PaidLevelSlug = Exclude<LevelSlug, "novice">;
type PlayerSituation = "active" | "cooling" | "sleeping" | "no_deposit";
type PlayerGamificationSettings = {
  thresholds: Record<PaidLevelSlug, number>;
  coolingAfterDays: number;
  sleepingAfterDays: number;
};

const DEFAULT_PLAYER_GAMIFICATION: PlayerGamificationSettings = {
  thresholds: {
    bronze: 10,
    silver: 200,
    gold: 500,
    diamond: 1000,
    black: 3000,
  },
  coolingAfterDays: 2,
  sleepingAfterDays: 7,
};

const levelBadgeMeta: Record<LevelSlug, { label: string; className: string }> = {
  novice: { label: "Novato", className: "border-emerald-400/30 text-emerald-300" },
  bronze: { label: "Bronze", className: "border-orange-400/30 text-orange-300" },
  silver: { label: "Prata", className: "border-sky-200/30 text-sky-100" },
  gold: { label: "Ouro", className: "border-amber-400/40 text-amber-300" },
  diamond: { label: "Diamante", className: "border-cyan-300/40 text-cyan-200" },
  black: { label: "Black VIP", className: "border-violet-300/40 text-violet-200" },
};

const situationBadgeMeta: Record<PlayerSituation, { label: string; className: string }> = {
  active: { label: "Ativo", className: "text-emerald-400" },
  cooling: { label: "Esfriando", className: "text-amber-400" },
  sleeping: { label: "Dormindo", className: "text-rose-400" },
  no_deposit: { label: "Sem depósito", className: "text-primary" },
};

const filters = [
  { id: "todos", label: "Todos" },
  { id: "ativo", label: "Ativo (já depositou)" },
  { id: "cashback_pago_hoje", label: "Cashback pago hoje" },
  { id: "recorrentes", label: "Logaram nos últimos 4 dias" },
  { id: "risco_5_7", label: "Em risco (5-7 dias)" },
  { id: "em_risco", label: "7+ dias sem login" },
  { id: "vip", label: "VIP" },
  { id: "vip_em_risco", label: "VIP sem login" },
  { id: "quase_vip", label: "Faltando pouco pro VIP" },
  { id: "leads_quentes", label: "Depositando frequentemente" },
  { id: "com_saldo", label: "Players com saldo" },
  { id: "deposito_hoje", label: "Depositaram hoje" },
  { id: "ftd_hoje", label: "FTD hoje" },
  { id: "nao_converteram", label: "Cadastrados sem depósito" },
  { id: "risco_inicial", label: "7 a 14 dias sem login" },
  { id: "risco_moderado", label: "15 a 24 dias sem login" },
  { id: "risco_alto", label: "25 a 34 dias sem login" },
  { id: "quase_perdido", label: "35 a 44 dias sem login" },
  { id: "recuperacao_dificil", label: "45 a 59 dias sem login" },
  { id: "perdidos", label: "60+ dias sem login" },
];

// Chips que filtram por gatilho de alerta em tempo real
// (mesma lógica da página /alertas — quando a gente manda mensagem o lead some daqui)
const alertFilters: { id: AlertaTipo; label: string }[] = [
  { id: "abandono_vip", label: "VIP recuperável" },
  { id: "vip_sem_atividade", label: "VIP esfriando" },
  { id: "queda_depositos", label: "Queda de depósitos" },
  { id: "lead_quente_esfriando", label: "Lead quente esfriando" },
  { id: "proximo_vip", label: "Quase VIP" },
  { id: "alto_potencial", label: "Alto potencial" },
  { id: "player_reativado", label: "Reativado" },
  { id: "sequencia_depositos", label: "Em sequência" },
  { id: "saldo_parado", label: "Saldo parado (alerta)" },
  { id: "login_sem_deposito", label: "Logando sem depositar" },
  { id: "frequencia_caindo", label: "Frequência caindo" },
];
const ALERT_FILTER_IDS = new Set<string>(alertFilters.map((a) => a.id));

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const gamificationStatusFilters = [
  { id: "todos", label: "Todos", tone: "text-muted-foreground" },
  { id: "situacao_active", label: "Ativo", tone: "text-emerald-400" },
  { id: "situacao_cooling", label: "Esfriando", tone: "text-amber-400" },
  { id: "situacao_sleeping", label: "Dormindo", tone: "text-rose-400" },
  { id: "situacao_no_deposit", label: "Sem depósito", tone: "text-primary" },
];

const gamificationLevelFilters: Array<{
  id: string;
  level: LevelSlug;
  label: string;
  tone: string;
}> = [
  { id: "nivel_novice", level: "novice", label: "Novato", tone: "text-emerald-300" },
  { id: "nivel_bronze", level: "bronze", label: "Bronze", tone: "text-orange-400" },
  { id: "nivel_silver", level: "silver", label: "Prata", tone: "text-sky-200" },
  { id: "nivel_gold", level: "gold", label: "Ouro", tone: "text-amber-400" },
  { id: "nivel_diamond", level: "diamond", label: "Diamante", tone: "text-cyan-300" },
  { id: "nivel_black", level: "black", label: "Black VIP", tone: "text-violet-300" },
];

// Gatilhos calculados no servidor (SQL) — logins vêm da tabela events.
const SERVER_ALERT_FILTERS = new Set<string>([
  "alto_potencial",
  "player_reativado",
  "sequencia_depositos",
  "login_sem_deposito",
  "frequencia_caindo",
]);

// Para os filtros padrão (não-alerta), define qual coluna o servidor usa quando
// o usuário ainda não clicou em nenhum cabeçalho de ordenação.
function defaultSortKey(
  filter: string,
):
  | "ultimo_login"
  | "ultimo_jogo"
  | "total_depositado"
  | "total_sacado"
  | "ultimo_deposito"
  | "saldo"
  | "lucro"
  | "status"
  | "origem" {
  const sortByDeposit = new Set([
    "em_risco",
    "risco_5_7",
    "risco_inicial",
    "risco_moderado",
    "risco_alto",
    "quase_perdido",
    "recuperacao_dificil",
    "perdidos",
    "vip_em_risco",
    "com_saldo",
    "quase_vip",
  ]);
  return sortByDeposit.has(filter) ? "total_depositado" : "ultimo_login";
}

function riskDot(r: string) {
  const c =
    r === "alto"
      ? "bg-red-500 shadow-red-500/60"
      : r === "medio"
        ? "bg-amber-400 shadow-amber-400/60"
        : "bg-emerald-400 shadow-emerald-400/60";
  return <span className={`inline-block h-2 w-2 rounded-full shadow-[0_0_8px] ${c}`} />;
}

function getPlayerLevel(
  player: Player,
  settings: PlayerGamificationSettings = DEFAULT_PLAYER_GAMIFICATION,
): LevelSlug {
  const total = Number(player.total_depositado ?? 0);
  const { thresholds } = settings;
  if (total >= thresholds.black) return "black";
  if (total >= thresholds.diamond) return "diamond";
  if (total >= thresholds.gold) return "gold";
  if (total >= thresholds.silver) return "silver";
  if (total >= thresholds.bronze) return "bronze";
  return "novice";
}

function daysSinceIso(value: string | null) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function getPlayerSituation(
  player: Player,
  settings: PlayerGamificationSettings = DEFAULT_PLAYER_GAMIFICATION,
): PlayerSituation {
  const total = Number(player.total_depositado ?? 0);
  if (!player.ftd_em && total <= 0) return "no_deposit";
  const daysWithoutDeposit = daysSinceIso(player.ultimo_deposito ?? player.ftd_em);
  if (daysWithoutDeposit == null) return "no_deposit";
  if (daysWithoutDeposit >= settings.sleepingAfterDays) return "sleeping";
  if (daysWithoutDeposit >= settings.coolingAfterDays) return "cooling";
  return "active";
}

type SortKey =
  | "ultimo_login"
  | "ultimo_jogo"
  | "total_depositado"
  | "total_sacado"
  | "lucro"
  | "saldo"
  | "status"
  | "origem";

function PlayersPage() {
  const navigate = useNavigate();
  const routeSearch = Route.useSearch();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const linkedPlayerId = routeSearch.id ?? routeSearch.focus ?? null;
  const isDetailRoute =
    pathname.replace(/\/+$/, "") !== "/players" && pathname.startsWith("/players/");
  const [filter, setFilter] = useState("todos");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [dateField, setDateField] = useState<"created_at" | "ftd_em">("ftd_em");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [dateOpen, setDateOpen] = useState(false);
  const pageSize = 50;
  const qc = useQueryClient();
  const [waDialog, setWaDialog] = useState<{
    player: WhatsAppDialogPlayer;
    alerta?: Alerta;
  } | null>(null);
  const [waMensagem, setWaMensagem] = useState<string>("");
  const [historyPlayer, setHistoryPlayer] = useState<{ id: string; nome: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!linkedPlayerId || isDetailRoute) return;

    void navigate({
      to: "/players/$playerId",
      params: { playerId: linkedPlayerId },
      replace: true,
    });
  }, [isDetailRoute, linkedPlayerId, navigate]);

  // Nome do tenant atual para a copy de pré-ligação. RLS já garante que
  // o usuário só vê o próprio tenant.
  const { data: tenantBrand } = useQuery({
    queryKey: ["current-tenant-brand"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("nome").limit(1).maybeSingle();
      return (data?.nome as string | undefined) ?? "";
    },
    staleTime: 5 * 60_000,
  });

  const fetchGamification = useServerFn(getGamificationData);
  const {
    data: gamification,
    refetch: refetchGamification,
    isFetching: isFetchingGamification,
  } = useQuery({
    queryKey: ["gamification"],
    queryFn: () => fetchGamification(),
    staleTime: 20_000,
  });

  // Converte range de dias BRT para ISO UTC (início e fim do dia).
  const dateFromIso = dateRange?.from
    ? parseBrtDayStart(
        `${dateRange.from.getFullYear()}-${String(dateRange.from.getMonth() + 1).padStart(2, "0")}-${String(dateRange.from.getDate()).padStart(2, "0")}`,
      ).toISOString()
    : null;
  const dateToIso =
    (dateRange?.to ?? dateRange?.from)
      ? parseBrtDayEnd(
          (() => {
            const d = dateRange!.to ?? dateRange!.from!;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          })(),
        ).toISOString()
      : null;
  const hasDateRange = !!(dateFromIso && dateToIso);

  function fmtBr(d: Date) {
    return d.toLocaleDateString("pt-BR");
  }

  const isAlertFilter = ALERT_FILTER_IDS.has(filter);
  const isQuedaFilter = filter === "queda_depositos";
  const isLqeFilter = filter === "lead_quente_esfriando";
  const isServerAlertFilter = SERVER_ALERT_FILTERS.has(filter);
  const isPendingFilter = filter === "aguardando_conversao";
  const isConvertedFilter = filter === "convertido";
  const isNotConvertedFilter = filter === "nao_convertido";
  const isOutcomeFilter = isConvertedFilter || isNotConvertedFilter;

  const fetchRecentFollowupKeys = useServerFn(listRecentFollowupKeys);
  const { data: recentFollowupData } = useQuery({
    queryKey: ["players-recent-followup-keys"],
    queryFn: () => fetchRecentFollowupKeys(),
    // Sempre buscar — usado para o badge ⏳ em qualquer linha de player.
    enabled: true,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const recentFollowupKeySet = useMemo(
    () => new Set(recentFollowupData?.keys ?? []),
    [recentFollowupData],
  );
  // Player IDs com QUALQUER followup pendente — pro badge ⏳ na linha.
  const pendingPlayerIdsAny = useMemo(() => {
    const set = new Set<string>();
    for (const k of recentFollowupKeySet) set.add(k.split(":")[0]);
    return set;
  }, [recentFollowupKeySet]);

  // Lista de leads "aguardando conversão" (view dedicada do chip).
  const fetchPendingConversion = useServerFn(listPendingConversion);
  const fetchMarkOutcome = useServerFn(markConversionOutcome);
  const { data: pendingData, isLoading: pendingLoading } = useQuery({
    queryKey: ["players-pending-conversion"],
    queryFn: () => fetchPendingConversion(),
    enabled: isPendingFilter,
    staleTime: 15_000,
    refetchInterval: isPendingFilter ? 60_000 : false,
  });

  const fetchConverted = useServerFn(listConvertedLeads);
  const { data: convertedData, isLoading: convertedLoading } = useQuery({
    queryKey: ["players-converted"],
    queryFn: () => fetchConverted(),
    enabled: isConvertedFilter,
    staleTime: 15_000,
    refetchInterval: isConvertedFilter ? 60_000 : false,
  });

  const fetchNotConverted = useServerFn(listNotConvertedLeads);
  const { data: notConvertedData, isLoading: notConvertedLoading } = useQuery({
    queryKey: ["players-not-converted"],
    queryFn: () => fetchNotConverted(),
    enabled: isNotConvertedFilter,
    staleTime: 15_000,
    refetchInterval: isNotConvertedFilter ? 60_000 : false,
  });

  async function handleMarkOutcome(row: PendingConversionRow, converted: boolean) {
    try {
      await fetchMarkOutcome({
        data: {
          player_id: row.player_id,
          alerta_tipo: row.alerta_tipo,
          converted,
        },
      });
      toast.success(converted ? "Marcado como convertido" : "Marcado como sem resposta");
      qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
      qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
      qc.invalidateQueries({ queryKey: ["players-alerts"] });
      qc.invalidateQueries({ queryKey: ["players-converted"] });
      qc.invalidateQueries({ queryKey: ["players-not-converted"] });
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Erro ao registrar desfecho"));
    }
  }

  // Abre o dialog do WhatsApp a partir de uma linha das tabelas de
  // Aguardando / Converteu / Não converteu, reaproveitando a copy de
  // pré-ligação padrão.
  function openWaFromRow(row: {
    player_id: string;
    nome: string;
    telefone: string | null;
    email: string | null;
  }) {
    if (!row.telefone) {
      toast.error("Lead sem telefone cadastrado");
      return;
    }
    setWaMensagem(nextPrecallCopy({ fullName: row.nome, brand: tenantBrand ?? "" }));
    setWaDialog({
      player: {
        id: row.player_id,
        nome: row.nome,
        telefone: row.telefone,
        email: row.email,
      },
    });
  }

  // Query dedicada para "Queda de depósitos" — agregação roda no servidor,
  // o client só recebe a lista de IDs.
  const fetchQuedaIds = useServerFn(getQuedaDepositosPlayerIds);
  const { data: quedaIds } = useQuery({
    queryKey: ["players-queda-ids"],
    queryFn: () => fetchQuedaIds(),
    enabled: isQuedaFilter,
    refetchInterval: isQuedaFilter ? 60_000 : false,
    staleTime: 30_000,
  });
  const quedaIdSet = useMemo(() => (quedaIds ? new Set(quedaIds.ids) : null), [quedaIds]);

  // Query dedicada para "Lead quente esfriando" — mesma estratégia.
  const fetchLqeIds = useServerFn(getLeadQuenteEsfriandoPlayerIds);
  const { data: lqeIds } = useQuery({
    queryKey: ["players-lqe-ids"],
    queryFn: () => fetchLqeIds(),
    enabled: isLqeFilter,
    refetchInterval: isLqeFilter ? 60_000 : false,
    staleTime: 30_000,
  });
  const lqeIdSet = useMemo(() => (lqeIds ? new Set(lqeIds.ids) : null), [lqeIds]);

  // Query dedicada para os demais gatilhos (alto potencial, reativado, em
  // sequência, logando sem depositar, frequência caindo) — agregação em SQL.
  const fetchAlertIds = useServerFn(getAlertPlayerIdsByTipo);
  const { data: alertIdsData } = useQuery({
    queryKey: ["players-alert-ids"],
    queryFn: () => fetchAlertIds(),
    enabled: isServerAlertFilter,
    refetchInterval: isServerAlertFilter ? 60_000 : false,
    staleTime: 30_000,
  });
  const serverAlertIdSet = useMemo(() => {
    if (!alertIdsData) return null;
    return new Set(alertIdsData.byTipo[filter] ?? []);
  }, [alertIdsData, filter]);

  // Realtime: atualiza a tabela quando players/depositos mudarem.
  // Faz debounce (3s) pra não disparar uma rajada de refetches em horário de pico.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        qc.invalidateQueries({ queryKey: ["players-page"] });
      }, 3000);
    };
    const channel = supabase
      .channel("players-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "players" }, schedule)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "players" }, schedule)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "deposits" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "lead_followups" }, () => {
        qc.invalidateQueries({ queryKey: ["players-alerts"] });
        qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
        qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
        qc.invalidateQueries({ queryKey: ["players-local-alerts"] });
        qc.invalidateQueries({ queryKey: ["players-converted"] });
        qc.invalidateQueries({ queryKey: ["players-not-converted"] });
      })
      .subscribe();
    return () => {
      if (pending) clearTimeout(pending);
      supabase.removeChannel(channel);
    };
  }, [qc]);

  // IDs pré-calculados para filtros de alerta (servidor já restringiu o set).
  // Quando o filtro de alerta ainda está carregando, mandamos [] explícito pra
  // não exibir a base inteira sem querer.
  const alertIdsForFilter: string[] | null = useMemo(() => {
    const raw = isQuedaFilter
      ? quedaIdSet
        ? Array.from(quedaIdSet)
        : []
      : isLqeFilter
        ? lqeIdSet
          ? Array.from(lqeIdSet)
          : []
        : isServerAlertFilter
          ? serverAlertIdSet
            ? Array.from(serverAlertIdSet)
            : []
          : null;
    if (raw === null) return null;
    return raw;
  }, [isQuedaFilter, quedaIdSet, isLqeFilter, lqeIdSet, isServerAlertFilter, serverAlertIdSet]);

  // Para os 4 alertas que ainda dependem do cálculo local (abandono_vip,
  // vip_sem_atividade, proximo_vip, saldo_parado), a tabela mostra TODOS os
  // players e o filtro final ocorre via alertsByPlayer (client). Esses 4 chips
  // são raros e quem clica neles já espera ver "porquê apareceu".
  const isLocalAlertFilter =
    isAlertFilter && !isQuedaFilter && !isLqeFilter && !isServerAlertFilter;

  // Quando há ordenação por saldo/lucro precisamos do dataset completo (o
  // server faz no caminho computeClient). Ainda assim só baixa as cols slim.
  const fetchPlayersPage = useServerFn(getPlayersPage);
  const { data: pageData, isLoading } = useQuery({
    queryKey: [
      "players-page",
      page,
      pageSize,
      filter,
      search,
      sort?.key ?? null,
      sort?.dir ?? "desc",
      // serializa os IDs de alerta — pequenos sets na prática
      alertIdsForFilter ? alertIdsForFilter.length : null,
      alertIdsForFilter ? (alertIdsForFilter.slice(0, 1)[0] ?? "") : "",
      dateField,
      dateFromIso,
      dateToIso,
    ],
    queryFn: () =>
      fetchPlayersPage({
        data: {
          page,
          pageSize,
          filter,
          search,
          sortKey: sort?.key ?? defaultSortKey(filter),
          sortDir: sort?.dir ?? "desc",
          idsIn: alertIdsForFilter,
          dateField: hasDateRange ? dateField : null,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        },
      }),
    // Para os filtros locais (proximo_vip, abandono_vip, etc.) o servidor não
    // consegue restringir; ainda assim trazemos a página completa do filtro.
    enabled: !isLocalAlertFilter
      ? alertIdsForFilter === null
        ? true
        : alertIdsForFilter.length >= 0
      : true,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
  const data = pageData?.rows ?? EMPTY_PLAYERS;
  const totalCount = pageData?.total ?? 0;

  // Para os 4 alertas que rodam só no client (abandono_vip, vip_sem_atividade,
  // proximo_vip, saldo_parado) precisamos do dataset slim pra computar e filtrar.
  // Esse é o único caso que ainda baixa muitas linhas — mas só dispara quando
  // esses chips específicos são clicados.
  const { data: localAlertData } = useQuery({
    queryKey: ["players-local-alerts", filter, search],
    enabled: isLocalAlertFilter,
    refetchInterval: isLocalAlertFilter ? 30_000 : false,
    staleTime: 15_000,
    queryFn: async () => {
      const iso60 = new Date(Date.now() - 60 * 86400000).toISOString();
      const iso30 = new Date(Date.now() - 30 * 86400000).toISOString();
      // Pega todos os players (slim) — só as colunas que detectAlerts usa.
      const all: Player[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id,nome,telefone,email,player_external_id,origem,expert,status,ultimo_login,ultimo_jogo,ultimo_deposito,total_depositado,total_sacado,saldo_carteira,saldo_bonus,tags,vip,risco,created_at,ftd_em",
          )
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const batch = (data ?? []) as unknown as Player[];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      const [depsRes, wdRes, sessRes, fupRes] = await Promise.all([
        supabase
          .from("deposits")
          .select("player_id,valor,created_at,status")
          .gte("created_at", iso60)
          .eq("status", "aprovado")
          .limit(20000),
        supabase
          .from("withdrawals")
          .select("player_id,valor,created_at")
          .gte("created_at", iso30)
          .limit(10000),
        supabase
          .from("sessions")
          .select("player_id,iniciado_em")
          .gte("iniciado_em", iso60)
          .limit(20000),
        supabase
          .from("lead_followups")
          .select("player_id,alerta_tipo,created_at")
          .gte("created_at", iso30),
      ]);
      const map = computeAlertsByPlayer({
        players: all as RawPlayerRow[],
        deposits: (depsRes.data ?? []) as RawDepositRow[],
        withdrawals: (wdRes.data ?? []) as RawWithdrawalRow[],
        sessions: (sessRes.data ?? []) as RawSessionRow[],
        followups: (fupRes.data ?? []) as RawFollowupRow[],
        recentFollowupHours: 120,
      });
      const tipo = filter as AlertaTipo;
      const s = search.toLowerCase();
      const filtered = all.filter((p) => {
        const alertas = map.get(p.id);
        if (!alertas?.some((a) => a.tipo === tipo)) return false;
        if (!s) return true;
        return (
          p.nome.toLowerCase().includes(s) ||
          (p.telefone ?? "").toLowerCase().includes(s) ||
          (p.email ?? "").toLowerCase().includes(s) ||
          (p.player_external_id ?? "").toLowerCase().includes(s)
        );
      });
      return { rows: filtered, alertsByPlayer: map };
    },
  });

  // Mapa de alertas para mostrar o "porquê apareceu" / botão WhatsApp das
  // linhas visíveis. Só roda quando um chip de alerta está ativo. Para os
  // filtros já cobertos por server-fn (queda, lqe, server alerts), buscamos só
  // os depósitos/saques/sessions/followups dos IDs visíveis na página.
  const visiblePlayerIds = useMemo(() => (data ?? []).map((p) => p.id), [data]);
  const { data: alertsByPlayerServerSide } = useQuery({
    queryKey: ["players-alerts-page", visiblePlayerIds.join(",")],
    enabled: isAlertFilter && !isLocalAlertFilter && visiblePlayerIds.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const iso60 = new Date(Date.now() - 60 * 86400000).toISOString();
      const iso30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [depsRes, wdRes, sessRes, fupRes] = await Promise.all([
        supabase
          .from("deposits")
          .select("player_id,valor,created_at,status")
          .in("player_id", visiblePlayerIds)
          .gte("created_at", iso60)
          .eq("status", "aprovado"),
        supabase
          .from("withdrawals")
          .select("player_id,valor,created_at")
          .in("player_id", visiblePlayerIds)
          .gte("created_at", iso30),
        supabase
          .from("sessions")
          .select("player_id,iniciado_em")
          .in("player_id", visiblePlayerIds)
          .gte("iniciado_em", iso60),
        supabase
          .from("lead_followups")
          .select("player_id,alerta_tipo,created_at")
          .in("player_id", visiblePlayerIds)
          .gte("created_at", iso30),
      ]);
      return computeAlertsByPlayer({
        players: (data ?? []) as RawPlayerRow[],
        deposits: (depsRes.data ?? []) as RawDepositRow[],
        withdrawals: (wdRes.data ?? []) as RawWithdrawalRow[],
        sessions: (sessRes.data ?? []) as RawSessionRow[],
        followups: (fupRes.data ?? []) as RawFollowupRow[],
      });
    },
  });

  // O mapa de alertas (usado pra mostrar o chip "porquê apareceu" e o botão de
  // WhatsApp) vem ou do path local (4 alertas client-side) ou do path por
  // página (alertas cobertos por server-fn).
  const alertsByPlayer = isLocalAlertFilter
    ? localAlertData?.alertsByPlayer
    : alertsByPlayerServerSide;

  // Lista visível: prioriza o path local (que já filtrou+computou),
  // senão usa a página do servidor.
  const localPagedSlice = useMemo(() => {
    if (!isLocalAlertFilter) return null;
    const rows = localAlertData?.rows ?? [];
    const sortByDeposit = new Set([
      "abandono_vip",
      "vip_sem_atividade",
      "proximo_vip",
      "saldo_parado",
    ]);
    const sorted = sort
      ? [...rows].sort((a, b) => {
          const dir = sort.dir === "asc" ? 1 : -1;
          const val = (p: Player) => {
            switch (sort.key) {
              case "ultimo_login":
                return p.ultimo_login ? new Date(p.ultimo_login).getTime() : 0;
              case "ultimo_jogo":
                return p.ultimo_jogo ? new Date(p.ultimo_jogo).getTime() : 0;
              case "total_depositado":
                return Number(p.total_depositado);
              case "total_sacado":
                return Number(p.total_sacado);
              case "lucro":
                return Number(p.total_depositado) - Number(p.total_sacado);
              case "saldo":
                return Number(p.saldo_carteira ?? 0) + Number(p.saldo_bonus ?? 0);
              case "status":
                return p.vip ? 1 : 0;
              case "origem":
                return (p.origem ?? "") + "|" + (p.expert ?? "");
            }
          };
          const va = val(a);
          const vb = val(b);
          if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
          return String(va).localeCompare(String(vb)) * dir;
        })
      : sortByDeposit.has(filter)
        ? [...rows].sort((a, b) => Number(b.total_depositado) - Number(a.total_depositado))
        : rows;
    return {
      total: sorted.length,
      page: sorted.slice((page - 1) * pageSize, page * pageSize),
    };
  }, [isLocalAlertFilter, localAlertData, filter, sort, page, pageSize]);

  const toggleSort = (key: SortKey) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "desc" };
      if (cur.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  useEffect(() => {
    setPage(1);
  }, [filter, search, dateField, dateFromIso, dateToIso]);

  // Limpa seleção quando muda filtro/busca — evita copiar IDs de outro conjunto.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filter, search]);

  // Linhas / totais — vêm do path local (4 alertas) ou da página do servidor.
  const paged: Player[] = isLocalAlertFilter ? (localPagedSlice?.page ?? []) : (data ?? []);
  const filteredCount = isLocalAlertFilter ? (localPagedSlice?.total ?? 0) : totalCount;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  const currentPage = Math.min(page, totalPages);

  const pageNumbers = useMemo(() => {
    const pages: number[] = [];
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, start + 4);
    const realStart = Math.max(1, end - 4);
    for (let i = realStart; i <= end; i++) pages.push(i);
    return pages;
  }, [currentPage, totalPages]);

  const SortHeader = ({ k, label, align }: { k: SortKey; label: string; align?: "right" }) => {
    const active = sort?.key === k;
    const Icon = !active ? ArrowUpDown : sort!.dir === "desc" ? ArrowDown : ArrowUp;
    return (
      <button
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${
          active ? "text-primary" : ""
        } ${align === "right" ? "justify-end w-full" : ""}`}
      >
        {label}
        <Icon className="h-3 w-3 opacity-70" />
      </button>
    );
  };

  const exportCsv = () => {
    const rows = paged;
    const headers = [
      "nome",
      "telefone",
      "email",
      "player_external_id",
      "origem",
      "expert",
      "status",
      "vip",
      "ultimo_login",
      "ultimo_jogo",
      "ultimo_deposito",
      "total_depositado",
      "total_sacado",
      "saldo",
      "lucro",
      "tags",
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const p of rows) {
      const lucro = Number(p.total_depositado) - Number(p.total_sacado);
      const saldo = Number(p.saldo_carteira ?? 0) + Number(p.saldo_bonus ?? 0);
      lines.push(
        [
          p.nome,
          p.telefone,
          p.email,
          p.player_external_id,
          p.origem,
          p.expert,
          p.status,
          p.vip ? "sim" : "nao",
          p.ultimo_login,
          p.ultimo_jogo,
          p.ultimo_deposito,
          p.total_depositado,
          p.total_sacado,
          saldo,
          lucro,
          (p.tags ?? []).join("|"),
        ]
          .map(esc)
          .join(","),
      );
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `leads_${filter}_${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ===== Copiar IDs Push (player_external_id) =====
  // Formato: um ID por linha, sem vírgula, sem espaço, sem duplicados.
  function formatIds(ids: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
      const v = (raw ?? "").toString().trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // navegador antigo bloqueou o fallback de copia
      }
      document.body.removeChild(ta);
      return true;
    }
  }

  async function copyOneId(externalId: string | null | undefined, playerId?: string) {
    const v = (externalId ?? "").trim();
    if (!v) {
      toast.error("Esse player não tem ID Push.");
      return;
    }
    await copyToClipboard(v);
    if (playerId) {
      setCopiedId(playerId);
      setTimeout(() => setCopiedId((cur) => (cur === playerId ? null : cur)), 1500);
    }
    toast.success("ID copiado.");
  }

  async function copySelectedIds() {
    // Usa os IDs externos dos selecionados — buscamos no dataset visível.
    const allRows: Player[] = isLocalAlertFilter ? (localAlertData?.rows ?? []) : (data ?? []);
    const map = new Map(allRows.map((p) => [p.id, p.player_external_id]));
    const externals = Array.from(selectedIds).map((id) => map.get(id) ?? null);
    const ids = formatIds(externals);
    const missing = selectedIds.size - ids.length;
    if (ids.length === 0) {
      toast.error("Nenhum ID Push encontrado entre os selecionados.");
      return;
    }
    await copyToClipboard(ids.join("\n"));
    toast.success(
      missing > 0
        ? `${ids.length} IDs copiados. ${missing} players ignorados por não terem ID Push.`
        : `${ids.length} IDs copiados para a área de transferência.`,
    );
  }

  const fetchFilteredExternalIds = useServerFn(getPlayersFilteredExternalIds);
  const [copyingFilter, setCopyingFilter] = useState(false);

  async function copyFilterIds() {
    setCopyingFilter(true);
    try {
      // Caminho local (4 alertas client-side): já temos a lista completa em memória.
      if (isLocalAlertFilter) {
        const rows = localAlertData?.rows ?? [];
        const ids = formatIds(rows.map((p) => p.player_external_id));
        const missing = rows.length - ids.length;
        if (ids.length === 0) {
          toast.error("Nenhum ID Push encontrado nesse filtro.");
          return;
        }
        await copyToClipboard(ids.join("\n"));
        toast.success(
          missing > 0
            ? `${ids.length} IDs copiados. ${missing} players ignorados por não terem ID Push.`
            : `${ids.length} IDs copiados para a área de transferência.`,
        );
        return;
      }
      // Caminho servidor — busca TODOS os IDs do filtro (não só a página).
      const res = await fetchFilteredExternalIds({
        data: {
          filter,
          search,
          idsIn: alertIdsForFilter,
          dateField: hasDateRange ? dateField : null,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        },
      });
      if (res.ids.length === 0) {
        toast.error("Nenhum ID Push encontrado nesse filtro.");
        return;
      }
      await copyToClipboard(res.ids.join("\n"));
      toast.success(
        res.missing > 0
          ? `${res.ids.length} IDs copiados. ${res.missing} players ignorados por não terem ID Push.`
          : `${res.ids.length} IDs copiados para a área de transferência.`,
      );
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Erro ao copiar IDs"));
    } finally {
      setCopyingFilter(false);
    }
  }

  const fetchSmsAudience = useServerFn(getPlayersFilteredSmsAudience);
  const [buildingAudience, setBuildingAudience] = useState(false);

  const selectedFilterLabel =
    filters.find((f) => f.id === filter)?.label ??
    alertFilters.find((f) => f.id === filter)?.label ??
    gamificationStatusFilters.find((f) => f.id === filter)?.label ??
    gamificationLevelFilters.find((f) => f.id === filter)?.label ??
    (filter === "aguardando_conversao"
      ? "Aguardando conversão"
      : filter === "convertido"
        ? "Converteu"
        : filter === "nao_convertido"
          ? "Não converteu"
          : filter);

  const levelCounts = useMemo(() => {
    const map = new Map<LevelSlug, number>();
    for (const level of gamification?.levels ?? []) map.set(level.slug, level.count);
    return map;
  }, [gamification]);

  const playerGamificationSettings: PlayerGamificationSettings =
    gamification?.settings ?? DEFAULT_PLAYER_GAMIFICATION;

  function saveSmsDraft(args: {
    label: string;
    recipients: Array<{ phone: string; playerId?: string }>;
    missingPhone: number;
  }) {
    const unique = new Map<string, { phone: string; playerId?: string }>();
    for (const recipient of args.recipients) {
      const phone = recipient.phone.replace(/\D/g, "");
      if (phone.length >= 10 && !unique.has(phone)) unique.set(phone, { ...recipient, phone });
    }
    const recipients = Array.from(unique.values());
    if (recipients.length === 0) {
      toast.error("Nenhum player com telefone válido neste público.");
      return;
    }
    window.localStorage.setItem(
      "betleads:smsAudienceDraft",
      JSON.stringify({
        source: "players",
        label: args.label,
        recipients,
        missingPhone: args.missingPhone,
        createdAt: new Date().toISOString(),
      }),
    );
    toast.success(`${recipients.length.toLocaleString("pt-BR")} destinatários enviados para SMS.`);
    navigate({ to: "/sms", hash: "massa" });
  }

  async function sendToSmsAudience(mode: "selected" | "filter") {
    if (mode === "selected") {
      const rows = (isLocalAlertFilter ? (localAlertData?.rows ?? []) : paged).filter((p) =>
        selectedIds.has(p.id),
      );
      saveSmsDraft({
        label: `${selectedIds.size} selecionados em ${selectedFilterLabel}`,
        recipients: rows.map((p) => ({ phone: p.telefone ?? "", playerId: p.id })),
        missingPhone: Math.max(0, selectedIds.size - rows.filter((p) => p.telefone).length),
      });
      return;
    }

    setBuildingAudience(true);
    try {
      if (isLocalAlertFilter) {
        const rows = localAlertData?.rows ?? [];
        saveSmsDraft({
          label: selectedFilterLabel,
          recipients: rows.map((p) => ({ phone: p.telefone ?? "", playerId: p.id })),
          missingPhone: rows.filter((p) => !p.telefone).length,
        });
        return;
      }

      const res = await fetchSmsAudience({
        data: {
          filter,
          search,
          idsIn: alertIdsForFilter,
          dateField: hasDateRange ? dateField : null,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        },
      });
      saveSmsDraft({
        label: selectedFilterLabel,
        recipients: res.recipients.map((r) => ({ phone: r.phone, playerId: r.playerId })),
        missingPhone: res.missingPhone,
      });
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Erro ao montar público de SMS"));
    } finally {
      setBuildingAudience(false);
    }
  }

  if (isDetailRoute) return <Outlet />;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-normal">Jogadores</h1>
        <p className="text-sm text-muted-foreground">
          A base viva da casa. Cada jogador tem um nível, uma situação e pode virar público de SMS.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          className="h-12 px-5"
          onClick={exportCsv}
          disabled={filteredCount === 0}
        >
          <Download className="h-4 w-4" />
          Exportar CSV
        </Button>
        <Button
          className="h-12 px-5"
          disabled={filteredCount === 0 || buildingAudience}
          onClick={() => sendToSmsAudience("filter")}
        >
          <MessageSquareText className="h-4 w-4" />
          Usar como público
        </Button>
        <Button variant="outline" className="h-12 px-5" disabled>
          <Upload className="h-4 w-4" />
          Importar base
        </Button>
        <Button variant="outline" className="h-12 px-5" disabled>
          <FileSearch className="h-4 w-4" />
          Procurar repetidos
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-12 w-12"
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["players-page"] });
            void refetchGamification();
          }}
          disabled={isLoading || isFetchingGamification}
        >
          <RefreshCw
            className={`h-4 w-4 ${isLoading || isFetchingGamification ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-border/70 bg-card/70">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Base total
            </p>
            <p className="mt-3 text-4xl font-bold text-primary">
              {(gamification?.totals.players ?? totalCount).toLocaleString("pt-BR")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">jogadores acompanhados</p>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/70">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Já depositaram
            </p>
            <p className="mt-3 text-4xl font-bold">
              {(gamification?.totals.depositors ?? 0).toLocaleString("pt-BR")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {gamification?.totals.players
                ? `${Math.round((gamification.totals.depositors / gamification.totals.players) * 100)}% da base`
                : "aguardando dados"}
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/70">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Depositado no total
            </p>
            <p className="mt-3 text-3xl font-bold">{brl(gamification?.totals.deposited ?? 0)}</p>
            <p className="mt-1 text-sm text-muted-foreground">soma das fichas importadas</p>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/70">
          <CardContent className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              VIPs esfriando
            </p>
            <p className="mt-3 text-4xl font-bold">{gamification?.totals.stoppedVipCount ?? 0}</p>
            <p className="mt-1 text-sm text-muted-foreground">Diamante para cima, parados</p>
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        As fichas abaixo contam os jogadores da base. A tabela mostra os maiores do filtro — use a
        busca para achar qualquer outro.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {gamificationStatusFilters.map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={`inline-flex h-12 items-center gap-3 rounded-lg border px-5 text-sm font-semibold transition-colors ${
                filter === item.id
                  ? "border-primary/70 bg-primary text-primary-foreground"
                  : "border-border/60 bg-card/70 hover:border-primary/50 hover:bg-primary/5"
              }`}
            >
              <span className={filter === item.id ? "text-primary-foreground" : item.tone}>
                {item.label}
              </span>
              {item.id === "todos" && (
                <span className="text-muted-foreground">
                  {(gamification?.totals.players ?? totalCount).toLocaleString("pt-BR")}
                </span>
              )}
            </button>
          ))}
          <span className="mx-1 hidden h-10 w-px bg-border/70 sm:block" />
          {gamificationLevelFilters.map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={`inline-flex h-12 items-center gap-3 rounded-lg border px-5 text-sm font-semibold transition-colors ${
                filter === item.id
                  ? "border-primary/70 bg-primary text-primary-foreground"
                  : "border-border/60 bg-card/70 hover:border-primary/50 hover:bg-primary/5"
              }`}
            >
              <span className={filter === item.id ? "text-primary-foreground" : item.tone}>
                {item.label}
              </span>
              <span className="text-muted-foreground">
                {(levelCounts.get(item.level) ?? 0).toLocaleString("pt-BR")}
              </span>
            </button>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome, ID ou telefone"
              className="h-14 rounded-xl bg-background/70 pl-11 text-base"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={dateField}
              onValueChange={(v) => setDateField(v as "created_at" | "ftd_em")}
            >
              <SelectTrigger className="h-11 w-[170px] bg-background/70">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ftd_em">FTD (1º depósito)</SelectItem>
                <SelectItem value="created_at">Cadastro</SelectItem>
              </SelectContent>
            </Select>
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-11 gap-2">
                  <CalendarIcon className="h-4 w-4" />
                  {hasDateRange && dateRange?.from
                    ? dateRange.to && dateRange.to.toDateString() !== dateRange.from.toDateString()
                      ? `${fmtBr(dateRange.from)} - ${fmtBr(dateRange.to)}`
                      : fmtBr(dateRange.from)
                    : "Selecionar período"}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-0 pointer-events-auto">
                <div className="grid grid-cols-2 gap-2 border-b p-3">
                  {[
                    { label: "Hoje", days: 0 },
                    { label: "7 dias", days: 6 },
                    { label: "30 dias", days: 29 },
                    { label: "90 dias", days: 89 },
                  ].map((preset) => (
                    <Button
                      key={preset.label}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const to = new Date();
                        const from = new Date(Date.now() - preset.days * 86400000);
                        setDateRange({ from, to });
                        setDateOpen(false);
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={setDateRange}
                  numberOfMonths={2}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            {hasDateRange && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDateRange(undefined)}
                className="h-11 gap-1"
              >
                <X className="h-3.5 w-3.5" />
                Limpar
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <button className="text-sm font-semibold text-primary">
            o que significa cada categoria? →
          </button>
          <div className="flex flex-wrap gap-2">
            {filters
              .filter((item) => !["todos", "ativo"].includes(item.id))
              .map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    filter === f.id
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  {f.label}
                </button>
              ))}
          </div>
        </div>

        <Card className="border-border/50 bg-card/50">
          <CardContent className="space-y-2 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
              Alertas operacionais
            </div>
            <div className="flex flex-wrap gap-1.5">
              {alertFilters.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                    filter === f.id
                      ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                      : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              {[
                ["aguardando_conversao", "Aguardando conversão"],
                ["convertido", "Converteu"],
                ["nao_convertido", "Não converteu"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                    filter === id
                      ? "border-sky-400/60 bg-sky-400/15 text-sky-300"
                      : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      {isPendingFilter && (
        <Card className="border-border/50 bg-card/60 backdrop-blur overflow-hidden">
          <div className="border-b border-border/40 p-4">
            <div className="text-sm font-medium">Aguardando conversão</div>
            <div className="text-xs text-muted-foreground">
              Leads contatados nos últimos 5 dias sem desfecho. Marque "Converteu" ou "Não
              converteu" para tirar da fila.
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/60">
                  <TableHead>Lead</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead>Alerta original</TableHead>
                  <TableHead>Enviado</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-muted-foreground text-sm"
                    >
                      Carregando…
                    </TableCell>
                  </TableRow>
                )}
                {!pendingLoading && (pendingData?.rows ?? []).length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-10 text-muted-foreground text-sm"
                    >
                      Nenhum lead aguardando conversão.
                    </TableCell>
                  </TableRow>
                )}
                {(pendingData?.rows ?? []).map((row) => (
                  <TableRow
                    key={`${row.player_id}:${row.alerta_tipo}`}
                    className="border-border/40 hover:bg-muted/30"
                  >
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setHistoryPlayer({ id: row.player_id, nome: row.nome })}
                        className="font-medium text-left hover:text-primary"
                      >
                        {row.nome}
                      </button>
                      {row.converted_auto && (
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                          depositou depois do contato
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{row.telefone ?? "—"}</div>
                      <div className="text-muted-foreground">{row.email ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="border-amber-400/40 text-amber-300 text-[10px]"
                      >
                        {row.alerta_tipo}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {timeAgo(row.sent_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1.5">
                        <button
                          type="button"
                          title="Enviar mensagem no WhatsApp"
                          onClick={() => openWaFromRow(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                        >
                          <MessageCircle className="h-3 w-3" />
                          Mensagem
                        </button>
                        <button
                          onClick={() => handleMarkOutcome(row, true)}
                          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                        >
                          Converteu
                        </button>
                        <button
                          onClick={() => handleMarkOutcome(row, false)}
                          className="rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-border"
                        >
                          Não converteu
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {isOutcomeFilter && (
        <Card className="border-border/50 bg-card/60 backdrop-blur overflow-hidden">
          <div className="border-b border-border/40 p-4">
            <div className="text-sm font-medium">
              {isConvertedFilter ? "Leads convertidos" : "Leads não convertidos"}
            </div>
            <div className="text-xs text-muted-foreground">
              Desfechos marcados nos últimos 30 dias.
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/60">
                  <TableHead>Lead</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead>Alerta original</TableHead>
                  <TableHead>Marcado</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(isConvertedFilter ? convertedLoading : notConvertedLoading) && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-muted-foreground text-sm"
                    >
                      Carregando…
                    </TableCell>
                  </TableRow>
                )}
                {(() => {
                  const rows: OutcomeRow[] =
                    (isConvertedFilter ? convertedData?.rows : notConvertedData?.rows) ?? [];
                  const loading = isConvertedFilter ? convertedLoading : notConvertedLoading;
                  if (!loading && rows.length === 0) {
                    return (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center py-10 text-muted-foreground text-sm"
                        >
                          {isConvertedFilter
                            ? "Nenhum lead convertido ainda."
                            : "Nenhum lead marcado como não convertido."}
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return rows.map((row) => (
                    <TableRow
                      key={`${row.player_id}:${row.alerta_tipo}`}
                      className="border-border/40 hover:bg-muted/30"
                    >
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setHistoryPlayer({ id: row.player_id, nome: row.nome })}
                          className="font-medium text-left hover:text-primary"
                        >
                          {row.nome}
                        </button>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{row.telefone ?? "—"}</div>
                        <div className="text-muted-foreground">{row.email ?? "—"}</div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${isConvertedFilter ? "border-emerald-400/40 text-emerald-300" : "border-rose-400/40 text-rose-300"}`}
                        >
                          {row.alerta_tipo}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(row.outcome_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          title="Enviar mensagem no WhatsApp"
                          onClick={() => openWaFromRow(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                        >
                          <MessageCircle className="h-3 w-3" />
                          Mensagem
                        </button>
                      </TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {!isPendingFilter && !isOutcomeFilter && (
        <Card className="border-border/50 bg-card/60 backdrop-blur">
          <CardContent className="p-3 flex flex-wrap items-center gap-3 text-xs">
            <div className="text-muted-foreground">
              Filtro:{" "}
              <span className="text-foreground font-medium">
                {filters.find((f) => f.id === filter)?.label ??
                  alertFilters.find((f) => f.id === filter)?.label ??
                  filter}
              </span>
            </div>
            <div className="text-muted-foreground">
              Total: <span className="text-foreground font-medium">{filteredCount}</span>
            </div>
            <div className="text-muted-foreground">
              Selecionados: <span className="text-foreground font-medium">{selectedIds.size}</span>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => sendToSmsAudience("selected")}
                disabled={selectedIds.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-40 disabled:pointer-events-none"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                Usar selecionados no SMS
              </button>
              <button
                type="button"
                onClick={copySelectedIds}
                disabled={selectedIds.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-xs hover:border-primary/60 hover:text-primary disabled:opacity-40 disabled:pointer-events-none"
              >
                <Copy className="h-3.5 w-3.5" />
                Copiar IDs selecionados{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>
              <button
                type="button"
                onClick={copyFilterIds}
                disabled={copyingFilter || filteredCount === 0}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-40 disabled:pointer-events-none"
                title="Copia o player_external_id de todos os players desse filtro, prontos pra colar no campo Usuários Alvo da plataforma."
              >
                <Copy className="h-3.5 w-3.5" />
                {copyingFilter ? "Copiando…" : "Copiar IDs do filtro atual"}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {!isPendingFilter && !isOutcomeFilter && (
        <Card className="border-border/50 bg-card/60 backdrop-blur overflow-hidden">
          <div className="overflow-x-auto">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/60">
                  <TableHead className="w-8">
                    <Checkbox
                      checked={paged.length > 0 && paged.every((p) => selectedIds.has(p.id))}
                      onCheckedChange={(v) => {
                        setSelectedIds((cur) => {
                          const next = new Set(cur);
                          if (v) for (const p of paged) next.add(p.id);
                          else for (const p of paged) next.delete(p.id);
                          return next;
                        });
                      }}
                      aria-label="Selecionar página"
                    />
                  </TableHead>
                  <TableHead>Jogador</TableHead>
                  <TableHead>Nível</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Depósitos</TableHead>
                  <TableHead className="text-right">
                    <SortHeader k="total_depositado" label="Total" align="right" />
                  </TableHead>
                  <TableHead>
                    <SortHeader k="ultimo_deposito" label="Último depósito" />
                  </TableHead>
                  <TableHead>
                    <SortHeader k="origem" label="Veio de" />
                  </TableHead>
                  <TableHead className="text-right">Ficha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 9 }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {paged.map((p) => {
                  const extId = (p.player_external_id ?? "").trim();
                  const level = levelBadgeMeta[getPlayerLevel(p, playerGamificationSettings)];
                  const situation =
                    situationBadgeMeta[getPlayerSituation(p, playerGamificationSettings)];
                  const depositsCount = Number(p.deposits_count ?? 0);
                  return (
                    <TableRow key={p.id} className="border-border/40 hover:bg-muted/30">
                      <TableCell className="w-8">
                        <Checkbox
                          checked={selectedIds.has(p.id)}
                          onCheckedChange={(v) => {
                            setSelectedIds((cur) => {
                              const next = new Set(cur);
                              if (v) next.add(p.id);
                              else next.delete(p.id);
                              return next;
                            });
                          }}
                          aria-label={`Selecionar ${p.nome}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {riskDot(p.risco)}
                          <div className="flex flex-col">
                            <Link
                              to="/players/$playerId"
                              params={{ playerId: p.id }}
                              className="font-medium flex items-center gap-1 text-left hover:text-primary"
                              title="Abrir ficha do player"
                            >
                              {p.nome}
                              {p.vip && <Crown className="h-3 w-3 text-amber-400" />}
                              {pendingPlayerIdsAny.has(p.id) && (
                                <span
                                  title="Mensagem enviada — aguardando conversão"
                                  className="ml-1 inline-flex items-center rounded-full border border-sky-400/50 bg-sky-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-sky-300"
                                >
                                  ⏳ aguardando
                                </span>
                              )}
                            </Link>
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              {extId || "sem ID externo"}
                              {extId && (
                                <button
                                  type="button"
                                  title="Copiar ID Push"
                                  onClick={() => copyOneId(extId, p.id)}
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                >
                                  {copiedId === p.id ? (
                                    <Check className="h-3 w-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              )}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={level.className}>
                          {level.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className={`text-sm font-medium ${situation.className}`}>
                          {situation.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {depositsCount.toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {brl(p.total_depositado)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(p.ultimo_deposito ?? p.ftd_em)}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[280px]">
                          <div className="truncate text-sm">{p.expert || p.origem || "—"}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[p.origem, p.tags?.[0]].filter(Boolean).join(" · ") || "sem origem"}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" asChild className="h-8 gap-1.5">
                          <Link to="/players/$playerId" params={{ playerId: p.id }}>
                            <Eye className="h-3.5 w-3.5" />
                            Ficha
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!isLoading && filteredCount === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="text-center py-10 text-muted-foreground text-sm"
                    >
                      Nenhum player encontrado com esses filtros.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {!isPendingFilter && filteredCount > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            Mostrando {paged.length} de {filteredCount} usuários
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Anterior
            </button>
            {pageNumbers[0] > 1 && (
              <>
                <button
                  onClick={() => setPage(1)}
                  className="h-8 w-8 rounded-md border border-border/60 text-xs text-muted-foreground hover:text-foreground hover:border-border"
                >
                  1
                </button>
                {pageNumbers[0] > 2 && (
                  <span className="px-1 text-muted-foreground text-xs">…</span>
                )}
              </>
            )}
            {pageNumbers.map((n) => (
              <button
                key={n}
                onClick={() => setPage(n)}
                className={`h-8 w-8 rounded-md border text-xs transition-colors ${
                  n === currentPage
                    ? "border-primary/60 bg-primary/15 text-primary font-medium"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {n}
              </button>
            ))}
            {pageNumbers[pageNumbers.length - 1] < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1] < totalPages - 1 && (
                  <span className="px-1 text-muted-foreground text-xs">…</span>
                )}
                <button
                  onClick={() => setPage(totalPages)}
                  className="h-8 w-8 rounded-md border border-border/60 text-xs text-muted-foreground hover:text-foreground hover:border-border"
                >
                  {totalPages}
                </button>
              </>
            )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-40 disabled:pointer-events-none"
            >
              Próximo
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {waDialog && (
        <EnviarPeloWhatsAppDialog
          open
          onOpenChange={(v) => {
            if (!v) {
              setWaDialog(null);
              setWaMensagem("");
            }
          }}
          phone={waDialog.player.telefone}
          leadName={waDialog.player.nome}
          mensagem={
            waMensagem
              ? waMensagem
              : waDialog.alerta
                ? whatsappMessageFor(waDialog.alerta, waDialog.player satisfies PlayerLike)
                : nextPrecallCopy({
                    fullName: waDialog.player.nome,
                    brand: tenantBrand ?? "",
                  })
          }
          onSent={async () => {
            // Grava follow-up — assim o lead some do filtro de alerta atual
            const tipo = waDialog.alerta?.tipo ?? (filter as string);
            const pid = waDialog.player.id!;
            // Atualização otimista: já adiciona ao set de "pendentes" pra o
            // lead sumir do chip de alerta no mesmo frame do clique.
            qc.setQueryData<{ keys: string[] } | undefined>(
              ["players-recent-followup-keys"],
              (prev) => {
                const k = `${pid}:${tipo}`;
                const cur = prev?.keys ?? [];
                return cur.includes(k) ? prev! : { keys: [...cur, k] };
              },
            );
            await supabase.from("lead_followups").insert({
              player_id: pid,
              alerta_tipo: tipo,
              acao: "whatsapp",
            });
            qc.invalidateQueries({ queryKey: ["players-alerts"] });
            qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
            qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
            qc.invalidateQueries({ queryKey: ["players-page"] });
            qc.invalidateQueries({ queryKey: ["alertas"] });
          }}
        />
      )}
      <PlayerContactHistoryDialog
        open={!!historyPlayer}
        onOpenChange={(v) => {
          if (!v) setHistoryPlayer(null);
        }}
        playerId={historyPlayer?.id ?? null}
        playerName={historyPlayer?.nome}
      />
    </div>
  );
}
