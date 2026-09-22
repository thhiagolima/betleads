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
import { PageHeader } from "@/components/ui-premium";
import { Users } from "lucide-react";
import {
  computeAlertsByPlayer,
  whatsappMessageFor,
  type AlertaTipo,
  type Alerta,
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
  type PlayerRow,
} from "@/lib/players-list.functions";
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

function statusBadge(p: Player) {
  if (p.vip)
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">VIP</Badge>;
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const ativo = !!p.ultimo_login && new Date(p.ultimo_login).getTime() >= sevenDaysAgo;
  if (!ativo)
    return (
      <Badge variant="outline" className="border-muted text-muted-foreground">
        Inativo
      </Badge>
    );
  return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Ativo</Badge>;
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
  const [waDialog, setWaDialog] = useState<{ player: Player; alerta?: Alerta } | null>(null);
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
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao registrar desfecho");
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
      } as any,
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
  const data = pageData?.rows ?? [];
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
        players: all as any,
        deposits: (depsRes.data ?? []) as any,
        withdrawals: (wdRes.data ?? []) as any,
        sessions: (sessRes.data ?? []) as any,
        followups: (fupRes.data ?? []) as any,
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
        players: (data ?? []) as any,
        deposits: (depsRes.data ?? []) as any,
        withdrawals: (wdRes.data ?? []) as any,
        sessions: (sessRes.data ?? []) as any,
        followups: (fupRes.data ?? []) as any,
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
      } catch {}
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
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao copiar IDs");
    } finally {
      setCopyingFilter(false);
    }
  }

  if (isDetailRoute) return <Outlet />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Players"
        subtitle="Base completa de jogadores — filtros, busca e ações rápidas"
        icon={<Users className="h-5 w-5 text-primary-foreground" />}
      />
      <Card className="border-border/50 bg-card/60 backdrop-blur">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, telefone, email ou ID..."
                className="pl-9 bg-background/60"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="text-xs text-muted-foreground">{filteredCount} players</div>
              <button
                onClick={exportCsv}
                disabled={filteredCount === 0}
                className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-xs text-foreground hover:border-primary/60 hover:text-primary disabled:opacity-40 disabled:pointer-events-none"
              >
                <Download className="h-3.5 w-3.5" />
                Exportar CSV
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                  filter === f.id
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
              Filtrar por data
            </span>
            <Select
              value={dateField}
              onValueChange={(v) => setDateField(v as "created_at" | "ftd_em")}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ftd_em">FTD (1º depósito)</SelectItem>
                <SelectItem value="created_at">Cadastro</SelectItem>
              </SelectContent>
            </Select>
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-2 text-xs">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {hasDateRange && dateRange?.from
                    ? dateRange.to && dateRange.to.toDateString() !== dateRange.from.toDateString()
                      ? `${fmtBr(dateRange.from)} – ${fmtBr(dateRange.to)}`
                      : fmtBr(dateRange.from)
                    : "Selecionar período"}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0 pointer-events-auto">
                <div className="grid grid-cols-2 gap-2 border-b p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const t = new Date();
                      setDateRange({ from: t, to: t });
                      setDateOpen(false);
                    }}
                  >
                    Hoje
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const to = new Date();
                      const from = new Date(Date.now() - 6 * 86400000);
                      setDateRange({ from, to });
                      setDateOpen(false);
                    }}
                  >
                    7 dias
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const to = new Date();
                      const from = new Date(Date.now() - 29 * 86400000);
                      setDateRange({ from, to });
                      setDateOpen(false);
                    }}
                  >
                    30 dias
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const to = new Date();
                      const from = new Date(Date.now() - 89 * 86400000);
                      setDateRange({ from, to });
                      setDateOpen(false);
                    }}
                  >
                    90 dias
                  </Button>
                </div>
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={setDateRange}
                  numberOfMonths={2}
                  initialFocus
                  className="pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
            {hasDateRange && (
              <button
                onClick={() => setDateRange(undefined)}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                title="Limpar período"
              >
                <X className="h-3 w-3" /> Limpar
              </button>
            )}
          </div>
          <div className="space-y-1.5 pt-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
              Por alerta — manda mensagem e o lead some daqui
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
              <button
                onClick={() => setFilter("aguardando_conversao")}
                className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                  filter === "aguardando_conversao"
                    ? "border-sky-400/60 bg-sky-400/15 text-sky-300"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
                title="Leads que receberam mensagem nos últimos 5 dias e ainda não tiveram desfecho"
              >
                ⏳ Aguardando conversão
              </button>
              <button
                onClick={() => setFilter("convertido")}
                className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                  filter === "convertido"
                    ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
                title="Leads marcados como Converteu nos últimos 30 dias"
              >
                ✅ Converteu
              </button>
              <button
                onClick={() => setFilter("nao_convertido")}
                className={`rounded-full px-3 py-1 text-xs transition-colors border ${
                  filter === "nao_convertido"
                    ? "border-rose-400/60 bg-rose-400/15 text-rose-300"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
                title="Leads marcados como Não converteu nos últimos 30 dias"
              >
                ❌ Não converteu
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

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
            <Table className="min-w-[1200px]">
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
                  <TableHead>Player</TableHead>
                  <TableHead>ID Push</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead>
                    <SortHeader k="origem" label="Origem / Expert" />
                  </TableHead>
                  <TableHead>
                    <SortHeader k="status" label="Status" />
                  </TableHead>
                  <TableHead>
                    <SortHeader k="ultimo_login" label="Último login" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader k="total_depositado" label="Depositado" align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader k="total_sacado" label="Sacado" align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader k="saldo" label="Saldo" align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader k="lucro" label="Lucro" align="right" />
                  </TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead className="text-right">Ficha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 13 }).map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {paged.map((p) => {
                  const lucro = Number(p.total_depositado) - Number(p.total_sacado);
                  const saldo = Number(p.saldo_carteira ?? 0) + Number(p.saldo_bonus ?? 0);
                  const extId = (p.player_external_id ?? "").trim();
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
                            <span className="text-[11px] text-muted-foreground">
                              {p.player_external_id}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {extId ? (
                          <div className="inline-flex items-center gap-1.5">
                            <span className="font-mono text-xs">{extId}</span>
                            <button
                              type="button"
                              title="Copiar ID Push"
                              onClick={() => copyOneId(extId, p.id)}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10"
                            >
                              {copiedId === p.id ? (
                                <Check className="h-3.5 w-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                            Sem ID
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs">
                          <span className="flex items-center gap-2">
                            {p.telefone ?? "—"}
                            {p.telefone && (
                              <button
                                type="button"
                                title="Enviar pré-ligação no WhatsApp"
                                onClick={() => {
                                  setWaMensagem(
                                    nextPrecallCopy({
                                      fullName: p.nome,
                                      brand: tenantBrand ?? "",
                                    }),
                                  );
                                  setWaDialog({ player: p });
                                }}
                                className="inline-flex h-5 w-5 items-center justify-center rounded-md text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                              >
                                <MessageCircle className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </span>
                          <span className="text-muted-foreground">{p.email ?? "—"}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs">
                          <span>{p.origem ?? "—"}</span>
                          <span className="text-muted-foreground">{p.expert ?? "—"}</span>
                        </div>
                      </TableCell>
                      <TableCell>{statusBadge(p)}</TableCell>
                      <TableCell className="text-xs">{timeAgo(p.ultimo_login)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {brl(p.total_depositado)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {brl(p.total_sacado)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold ${
                          saldo > 0 ? "text-emerald-400" : "text-muted-foreground"
                        }`}
                      >
                        {brl(saldo)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold ${
                          lucro >= 0 ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {brl(lucro)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {p.tags.map((t) => (
                            <Badge
                              key={t}
                              variant="outline"
                              className="border-border/60 text-[10px] py-0"
                            >
                              {t}
                            </Badge>
                          ))}
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
                      colSpan={13}
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
                ? whatsappMessageFor(waDialog.alerta, waDialog.player as any)
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
