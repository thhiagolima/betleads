import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { POLL_INTERVALS } from "@/hooks/use-updated-ago";
import { useIsMobile } from "@/hooks/use-mobile";
import { Input } from "@/components/ui/input";
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
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Copy,
  Check,
  Calendar as CalendarIcon,
  X,
  MessageSquareText,
  MessageCircle,
  History,
  Loader2,
  MoreHorizontal,
  SlidersHorizontal,
  Download,
  Users,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { LevelBadge } from "@/components/players/level-badge";
import { SituationText } from "@/components/players/situation-text";
import { SegmentedFilter } from "@/components/players/segmented-filter";
import { alertTypeLabel } from "@/components/players/player-labels";
import { copyToClipboard, openCampaignWithAudience } from "@/components/players/campaign-audience";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { cn } from "@/lib/utils";
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
  getPlayersFilteredPlayerIds,
  getPlayersFilteredExport,
  type PlayerRow,
} from "@/lib/players-list.functions";
import { LEVEL_LABEL, levelForTotal } from "@/lib/player-level";
import { playerSituation, SITUATION_LABEL, type PlayerSituation } from "@/lib/player-situation";
import { playersCsv } from "@/lib/players-csv";
import { getPlayerFilterFacets } from "@/lib/player-filter-facets.functions";
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
type AdvancedFilterDraft = {
  filter: string;
  behaviorFilters: string[];
  behaviorOperator: "and" | "or";
  situation: PlayerSituation | null;
  level: PaidLevelSlug | null;
  search: string;
  dateField: "created_at" | "ftd_em";
  dateRange: DateRange | undefined;
};
type PlayerGamificationSettings = {
  thresholds: Record<PaidLevelSlug, number>;
  coolingAfterDays: number;
  sleepingAfterDays: number;
  vipMinLevel?: PaidLevelSlug;
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

type PlayersView = "lista" | "acompanhamento";
type FollowupQueue = "aguardando_conversao" | "convertido" | "nao_convertido";

const VIEW_TABS = [
  { value: "lista", label: "Lista" },
  { value: "acompanhamento", label: "Acompanhamento" },
] as const;

const FOLLOWUP_QUEUES: ReadonlyArray<{ value: FollowupQueue; label: string }> = [
  { value: "aguardando_conversao", label: "Aguardando conversão" },
  { value: "convertido", label: "Converteu" },
  { value: "nao_convertido", label: "Não converteu" },
];

function viewFromHash(hash: string): PlayersView {
  return hash.replace(/^#/, "") === "acompanhamento" ? "acompanhamento" : "lista";
}

const filters = [
  { id: "todos", label: "Todos" },
  { id: "ativo", label: "Já depositaram" },
  { id: "cashback_pago_hoje", label: "Cashback pago hoje" },
  { id: "recorrentes", label: "Ativos nos últimos 4 dias" },
  { id: "risco_5_7", label: "5 a 7 dias sem atividade" },
  { id: "em_risco", label: "7+ dias sem atividade" },
  { id: "vip", label: "VIP" },
  { id: "vip_em_risco", label: "VIP sem atividade há 7+ dias" },
  { id: "quase_vip", label: "Faltando pouco pro VIP" },
  { id: "leads_quentes", label: "Ativos e depositaram na semana" },
  { id: "com_saldo", label: "Saldo disponível (ativos em 60 dias)" },
  { id: "deposito_hoje", label: "Depositaram hoje" },
  { id: "ftd_hoje", label: "FTD hoje" },
  { id: "nao_converteram", label: "Sem FTD registrado" },
  { id: "risco_inicial", label: "7 a 14 dias sem atividade" },
  { id: "risco_moderado", label: "15 a 24 dias sem atividade" },
  { id: "risco_alto", label: "25 a 34 dias sem atividade" },
  { id: "quase_perdido", label: "35 a 44 dias sem atividade" },
  { id: "recuperacao_dificil", label: "45 a 59 dias sem atividade" },
  { id: "perdidos", label: "60+ dias sem atividade" },
];

const advancedFilterGroups = [
  {
    title: "Atividade e depósitos",
    ids: [
      "recorrentes",
      "deposito_hoje",
      "ftd_hoje",
      "cashback_pago_hoje",
      "leads_quentes",
      "com_saldo",
    ],
  },
  {
    title: "Valor e risco",
    ids: [
      "vip",
      "quase_vip",
      "vip_em_risco",
      "risco_5_7",
      "em_risco",
      "risco_inicial",
      "risco_moderado",
      "risco_alto",
      "quase_perdido",
      "recuperacao_dificil",
      "perdidos",
    ],
  },
] as const;
const BEHAVIOR_FILTER_IDS = new Set(
  filters.filter((item) => item.id !== "todos").map((item) => item.id),
);

// Sinais de oportunidade em tempo real (mesma lógica de /alertas — quando a
// gente manda mensagem o jogador sai daqui).
const alertFilters: { id: AlertaTipo; label: string }[] = [
  { id: "abandono_vip", label: "VIP recuperável" },
  { id: "vip_sem_atividade", label: "VIP esfriando" },
  { id: "queda_depositos", label: "Queda de depósitos" },
  { id: "lead_quente_esfriando", label: "Quente esfriando" },
  { id: "proximo_vip", label: "Quase VIP" },
  { id: "alto_potencial", label: "Alto potencial" },
  { id: "player_reativado", label: "Reativado" },
  { id: "sequencia_depositos", label: "Em sequência" },
  { id: "saldo_parado", label: "Saldo parado" },
  { id: "login_sem_deposito", label: "Logando sem depositar" },
  { id: "frequencia_caindo", label: "Frequência caindo" },
];
const ALERT_FILTER_IDS = new Set<string>(alertFilters.map((a) => a.id));

function filterDisplayLabel(filterId: string) {
  return (
    filters.find((item) => item.id === filterId)?.label ??
    alertFilters.find((item) => item.id === filterId)?.label ??
    alertTypeLabel(filterId)
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const SITUATIONS: PlayerSituation[] = ["active", "cooling", "sleeping", "no_deposit"];
const SITUATION_FILTER_LABEL: Record<PlayerSituation, string> = {
  active: "Ativos",
  cooling: "Esfriando",
  sleeping: "Dormindo",
  no_deposit: "Sem depósito",
};
const PAID_LEVELS: PaidLevelSlug[] = ["bronze", "silver", "gold", "diamond", "black"];

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

const RISK_LABEL: Record<string, string> = { alto: "alto", medio: "médio", baixo: "baixo" };

function RiskDot({ risk }: { risk: string | null | undefined }) {
  const value = risk ?? "baixo";
  const color = value === "alto" ? "bg-danger" : value === "medio" ? "bg-warning" : "bg-success";
  const label = `Risco ${RISK_LABEL[value] ?? value}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}

function getPlayerLevel(
  player: Player,
  settings: PlayerGamificationSettings = DEFAULT_PLAYER_GAMIFICATION,
): LevelSlug {
  return levelForTotal(player.total_depositado, settings.thresholds);
}

function getPlayerSituation(
  player: Player,
  settings: PlayerGamificationSettings = DEFAULT_PLAYER_GAMIFICATION,
): PlayerSituation {
  return playerSituation(player, settings);
}

type SortKey =
  | "ultimo_login"
  | "ultimo_jogo"
  | "ultimo_deposito"
  | "total_depositado"
  | "total_sacado"
  | "lucro"
  | "saldo"
  | "status"
  | "origem";

const MOBILE_SORTS: ReadonlyArray<{ value: string; label: string; key: SortKey | null }> = [
  { value: "padrao", label: "Ordem padrão", key: null },
  { value: "total_depositado", label: "Maior total depositado", key: "total_depositado" },
  { value: "ultimo_deposito", label: "Último depósito mais recente", key: "ultimo_deposito" },
  { value: "ultimo_login", label: "Último acesso mais recente", key: "ultimo_login" },
];

function PlayersPage() {
  const navigate = useNavigate();
  const routeSearch = Route.useSearch();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const linkedPlayerId = routeSearch.id ?? routeSearch.focus ?? null;
  const isDetailRoute =
    pathname.replace(/\/+$/, "") !== "/players" && pathname.startsWith("/players/");
  const [filter, setFilter] = useState("todos");
  const [behaviorFilters, setBehaviorFilters] = useState<string[]>([]);
  const [behaviorOperator, setBehaviorOperator] = useState<"and" | "or">("and");
  const [selectedSituation, setSelectedSituation] = useState<PlayerSituation | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<PaidLevelSlug | null>(null);
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
  // Linhas selecionadas de qualquer página (a seleção sobrevive à troca de página).
  const selectedRowCache = useRef(new Map<string, Player>());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [advancedDraft, setAdvancedDraft] = useState<AdvancedFilterDraft | null>(null);
  const isMobile = useIsMobile();
  // Busca visível na barra (C-05): aplica direto, com debounce, sem passar pela gaveta.
  const [searchInput, setSearchInput] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => window.clearTimeout(handle);
  }, [searchInput]);
  // Lista principal x filas de acompanhamento (C-25), sincronizado com o hash.
  const hash = useLocation({ select: (location) => location.hash });
  const view = viewFromHash(hash);
  const [followupQueue, setFollowupQueue] = useState<FollowupQueue>("aguardando_conversao");
  const [selectionMode, setSelectionMode] = useState(false);

  function setView(next: PlayersView) {
    void navigate({
      to: "/players",
      search: { id: undefined, focus: undefined },
      hash: next === "lista" ? "" : next,
    });
  }

  useEffect(() => {
    if (!linkedPlayerId || isDetailRoute) return;

    void navigate({
      to: "/players/$playerId",
      params: { playerId: linkedPlayerId },
      search: { id: undefined, focus: undefined },
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
  // Só o que fica escondido na gaveta (situação, nível e busca já aparecem na barra).
  const advancedFilterCount =
    Number(filter !== "todos") + behaviorFilters.length + Number(hasDateRange);
  const sheetDraft: AdvancedFilterDraft = advancedDraft ?? {
    filter,
    behaviorFilters,
    behaviorOperator,
    situation: selectedSituation,
    level: selectedLevel,
    search,
    dateField,
    dateRange,
  };
  const draftHasDateRange = Boolean(sheetDraft.dateRange?.from);
  const draftDateFromIso = sheetDraft.dateRange?.from
    ? parseBrtDayStart(
        `${sheetDraft.dateRange.from.getFullYear()}-${String(sheetDraft.dateRange.from.getMonth() + 1).padStart(2, "0")}-${String(sheetDraft.dateRange.from.getDate()).padStart(2, "0")}`,
      ).toISOString()
    : null;
  const draftDateToIso =
    (sheetDraft.dateRange?.to ?? sheetDraft.dateRange?.from)
      ? parseBrtDayEnd(
          (() => {
            const d = sheetDraft.dateRange!.to ?? sheetDraft.dateRange!.from!;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          })(),
        ).toISOString()
      : null;
  const draftFilterCount =
    Number(sheetDraft.filter !== "todos") +
    sheetDraft.behaviorFilters.length +
    Number(Boolean(sheetDraft.situation)) +
    Number(Boolean(sheetDraft.level)) +
    Number(draftHasDateRange);

  function fmtBr(d: Date) {
    return d.toLocaleDateString("pt-BR");
  }

  const isAlertFilter = ALERT_FILTER_IDS.has(filter);
  const isQuedaFilter = filter === "queda_depositos";
  const isLqeFilter = filter === "lead_quente_esfriando";
  const isServerAlertFilter = SERVER_ALERT_FILTERS.has(filter);
  const inFollowup = view === "acompanhamento";
  const isPendingFilter = inFollowup && followupQueue === "aguardando_conversao";
  const isConvertedFilter = inFollowup && followupQueue === "convertido";
  const isNotConvertedFilter = inFollowup && followupQueue === "nao_convertido";
  const isOutcomeFilter = isConvertedFilter || isNotConvertedFilter;

  const fetchRecentFollowupKeys = useServerFn(listRecentFollowupKeys);
  const { data: recentFollowupData } = useQuery({
    queryKey: ["players-recent-followup-keys"],
    queryFn: () => fetchRecentFollowupKeys(),
    // Sempre buscar — usado para o selo "Aguardando" em qualquer linha da lista.
    enabled: true,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const recentFollowupKeySet = useMemo(
    () => new Set(recentFollowupData?.keys ?? []),
    [recentFollowupData],
  );
  // Player IDs com QUALQUER followup pendente — pro selo "Aguardando" na linha.
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
      toast.success(converted ? "Marcado como convertido." : "Marcado como não convertido.");
      qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
      qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
      qc.invalidateQueries({ queryKey: ["players-alerts"] });
      qc.invalidateQueries({ queryKey: ["players-converted"] });
      qc.invalidateQueries({ queryKey: ["players-not-converted"] });
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Não foi possível registrar o desfecho"));
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
      toast.error("Jogador sem telefone cadastrado.");
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

  // REP-05: players/deposits saíram da publicação Realtime (escrita alta). A
  // tabela agora faz polling de 60 s (ver query "players-page"). Fica só
  // lead_followups em Realtime: escrita baixa, feita pelo operador, e as
  // listas de follow-up precisam refletir na hora.
  useEffect(() => {
    const channel = supabase
      .channel("players-realtime")
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
  const canEstimateDraft =
    sheetDraft.filter === "todos" || BEHAVIOR_FILTER_IDS.has(sheetDraft.filter);
  const { data: draftEstimate, isFetching: isFetchingDraftEstimate } = useQuery({
    queryKey: [
      "players-draft-estimate",
      advancedFiltersOpen,
      sheetDraft.filter,
      sheetDraft.behaviorFilters,
      sheetDraft.behaviorOperator,
      sheetDraft.situation,
      sheetDraft.level,
      sheetDraft.search,
      sheetDraft.dateField,
      draftDateFromIso,
      draftDateToIso,
    ],
    queryFn: () =>
      fetchPlayersPage({
        data: {
          page: 1,
          pageSize: 1,
          filter: sheetDraft.filter,
          behaviorFilters: sheetDraft.behaviorFilters,
          behaviorOperator: sheetDraft.behaviorOperator,
          gamificationStatus: sheetDraft.situation,
          gamificationLevel: sheetDraft.level,
          search: sheetDraft.search,
          sortKey: "ultimo_login",
          sortDir: "desc",
          idsIn: null,
          dateField: draftDateFromIso && draftDateToIso ? sheetDraft.dateField : null,
          dateFrom: draftDateFromIso,
          dateTo: draftDateToIso,
        },
      }),
    enabled: advancedFiltersOpen && canEstimateDraft,
    staleTime: 5_000,
  });
  const fetchPlayerFilterFacets = useServerFn(getPlayerFilterFacets);
  const { data: playerFilterFacets, isFetching: isFetchingPlayerFilterFacets } = useQuery({
    queryKey: [
      "players-filter-facets",
      sheetDraft.behaviorFilters,
      sheetDraft.behaviorOperator,
      sheetDraft.situation,
      sheetDraft.level,
      sheetDraft.search,
      sheetDraft.dateField,
      draftDateFromIso,
      draftDateToIso,
    ],
    queryFn: () =>
      fetchPlayerFilterFacets({
        data: {
          behaviorFilters: sheetDraft.behaviorFilters,
          behaviorOperator: sheetDraft.behaviorOperator,
          gamificationStatus: sheetDraft.situation,
          gamificationLevel: sheetDraft.level,
          search: sheetDraft.search,
          dateField: draftDateFromIso && draftDateToIso ? sheetDraft.dateField : null,
          dateFrom: draftDateFromIso,
          dateTo: draftDateToIso,
        },
      }),
    enabled: advancedFiltersOpen,
    placeholderData: (previous) => previous,
    staleTime: 5_000,
  });
  const {
    data: pageData,
    isLoading,
    isFetching: isFetchingPlayers,
    isPlaceholderData,
  } = useQuery({
    queryKey: [
      "players-page",
      page,
      pageSize,
      filter,
      behaviorFilters,
      behaviorOperator,
      selectedSituation,
      selectedLevel,
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
          behaviorFilters,
          behaviorOperator,
          gamificationStatus: selectedSituation,
          gamificationLevel: selectedLevel,
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
    staleTime: 60_000,
    // Substitui o Realtime de players/deposits (REP-05): mesma cadência
    // efetiva de antes (o Realtime já era limitado a 1 refresh a cada 30 s),
    // sem depender do WAL das tabelas de alta escrita.
    refetchInterval: POLL_INTERVALS.stats,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
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
  }, [filter, selectedSituation, selectedLevel, search, dateField, dateFromIso, dateToIso]);

  // Limpa seleção quando muda filtro/busca — evita copiar IDs de outro conjunto.
  useEffect(() => {
    setSelectedIds(new Set());
    selectedRowCache.current.clear();
  }, [filter, behaviorFilters, selectedSituation, selectedLevel, search, dateFromIso, dateToIso]);

  function selectedRows(): Player[] {
    const visible = new Map(
      (isLocalAlertFilter ? (localAlertData?.rows ?? []) : paged).map((p) => [p.id, p]),
    );
    return Array.from(selectedIds)
      .map((id) => visible.get(id) ?? selectedRowCache.current.get(id))
      .filter((p): p is Player => Boolean(p));
  }

  // Linhas / totais — vêm do path local (4 alertas) ou da página do servidor.
  const paged: Player[] = isLocalAlertFilter ? (localPagedSlice?.page ?? []) : (data ?? []);
  const filteredCount = isLocalAlertFilter ? (localPagedSlice?.total ?? 0) : totalCount;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  const currentPage = Math.min(page, totalPages);

  const SortHeader = ({ k, label, align }: { k: SortKey; label: string; align?: "right" }) => {
    const active = sort?.key === k;
    const Icon = !active ? ArrowUpDown : sort!.dir === "desc" ? ArrowDown : ArrowUp;
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        aria-label={`Ordenar por ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
          active ? "text-foreground" : ""
        } ${align === "right" ? "w-full justify-end" : ""}`}
      >
        {label}
        <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
      </button>
    );
  };

  // C-06: exporta o filtro inteiro, não só a página visível.
  const fetchFilteredExport = useServerFn(getPlayersFilteredExport);
  const [exportingCsv, setExportingCsv] = useState(false);
  const exportCsv = async () => {
    setExportingCsv(true);
    try {
      let rows: Player[] | Awaited<ReturnType<typeof fetchFilteredExport>>["rows"];
      let truncatedNote = "";
      if (isLocalAlertFilter) {
        // Os 4 alertas calculados no navegador já têm a lista completa em memória.
        rows = localAlertData?.rows ?? [];
      } else {
        const res = await fetchFilteredExport({
          data: {
            filter,
            behaviorFilters,
            behaviorOperator,
            gamificationStatus: selectedSituation,
            gamificationLevel: selectedLevel,
            search,
            idsIn: alertIdsForFilter,
            dateField: hasDateRange ? dateField : null,
            dateFrom: dateFromIso,
            dateTo: dateToIso,
            sortKey: sort?.key ?? defaultSortKey(filter),
            sortDir: sort?.dir ?? "desc",
          },
        });
        rows = res.rows;
        if (res.truncated) {
          truncatedNote = ` Limite de ${res.rows.length.toLocaleString("pt-BR")} de ${res.total.toLocaleString("pt-BR")} jogadores atingido; refine o filtro para exportar o resto.`;
        }
      }
      if (rows.length === 0) {
        toast.error("Nenhum jogador para exportar nesse filtro.");
        return;
      }
      const csv = playersCsv(
        rows,
        gamification?.settings?.thresholds ?? DEFAULT_PLAYER_GAMIFICATION.thresholds,
      );
      const blob = new Blob(["﻿" + csv], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `jogadores_${filter}_${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const message = `${rows.length.toLocaleString("pt-BR")} jogadores exportados.${truncatedNote}`;
      if (truncatedNote) toast.warning(message);
      else toast.success(message);
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Não foi possível exportar o CSV"));
    } finally {
      setExportingCsv(false);
    }
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

  async function copyOneId(externalId: string | null | undefined, playerId?: string) {
    const v = (externalId ?? "").trim();
    if (!v) {
      toast.error("Este jogador não tem ID da plataforma.");
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
    // IDs externos dos selecionados (de qualquer página já vista).
    const ids = formatIds(selectedRows().map((p) => p.player_external_id));
    const missing = selectedIds.size - ids.length;
    if (ids.length === 0) {
      toast.error("Nenhum ID da plataforma entre os selecionados.");
      return;
    }
    await copyToClipboard(ids.join("\n"));
    toast.success(
      missing > 0
        ? `${ids.length} IDs copiados. ${missing} jogadores sem ID da plataforma ficaram de fora.`
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
          toast.error("Nenhum ID da plataforma neste filtro.");
          return;
        }
        await copyToClipboard(ids.join("\n"));
        toast.success(
          missing > 0
            ? `${ids.length} IDs copiados. ${missing} jogadores sem ID da plataforma ficaram de fora.`
            : `${ids.length} IDs copiados para a área de transferência.`,
        );
        return;
      }
      // Caminho servidor — busca TODOS os IDs do filtro (não só a página).
      const res = await fetchFilteredExternalIds({
        data: {
          filter,
          behaviorFilters,
          behaviorOperator,
          gamificationStatus: selectedSituation,
          gamificationLevel: selectedLevel,
          search,
          idsIn: alertIdsForFilter,
          dateField: hasDateRange ? dateField : null,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        },
      });
      if (res.ids.length === 0) {
        toast.error("Nenhum ID da plataforma neste filtro.");
        return;
      }
      await copyToClipboard(res.ids.join("\n"));
      toast.success(
        res.missing > 0
          ? `${res.ids.length} IDs copiados. ${res.missing} jogadores sem ID da plataforma ficaram de fora.`
          : `${res.ids.length} IDs copiados para a área de transferência.`,
      );
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Não foi possível copiar os IDs"));
    } finally {
      setCopyingFilter(false);
    }
  }

  const fetchFilteredPlayerIds = useServerFn(getPlayersFilteredPlayerIds);
  const [buildingAudience, setBuildingAudience] = useState(false);

  const selectedFilterLabel =
    [
      filter === "todos" ? null : filterDisplayLabel(filter),
      ...behaviorFilters.map(filterDisplayLabel),
      selectedSituation ? SITUATION_LABEL[selectedSituation] : null,
      selectedLevel ? LEVEL_LABEL[selectedLevel] : null,
      search ? `busca "${search}"` : null,
    ]
      .filter(Boolean)
      .join(" + ") || "Todos os jogadores";

  const levelCounts = useMemo(() => {
    const map = new Map<LevelSlug, number>();
    for (const level of gamification?.levels ?? []) map.set(level.slug, level.count);
    return map;
  }, [gamification]);
  const situationCounts = useMemo(() => {
    if (!gamification) return null;
    const totalsKey: Record<PlayerSituation, keyof typeof gamification.totals> = {
      active: "activeCount",
      cooling: "coolingCount",
      sleeping: "sleepingCount",
      no_deposit: "noDepositCount",
    };
    return Object.fromEntries(
      SITUATIONS.map((status) => [
        status,
        selectedLevel
          ? (gamification.segmentCounts?.[status]?.[selectedLevel] ?? 0)
          : (gamification.totals?.[totalsKey[status]] ?? 0),
      ]),
    ) as Record<PlayerSituation, number>;
  }, [gamification, selectedLevel]);

  const contextualLevelCounts = useMemo(() => {
    if (!gamification) return null;
    const map = new Map<LevelSlug, number>();
    for (const level of PAID_LEVELS) {
      map.set(
        level,
        selectedSituation
          ? (gamification.segmentCounts?.[selectedSituation]?.[level] ?? 0)
          : (levelCounts.get(level) ?? 0),
      );
    }
    return map;
  }, [gamification, levelCounts, selectedSituation]);

  function draftStatusCount(status: PlayerSituation) {
    return sheetDraft.level
      ? (gamification?.segmentCounts?.[status]?.[sheetDraft.level] ?? 0)
      : (gamification?.totals?.[
          status === "active"
            ? "activeCount"
            : status === "cooling"
              ? "coolingCount"
              : status === "sleeping"
                ? "sleepingCount"
                : "noDepositCount"
        ] ?? 0);
  }

  function draftLevelCount(level: PaidLevelSlug) {
    return sheetDraft.situation
      ? (gamification?.segmentCounts?.[sheetDraft.situation]?.[level] ?? 0)
      : (levelCounts.get(level) ?? 0);
  }

  function selectSituation(situation: PlayerSituation | null) {
    setSelectedSituation(situation);
    // "Sem depósito" não combina com nível pago.
    if (situation === "no_deposit") setSelectedLevel(null);
  }

  function selectLevel(level: PaidLevelSlug | null) {
    setSelectedLevel(level);
    if (level && selectedSituation === "no_deposit") setSelectedSituation(null);
  }

  function clearAllFilters() {
    setFilter("todos");
    setBehaviorFilters([]);
    setBehaviorOperator("and");
    setSelectedSituation(null);
    setSelectedLevel(null);
    setSearchInput("");
    setSearch("");
    setDateRange(undefined);
  }

  function openAdvancedFilters() {
    setAdvancedDraft({
      filter,
      behaviorFilters,
      behaviorOperator,
      situation: selectedSituation,
      level: selectedLevel,
      search,
      dateField,
      dateRange,
    });
    setAdvancedFiltersOpen(true);
  }

  function closeAdvancedFilters() {
    setAdvancedFiltersOpen(false);
    setAdvancedDraft(null);
  }

  function selectAdvancedBehavior(nextFilter: string) {
    setAdvancedDraft((current) => {
      if (!current) return current;
      const selected = current.behaviorFilters.includes(nextFilter);
      return {
        ...current,
        filter: "todos",
        behaviorFilters: selected
          ? current.behaviorFilters.filter((value) => value !== nextFilter)
          : [...current.behaviorFilters, nextFilter],
      };
    });
  }

  function selectAdvancedFilter(nextFilter: string) {
    if (BEHAVIOR_FILTER_IDS.has(nextFilter)) return selectAdvancedBehavior(nextFilter);
    setAdvancedDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        filter: current.filter === nextFilter ? "todos" : nextFilter,
        behaviorFilters: [],
      };
    });
  }

  function selectDraftSituation(situation: PlayerSituation) {
    setAdvancedDraft((current) => {
      if (!current) return current;
      const nextSituation = current.situation === situation ? null : situation;
      return {
        ...current,
        situation: nextSituation,
        level: nextSituation === "no_deposit" ? null : current.level,
      };
    });
  }

  function selectDraftLevel(level: PaidLevelSlug) {
    setAdvancedDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        level: current.level === level ? null : level,
        situation: current.situation === "no_deposit" ? null : current.situation,
      };
    });
  }

  function clearAdvancedDraft() {
    setAdvancedDraft((current) =>
      current
        ? {
            ...current,
            filter: "todos",
            behaviorFilters: [],
            behaviorOperator: "and",
            situation: null,
            level: null,
            dateRange: undefined,
          }
        : current,
    );
  }

  function applyAdvancedFilters() {
    if (!advancedDraft) return closeAdvancedFilters();
    setFilter(advancedDraft.filter);
    setBehaviorFilters(advancedDraft.behaviorFilters);
    setBehaviorOperator(advancedDraft.behaviorOperator);
    setSelectedSituation(advancedDraft.situation);
    setSelectedLevel(advancedDraft.level);
    setDateField(advancedDraft.dateField);
    setDateRange(advancedDraft.dateRange);
    closeAdvancedFilters();
  }

  const playerGamificationSettings: PlayerGamificationSettings =
    gamification?.settings ?? DEFAULT_PLAYER_GAMIFICATION;

  async function sendToSmsAudience(mode: "selected" | "filter") {
    setBuildingAudience(true);
    try {
      if (mode === "selected") {
        await openCampaignWithAudience({ playerIds: Array.from(selectedIds) });
        return;
      }

      if (isLocalAlertFilter) {
        const rows = localAlertData?.rows ?? [];
        await openCampaignWithAudience({ playerIds: rows.map((p) => p.id) });
        return;
      }

      const res = await fetchFilteredPlayerIds({
        data: {
          filter,
          behaviorFilters,
          behaviorOperator,
          gamificationStatus: selectedSituation,
          gamificationLevel: selectedLevel,
          search,
          idsIn: alertIdsForFilter,
          dateField: hasDateRange ? dateField : null,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        },
      });
      await openCampaignWithAudience({
        playerIds: res.ids,
        truncatedFrom: res.truncated ? res.total : undefined,
      });
    } catch (e: unknown) {
      toast.error(getErrorMessage(e, "Não foi possível montar o público"));
    } finally {
      setBuildingAudience(false);
    }
  }

  if (isDetailRoute) return <Outlet />;

  const vipMinLevel = playerGamificationSettings.vipMinLevel ?? "diamond";
  const vipLegend = `${LEVEL_LABEL[vipMinLevel]}${vipMinLevel === "black" ? "" : " ou acima"}, sem depositar há ${playerGamificationSettings.coolingAfterDays}+ dias`;
  const depositorsShare =
    gamification?.totals.players && gamification.totals.players > 0
      ? `${Math.round((gamification.totals.depositors / gamification.totals.players) * 100)}% da base`
      : undefined;
  const pageStart = filteredCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const pageEnd = Math.min(filteredCount, currentPage * pageSize);
  const allPageSelected = paged.length > 0 && paged.every((p) => selectedIds.has(p.id));
  const mobileSortValue =
    MOBILE_SORTS.find((item) => item.key && sort?.key === item.key && sort.dir === "desc")?.value ??
    "padrao";
  const drawerChips: Array<{ key: string; label: string; onRemove: () => void }> = [
    ...(filter !== "todos"
      ? [
          {
            key: `f:${filter}`,
            label: filterDisplayLabel(filter),
            onRemove: () => setFilter("todos"),
          },
        ]
      : []),
    ...behaviorFilters.map((id) => ({
      key: `b:${id}`,
      label: filterDisplayLabel(id),
      onRemove: () => setBehaviorFilters((current) => current.filter((value) => value !== id)),
    })),
    ...(hasDateRange && dateRange?.from
      ? [
          {
            key: "date",
            label: `${dateField === "ftd_em" ? "FTD" : "Cadastro"}: ${
              dateRange.to && dateRange.to.toDateString() !== dateRange.from.toDateString()
                ? `${fmtBr(dateRange.from)} a ${fmtBr(dateRange.to)}`
                : fmtBr(dateRange.from)
            }`,
            onRemove: () => setDateRange(undefined),
          },
        ]
      : []),
  ];
  const hasAnyFilter =
    drawerChips.length > 0 || Boolean(selectedSituation || selectedLevel || searchInput.trim());

  function toggleSelected(player: Player, checked: boolean) {
    if (checked) selectedRowCache.current.set(player.id, player);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(player.id);
      else next.delete(player.id);
      return next;
    });
  }

  function togglePage(checked: boolean) {
    if (checked) for (const p of paged) selectedRowCache.current.set(p.id, p);
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const p of paged) {
        if (checked) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectionMode(false);
  }

  const followupRows: Array<PendingConversionRow | OutcomeRow> =
    (isPendingFilter
      ? pendingData?.rows
      : isConvertedFilter
        ? convertedData?.rows
        : notConvertedData?.rows) ?? [];
  const followupLoading = isPendingFilter
    ? pendingLoading
    : isConvertedFilter
      ? convertedLoading
      : notConvertedLoading;

  return (
    <Page>
      <PageHeader
        subtitle="A base da casa por nível e situação. Filtre e leve o público para uma campanha."
        actions={
          <>
            <Button
              className="h-11 px-4 sm:h-9"
              disabled={filteredCount === 0 || buildingAudience}
              onClick={() => sendToSmsAudience("filter")}
            >
              {buildingAudience ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MessageSquareText className="h-4 w-4" />
              )}
              Usar na campanha
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="outline"
                  label="Mais ações"
                  icon={<MoreHorizontal className="h-4 w-4" />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  disabled={filteredCount === 0 || exportingCsv}
                  onSelect={() => void exportCsv()}
                >
                  <Download className="h-4 w-4" />
                  {exportingCsv ? "Exportando…" : "Exportar CSV"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={filteredCount === 0 || copyingFilter}
                  onSelect={() => void copyFilterIds()}
                >
                  <Copy className="h-4 w-4" />
                  {copyingFilter ? "Copiando…" : "Copiar IDs da plataforma"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          title="Jogadores"
          value={(gamification?.totals.players ?? totalCount).toLocaleString("pt-BR")}
        />
        <KpiCard
          title="Já depositaram"
          value={(gamification?.totals.depositors ?? 0).toLocaleString("pt-BR")}
          detail={depositorsShare}
        />
        <KpiCard title="Depositado no total" value={brl(gamification?.totals.deposited ?? 0)} />
        <KpiCard
          title="VIPs esfriando"
          value={(gamification?.totals.stoppedVipCount ?? 0).toLocaleString("pt-BR")}
          detail={vipLegend}
        />
      </div>

      <PageTabs
        label="Jogadores"
        value={view}
        onValueChange={(next) => setView(next as PlayersView)}
        items={VIEW_TABS}
      />

      {view === "lista" ? (
        <>
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative w-full sm:max-w-md">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  aria-label="Buscar jogador"
                  placeholder="Buscar por nome, telefone, e-mail ou ID"
                  className="h-10 bg-card pl-9 pr-10"
                />
                {searchInput && (
                  <button
                    type="button"
                    aria-label="Limpar busca"
                    onClick={() => {
                      setSearchInput("");
                      setSearch("");
                    }}
                    className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-10 gap-2 self-start sm:self-auto"
                onClick={openAdvancedFilters}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Mais filtros
                {advancedFilterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-meta font-semibold text-primary-foreground">
                    {advancedFilterCount}
                  </span>
                )}
              </Button>
            </div>

            <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
              <SegmentedFilter
                label="Situação"
                value={selectedSituation ?? "todos"}
                onValueChange={(value) =>
                  selectSituation(value === "todos" ? null : (value as PlayerSituation))
                }
                items={[
                  { value: "todos", label: "Todas as situações" },
                  ...SITUATIONS.map((situation) => ({
                    value: situation,
                    label: SITUATION_FILTER_LABEL[situation],
                    count: situationCounts?.[situation] ?? null,
                  })),
                ]}
              />
              <SegmentedFilter
                label="Nível"
                value={selectedLevel ?? "todos"}
                onValueChange={(value) =>
                  selectLevel(value === "todos" ? null : (value as PaidLevelSlug))
                }
                items={[
                  { value: "todos", label: "Todos os níveis" },
                  ...PAID_LEVELS.map((level) => ({
                    value: level,
                    label: LEVEL_LABEL[level],
                    count: contextualLevelCounts?.get(level) ?? null,
                  })),
                ]}
              />
            </div>

            {drawerChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {drawerChips.map((chip) => (
                  <span
                    key={chip.key}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card pl-3 pr-1 text-label"
                  >
                    {chip.label}
                    <button
                      type="button"
                      aria-label={`Remover filtro ${chip.label}`}
                      onClick={chip.onRemove}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="h-8 px-2 text-label text-primary hover:underline"
                >
                  Limpar tudo
                </button>
              </div>
            )}
          </div>

          <HomeCard className="overflow-hidden">
            <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5 sm:px-5">
              {selectedIds.size > 0 ? (
                <>
                  <p className="text-body font-semibold" aria-live="polite">
                    {selectedIds.size === 1
                      ? "1 selecionado"
                      : `${selectedIds.size.toLocaleString("pt-BR")} selecionados`}
                  </p>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      className="h-10 sm:h-9"
                      disabled={buildingAudience}
                      onClick={() => sendToSmsAudience("selected")}
                    >
                      <MessageSquareText className="h-4 w-4" />
                      Usar selecionados na campanha
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10 sm:h-9"
                      onClick={copySelectedIds}
                    >
                      <Copy className="h-4 w-4" />
                      Copiar IDs
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-10 sm:h-9"
                      onClick={clearSelection}
                    >
                      Limpar seleção
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-body" aria-live="polite">
                    <span>
                      <strong className="font-semibold tabular-nums">
                        {filteredCount.toLocaleString("pt-BR")}
                      </strong>{" "}
                      {filteredCount === 1 ? "jogador" : "jogadores"}
                    </span>
                    {isFetchingPlayers && (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                        aria-label="Atualizando"
                      />
                    )}
                  </p>
                  <div className="ml-auto flex items-center gap-2 md:hidden">
                    <Select
                      value={mobileSortValue}
                      onValueChange={(value) => {
                        const key = MOBILE_SORTS.find((item) => item.value === value)?.key;
                        setSort(key ? { key, dir: "desc" } : null);
                      }}
                    >
                      <SelectTrigger className="h-10 w-[150px]" aria-label="Ordenar por">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MOBILE_SORTS.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10"
                      aria-pressed={selectionMode}
                      onClick={() => setSelectionMode((current) => !current)}
                      disabled={paged.length === 0}
                    >
                      {selectionMode ? "Cancelar" : "Selecionar"}
                    </Button>
                  </div>
                </>
              )}
            </div>

            <div className={cn("transition-opacity", isPlaceholderData && "opacity-60")}>
              {/* Desktop: tabela, com a coluna do nome fixa ao rolar para o lado. */}
              <div className="hidden md:block">
                <Table className="min-w-[880px]">
                  <TableHeader>
                    <TableRow className="border-border/60 hover:bg-transparent">
                      <TableHead className="sticky left-0 z-10 w-10 bg-card">
                        <Checkbox
                          checked={allPageSelected}
                          onCheckedChange={(v) => togglePage(Boolean(v))}
                          aria-label="Selecionar todos desta página"
                        />
                      </TableHead>
                      <TableHead className="sticky left-10 z-10 bg-card">Jogador</TableHead>
                      <TableHead>Nível</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead className="text-right">Depósitos</TableHead>
                      <TableHead className="text-right">
                        <SortHeader k="total_depositado" label="Total depositado" align="right" />
                      </TableHead>
                      <TableHead>
                        <SortHeader k="ultimo_deposito" label="Último depósito" />
                      </TableHead>
                      <TableHead>
                        <SortHeader k="origem" label="Veio de" />
                      </TableHead>
                      <TableHead className="w-12">
                        <span className="sr-only">Abrir ficha</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading &&
                      Array.from({ length: 8 }).map((_, i) => (
                        <TableRow key={i}>
                          {Array.from({ length: 9 }).map((_, j) => (
                            <TableCell key={j}>
                              <Skeleton className="h-4 w-20" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    {paged.map((p) => {
                      const extId = (p.player_external_id ?? "").trim();
                      const depositsCount = Number(p.deposits_count ?? 0);
                      return (
                        <TableRow key={p.id} className="group border-border/40">
                          <TableCell className="sticky left-0 z-10 w-10 bg-card group-hover:bg-secondary">
                            <Checkbox
                              checked={selectedIds.has(p.id)}
                              onCheckedChange={(v) => toggleSelected(p, Boolean(v))}
                              aria-label={`Selecionar ${p.nome}`}
                            />
                          </TableCell>
                          <TableCell className="sticky left-10 z-10 max-w-[280px] bg-card group-hover:bg-secondary">
                            <div className="flex items-center gap-2">
                              <RiskDot risk={p.risco} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <Link
                                    to="/players/$playerId"
                                    params={{ playerId: p.id }}
                                    search={{ id: undefined, focus: undefined }}
                                    className="truncate font-medium hover:text-primary"
                                  >
                                    {p.nome}
                                  </Link>
                                  {p.vip && (
                                    <Crown
                                      className="h-3.5 w-3.5 shrink-0 text-amber-400"
                                      aria-label="VIP"
                                    />
                                  )}
                                  {pendingPlayerIdsAny.has(p.id) && <AwaitingBadge />}
                                </div>
                                {extId && (
                                  <button
                                    type="button"
                                    onClick={() => copyOneId(extId, p.id)}
                                    className="mt-0.5 inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-primary"
                                  >
                                    {copiedId === p.id ? (
                                      <Check className="h-3 w-3 text-success" aria-hidden="true" />
                                    ) : (
                                      <Copy className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {copiedId === p.id ? "ID copiado" : "Copiar ID"}
                                  </button>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <LevelBadge level={getPlayerLevel(p, playerGamificationSettings)} />
                          </TableCell>
                          <TableCell>
                            <SituationText
                              situation={getPlayerSituation(p, playerGamificationSettings)}
                              className="text-body"
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {depositsCount.toLocaleString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {brl(p.total_depositado)}
                          </TableCell>
                          <TableCell className="text-label text-muted-foreground">
                            {timeAgo(p.ultimo_deposito ?? p.ftd_em)}
                          </TableCell>
                          <TableCell>
                            <div className="max-w-[240px]">
                              <div className="truncate text-body">
                                {p.expert || p.origem || "—"}
                              </div>
                              {(p.origem || p.tags?.[0]) && (
                                <div className="truncate text-meta text-muted-foreground">
                                  {[p.origem, p.tags?.[0]].filter(Boolean).join(" · ")}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Link
                              to="/players/$playerId"
                              params={{ playerId: p.id }}
                              search={{ id: undefined, focus: undefined }}
                              aria-label={`Abrir ficha de ${p.nome}`}
                              title="Abrir ficha"
                              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Link>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Celular: cartões; a linha inteira abre a ficha (ou seleciona). */}
              <ul className="divide-y divide-border/60 md:hidden">
                {isLoading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <li key={i} className="space-y-2 px-4 py-3">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-56" />
                    </li>
                  ))}
                {paged.map((p) => {
                  const selected = selectedIds.has(p.id);
                  const content = (
                    <PlayerCardContent
                      player={p}
                      level={getPlayerLevel(p, playerGamificationSettings)}
                      situation={getPlayerSituation(p, playerGamificationSettings)}
                      awaiting={pendingPlayerIdsAny.has(p.id)}
                    />
                  );
                  return (
                    <li key={p.id}>
                      {selectionMode ? (
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => toggleSelected(p, !selected)}
                          className={cn(
                            "flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left",
                            selected && "bg-primary/10",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>
                          {content}
                        </button>
                      ) : (
                        <Link
                          to="/players/$playerId"
                          params={{ playerId: p.id }}
                          search={{ id: undefined, focus: undefined }}
                          className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 active:bg-secondary"
                        >
                          {content}
                          <ChevronRight
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>

              {!isLoading && filteredCount === 0 && (
                <EmptyState
                  icon={<Users />}
                  title="Nenhum jogador encontrado"
                  description={
                    hasAnyFilter
                      ? "Nenhum jogador combina com a busca e os filtros escolhidos."
                      : "Os jogadores aparecem aqui assim que a casa enviar o primeiro cadastro."
                  }
                  action={
                    hasAnyFilter ? (
                      <Button variant="outline" onClick={clearAllFilters}>
                        Limpar filtros
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>

            {filteredCount > pageSize && (
              <nav
                aria-label="Paginação da lista de jogadores"
                className="flex items-center gap-3 border-t border-border/70 px-4 py-2.5 sm:px-5"
              >
                <p className="hidden text-meta text-muted-foreground tabular-nums sm:block">
                  {pageStart.toLocaleString("pt-BR")}–{pageEnd.toLocaleString("pt-BR")} de{" "}
                  {filteredCount.toLocaleString("pt-BR")}
                </p>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 sm:h-9"
                    aria-label="Página anterior"
                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Anterior</span>
                  </Button>
                  <span className="min-w-16 text-center text-label tabular-nums" aria-live="polite">
                    {currentPage} de {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 sm:h-9"
                    aria-label="Próxima página"
                    onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <span className="hidden sm:inline">Próxima</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </nav>
            )}
          </HomeCard>
        </>
      ) : (
        <section className="space-y-3" aria-label="Acompanhamento de contatos">
          <p className="text-body text-muted-foreground">
            Jogadores que receberam mensagem e o desfecho do contato. Marque se converteu para tirar
            da fila.
          </p>
          <SegmentedFilter
            label="Fila de acompanhamento"
            value={followupQueue}
            onValueChange={setFollowupQueue}
            items={FOLLOWUP_QUEUES.map((queue) => ({
              ...queue,
              count:
                queue.value === "aguardando_conversao"
                  ? (pendingData?.rows.length ?? null)
                  : queue.value === "convertido"
                    ? (convertedData?.rows.length ?? null)
                    : (notConvertedData?.rows.length ?? null),
            }))}
          />
          <HomeCard className="overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3 sm:px-5">
              <h2 className="text-section">
                {FOLLOWUP_QUEUES.find((queue) => queue.value === followupQueue)?.label}
              </h2>
              <p className="mt-0.5 text-label text-muted-foreground">
                {isPendingFilter
                  ? "Contatados nos últimos 5 dias, ainda sem desfecho."
                  : "Desfechos marcados nos últimos 30 dias."}
              </p>
            </div>
            {followupLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : followupRows.length === 0 ? (
              <EmptyState
                icon={<History />}
                title={
                  isPendingFilter
                    ? "Ninguém aguardando conversão"
                    : isConvertedFilter
                      ? "Nenhum jogador convertido ainda"
                      : "Nenhum jogador marcado como não convertido"
                }
                description="Quando alguém receber mensagem por aqui, ele aparece nesta fila."
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {followupRows.map((row) => (
                  <li
                    key={`${row.player_id}:${row.alerta_tipo}`}
                    className="flex flex-col gap-3 px-4 py-3 sm:px-5 lg:flex-row lg:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/players/$playerId"
                          params={{ playerId: row.player_id }}
                          search={{ id: undefined, focus: undefined }}
                          className="font-medium hover:text-primary"
                        >
                          {row.nome}
                        </Link>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-md border px-2 py-0.5 text-meta",
                            isPendingFilter
                              ? "border-warning/40 text-warning"
                              : isConvertedFilter
                                ? "border-success/40 text-success"
                                : "border-danger/40 text-danger",
                          )}
                        >
                          {alertTypeLabel(row.alerta_tipo)}
                        </span>
                        {"converted_auto" in row && row.converted_auto && (
                          <span className="text-meta text-success">
                            depositou depois do contato
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-meta text-muted-foreground">
                        {[row.telefone, row.email].filter(Boolean).join(" · ") || "Sem contato"}
                        {" · "}
                        {isPendingFilter
                          ? `contato ${timeAgo("sent_at" in row ? row.sent_at : null)}`
                          : `marcado ${timeAgo("outcome_at" in row ? row.outcome_at : null)}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10 sm:h-9"
                        onClick={() => setHistoryPlayer({ id: row.player_id, nome: row.nome })}
                      >
                        <History className="h-4 w-4" />
                        Histórico
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10 sm:h-9"
                        onClick={() => openWaFromRow(row)}
                      >
                        <MessageCircle className="h-4 w-4" />
                        Mensagem
                      </Button>
                      {isPendingFilter && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-10 border-success/40 text-success hover:bg-success/10 hover:text-success sm:h-9"
                            onClick={() => handleMarkOutcome(row as PendingConversionRow, true)}
                          >
                            Converteu
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-10 sm:h-9"
                            onClick={() => handleMarkOutcome(row as PendingConversionRow, false)}
                          >
                            Não converteu
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </HomeCard>
        </section>
      )}

      <Sheet
        open={advancedFiltersOpen}
        onOpenChange={(open) => (open ? openAdvancedFilters() : closeAdvancedFilters())}
      >
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border/60 px-5 py-4 pr-12">
            <SheetTitle>Mais filtros</SheetTitle>
            <SheetDescription>
              Combine período, situação, nível, comportamento e oportunidades.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
            <DrawerSection title="Período">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={sheetDraft.dateField}
                  onValueChange={(v) =>
                    setAdvancedDraft((current) =>
                      current ? { ...current, dateField: v as "created_at" | "ftd_em" } : current,
                    )
                  }
                >
                  <SelectTrigger className="h-10 w-[180px]" aria-label="Data usada no período">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ftd_em">FTD (1º depósito)</SelectItem>
                    <SelectItem value="created_at">Cadastro</SelectItem>
                  </SelectContent>
                </Select>
                <Popover open={dateOpen} onOpenChange={setDateOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="h-10 gap-2">
                      <CalendarIcon className="h-4 w-4" />
                      {draftHasDateRange && sheetDraft.dateRange?.from
                        ? sheetDraft.dateRange.to &&
                          sheetDraft.dateRange.to.toDateString() !==
                            sheetDraft.dateRange.from.toDateString()
                          ? `${fmtBr(sheetDraft.dateRange.from)} a ${fmtBr(sheetDraft.dateRange.to)}`
                          : fmtBr(sheetDraft.dateRange.from)
                        : "Escolher período"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="pointer-events-auto w-auto p-0">
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
                            setAdvancedDraft((current) =>
                              current ? { ...current, dateRange: { from, to } } : current,
                            );
                            setDateOpen(false);
                          }}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                    <Calendar
                      mode="range"
                      selected={sheetDraft.dateRange}
                      onSelect={(nextRange) =>
                        setAdvancedDraft((current) =>
                          current ? { ...current, dateRange: nextRange } : current,
                        )
                      }
                      numberOfMonths={isMobile ? 1 : 2}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {draftHasDateRange && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setAdvancedDraft((current) =>
                        current ? { ...current, dateRange: undefined } : current,
                      )
                    }
                    className="h-10 gap-1"
                  >
                    <X className="h-4 w-4" />
                    Limpar período
                  </Button>
                )}
              </div>
            </DrawerSection>

            <DrawerSection
              title="Situação e nível"
              description="Sem depósito não combina com nível pago."
            >
              <ChipGroup label="Situação">
                {SITUATIONS.map((situation) => (
                  <FilterChip
                    key={situation}
                    active={sheetDraft.situation === situation}
                    onClick={() => selectDraftSituation(situation)}
                    count={gamification ? draftStatusCount(situation) : null}
                  >
                    {SITUATION_FILTER_LABEL[situation]}
                  </FilterChip>
                ))}
              </ChipGroup>
              <ChipGroup label="Nível">
                {PAID_LEVELS.map((level) => (
                  <FilterChip
                    key={level}
                    active={sheetDraft.level === level}
                    onClick={() => selectDraftLevel(level)}
                    count={gamification ? draftLevelCount(level) : null}
                  >
                    {LEVEL_LABEL[level]}
                  </FilterChip>
                ))}
              </ChipGroup>
            </DrawerSection>

            <DrawerSection
              title="Comportamento"
              description="Escolha um ou mais atalhos. O número mostra quantos jogadores há em cada um."
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-label text-muted-foreground">Mostrar quem atende a</span>
                <SegmentedFilter
                  label="Como combinar as condições"
                  value={sheetDraft.behaviorOperator}
                  onValueChange={(operator) =>
                    setAdvancedDraft((current) =>
                      current ? { ...current, behaviorOperator: operator } : current,
                    )
                  }
                  items={[
                    { value: "and", label: "Todas as condições" },
                    { value: "or", label: "Qualquer condição" },
                  ]}
                />
              </div>
              {advancedFilterGroups.map((group) => (
                <ChipGroup key={group.title} label={group.title}>
                  {group.ids.map((id) => {
                    const item = filters.find((candidate) => candidate.id === id);
                    if (!item) return null;
                    return (
                      <FilterChip
                        key={item.id}
                        active={sheetDraft.behaviorFilters.includes(item.id)}
                        onClick={() => selectAdvancedFilter(item.id)}
                        count={
                          isFetchingPlayerFilterFacets && !playerFilterFacets
                            ? null
                            : (playerFilterFacets?.[item.id] ?? 0)
                        }
                      >
                        {item.label}
                      </FilterChip>
                    );
                  })}
                </ChipGroup>
              ))}
            </DrawerSection>

            <DrawerSection
              title="Oportunidades"
              description="Sinais para agir agora. Escolha um; a contagem aparece depois de aplicar."
            >
              <div className="flex flex-wrap gap-2">
                {alertFilters.map((f) => (
                  <FilterChip
                    key={f.id}
                    active={sheetDraft.filter === f.id}
                    onClick={() => selectAdvancedFilter(f.id)}
                  >
                    {f.label}
                  </FilterChip>
                ))}
              </div>
            </DrawerSection>
          </div>
          <SheetFooter className="flex-row items-center gap-2 border-t border-border/60 px-5 py-3 sm:justify-between">
            <Button
              variant="ghost"
              className="h-11 sm:h-10"
              onClick={clearAdvancedDraft}
              disabled={draftFilterCount === 0}
            >
              Limpar filtros
            </Button>
            <Button className="ml-auto h-11 sm:h-10" onClick={applyAdvancedFilters}>
              {canEstimateDraft && !isFetchingDraftEstimate && draftEstimate
                ? `Ver ${draftEstimate.total.toLocaleString("pt-BR")} ${
                    draftEstimate.total === 1 ? "jogador" : "jogadores"
                  }`
                : "Ver jogadores"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

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
            // Grava follow-up — assim o jogador sai do filtro de oportunidade atual.
            // Nas filas de acompanhamento o tipo é a própria fila (como antes).
            const tipo = waDialog.alerta?.tipo ?? (inFollowup ? followupQueue : filter);
            const pid = waDialog.player.id!;
            // Atualização otimista: já adiciona ao set de "pendentes" pra o
            // jogador sumir do filtro no mesmo frame do clique.
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
    </Page>
  );
}

function AwaitingBadge() {
  return (
    <span
      title="Recebeu mensagem e ainda não teve desfecho"
      className="inline-flex shrink-0 items-center rounded-md border border-info/40 px-1.5 py-0.5 text-meta text-info"
    >
      Aguardando
    </span>
  );
}

function PlayerCardContent({
  player,
  level,
  situation,
  awaiting,
}: {
  player: Player;
  level: LevelSlug;
  situation: PlayerSituation;
  awaiting: boolean;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-body font-medium">{player.nome}</span>
        {player.vip && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-label="VIP" />}
        {awaiting && <AwaitingBadge />}
        <LevelBadge level={level} className="ml-auto" />
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground">
        <SituationText situation={situation} />
        <span aria-hidden="true">·</span>
        <span className="tabular-nums text-foreground/90">{brl(player.total_depositado)}</span>
        <span aria-hidden="true">·</span>
        <span>último depósito {timeAgo(player.ultimo_deposito ?? player.ftd_em)}</span>
      </p>
    </div>
  );
}

function DrawerSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-section">{title}</h3>
        {description && <p className="mt-0.5 text-label text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-label font-medium text-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number | null;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-label transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
      {count != null && (
        <span className="tabular-nums text-muted-foreground">{count.toLocaleString("pt-BR")}</span>
      )}
    </button>
  );
}
