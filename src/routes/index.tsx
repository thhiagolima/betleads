import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { type DateRange } from "react-day-picker";
import { brl, num, timeAgo } from "@/lib/format";
import { PageHeader, MetricCard } from "@/components/ui-premium";
import { brtDayStart, brtDayEnd } from "@/lib/tz";

function brtDayKeyLocal(d: Date) {
  return d
    .toLocaleString("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .slice(0, 10);
}
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Crown,
  TrendingUp,
  Users,
  AlertTriangle,
  Moon,
  Trophy,
  Wallet,
  CalendarIcon,
  Flame,
  Snowflake,
  Sparkles,
  ShieldCheck,
  LayoutDashboard,
} from "lucide-react";
import {
  classify,
  playerScore,
  detectAlerts,
  scoreColor,
  type PlayerLike,
} from "@/lib/player-rules";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  LineChart,
  Line,
} from "recharts";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

async function fetchDashboard(
  range: { from: Date; to: Date },
  tenantId: string,
) {
  // "Hoje" e ranges são sempre calculados em BRT (America/Sao_Paulo),
  // não no fuso do servidor (UTC), para baterem com o painel da casa.
  const startDate = brtDayStart(range.from);
  const endDate = brtDayEnd(range.to);
  const iso = startDate.toISOString();
  const isoEnd = endDate.toISOString();
  const T = tenantId;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();

  // Marco global "Zerar dashboards" — todo total cumulativo respeita esse corte.
  const resetRes = await supabase
    .from("dashboard_settings")
    .select("reset_at")
    .eq("id", "global")
    .maybeSingle();
  const resetAt = (resetRes.data?.reset_at as string) ?? "1970-01-01T00:00:00Z";

  // Agregações que ultrapassam o teto de 1000 linhas do PostgREST vão pela RPC.
  const totalsRpc = supabase.rpc("dashboard_totals", {
    _tenant: T,
    _from: iso,
    _to: isoEnd,
    _reset_at: resetAt,
  });

  const [
    activeToday,
    newToday,
    totalsAgg,
    vipDepPlayers,
    playersSeries,
    eventsByHour,
    totalPlayers,
    ftdPlayers,
    activeLast7,
    playersOlderThan7,
    bancaAgg,
    inactive7,
    riscoNoGame,
    lucroPlayers,
  ] = await Promise.all([
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T).gte("ultimo_login", iso).lte("ultimo_login", isoEnd),
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T).gte("created_at", iso).lte("created_at", isoEnd),
    totalsRpc,
    // Players VIP = total_depositado > 1000 (status ativo p/ "ativos" também)
    supabase
      .from("players")
      .select("id,status,total_depositado")
      .eq("tenant_id", T)
      .gt("total_depositado", 1000)
      .range(0, 49999),
    supabase.from("players").select("created_at").eq("tenant_id", T).gte("created_at", thirtyDaysAgo),
    supabase.from("events").select("created_at, tipo").eq("tenant_id", T).gte("created_at", sevenDaysAgo),
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T),
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T).not("ftd_em", "is", null),
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T).gte("ultimo_login", sevenDaysAgo),
    supabase.from("players").select("id", { count: "exact", head: true }).eq("tenant_id", T).lt("created_at", sevenDaysAgo),
    supabase
      .from("players")
      .select("saldo_carteira, saldo_bloqueado, saldo_bonus")
      .eq("tenant_id", T)
      .gte("ultimo_login", sixtyDaysAgo)
      .range(0, 49999),
    // Inativos 7d: depositantes ativos com último login entre 7 e 14 dias atrás
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .eq("status", "ativo")
      .not("ultimo_login", "is", null)
      .lt("ultimo_login", sevenDaysAgo)
      .gte("ultimo_login", fourteenDaysAgo),
    // Em risco: sem atividade entre 5 e 7 dias (ultimo_login como proxy,
    // já que ultimo_jogo só passou a ser registrado recentemente)
    supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", T)
      .not("ultimo_login", "is", null)
      .lt("ultimo_login", new Date(Date.now() - 5 * 86400000).toISOString())
      .gte("ultimo_login", new Date(Date.now() - 7 * 86400000).toISOString()),
    // Leads no lucro >= 1000 (total_depositado - total_sacado)
    supabase
      .from("players")
      .select("total_depositado,total_sacado")
      .eq("tenant_id", T)
      .range(0, 49999),
  ]);

  const inactive7Count = inactive7.count ?? 0;

  const totals = (totalsAgg.data ?? {}) as {
    deposits_period_sum?: number | string;
    deposits_period_count?: number | string;
    depositantes_period?: number | string;
    sacado_total_since_reset?: number | string;
    deposits_series_30d?: Array<{ day: string; value: number | string }>;
    players_series_30d?: Array<{ day: string; value: number | string }>;
    top_depositante_period?: { nome: string; total: number | string } | null;
  };
  const totalToday = Number(totals.deposits_period_sum ?? 0);
  const depsTodayCount = Number(totals.deposits_period_count ?? 0);
  const depositantesToday = Number(totals.depositantes_period ?? 0);
  const topToday = totals.top_depositante_period
    ? {
        nome: totals.top_depositante_period.nome,
        total: Number(totals.top_depositante_period.total ?? 0),
      }
    : null;

  const vipDep = (vipDepPlayers.data ?? []) as Array<{ status: string | null }>;
  const vipDepTotal = vipDep.length;
  const vipDepAtivos = vipDep.filter((p) => p.status === "ativo").length;

  const leadsQuentes = ((lucroPlayers.data ?? []) as Array<{
    total_depositado: number | string | null;
    total_sacado: number | string | null;
  }>).filter(
    (p) =>
      Number(p.total_depositado ?? 0) - Number(p.total_sacado ?? 0) >= 1000,
  ).length;

  // Séries por dia — chaves em BRT (America/Sao_Paulo), vindas da RPC/derivadas.
  const brtDayKey = (iso: string) => {
    const d = new Date(iso);
    const s = d.toLocaleString("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return s.slice(0, 10);
  };
  const today0 = new Date();
  const brtToday = brtDayKey(today0.toISOString());
  const byDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    byDay.set(brtDayKey(d.toISOString()), 0);
  }
  (totals.deposits_series_30d ?? []).forEach((row) => {
    if (byDay.has(row.day)) {
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + Number(row.value ?? 0));
    }
  });
  const depositsChart = Array.from(byDay.entries()).map(([d, v]) => ({
    day: d.slice(5),
    value: Math.round(v),
  }));

  const growthMap = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    growthMap.set(brtDayKey(d.toISOString()), 0);
  }
  (playersSeries.data ?? []).forEach((p) => {
    const k = brtDayKey(p.created_at as string);
    if (growthMap.has(k)) growthMap.set(k, (growthMap.get(k) ?? 0) + 1);
  });
  const growthChart = Array.from(growthMap.entries()).map(([d, v]) => ({
    day: d.slice(5),
    value: v,
  }));
  const hourMap = new Map<number, number>();
  void brtToday;
  for (let i = 0; i < 24; i++) hourMap.set(i, 0);
  (eventsByHour.data ?? []).forEach((e) => {
    const h = new Date(e.created_at as string).getHours();
    hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
  });
  const hourChart = Array.from(hourMap.entries()).map(([h, v]) => ({
    hour: `${String(h).padStart(2, "0")}h`,
    value: v,
  }));

  const total = totalPlayers.count ?? 0;
  const ftdCount = ftdPlayers.count ?? 0;
  const active7Count = activeLast7.count ?? 0;
  const older7Count = playersOlderThan7.count ?? 0;

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  const funnel = [
    { label: "Conversão para FTD", value: pct(ftdCount, total) },
    { label: "Retenção D7", value: pct(active7Count, older7Count) },
    { label: "Frequência de login (7d)", value: pct(active7Count, total) },
    { label: "Players inativos 7d", value: pct(inactive7Count, total) },
  ];

  const banca = (bancaAgg.data ?? []).reduce(
    (acc, p) => {
      acc.carteira += Number(p.saldo_carteira ?? 0);
      acc.bloqueado += Number(p.saldo_bloqueado ?? 0);
      acc.bonus += Number(p.saldo_bonus ?? 0);
      return acc;
    },
    { carteira: 0, bloqueado: 0, bonus: 0 },
  );
  const bancaTotal = banca.carteira + banca.bloqueado + banca.bonus;
  const bancaPlayersCount = (bancaAgg.data ?? []).length;
  const sacadoTotal = Number(totals.sacado_total_since_reset ?? 0);

  // ====== Inteligência estratégica: classificação + alertas + score ======
  const iso30Strat = new Date(Date.now() - 30 * 86400000).toISOString();
  const iso60Strat = new Date(Date.now() - 60 * 86400000).toISOString();
  const iso7Strat = new Date(Date.now() - 7 * 86400000).toISOString();
  const iso14Strat = new Date(Date.now() - 14 * 86400000).toISOString();

  const [allPlayersRes, deps60Res] = await Promise.all([
    supabase
      .from("players")
      .select(
        "id,nome,total_depositado,total_sacado,ultimo_login,ultimo_jogo,ultimo_deposito,vip,status,created_at,ftd_em",
      )
      .eq("tenant_id", T)
      .order("total_depositado", { ascending: false })
      .range(0, 19999),
    supabase
      .from("deposits")
      .select("player_id,valor,created_at")
      .eq("tenant_id", T)
      .gte("created_at", iso60Strat)
      .eq("status", "aprovado")
      .limit(10000),
  ]);

  const dep30Map = new Map<string, number>();
  const dep3060Map = new Map<string, number>();
  const dep7Map = new Map<string, number>();
  const dep7_14Map = new Map<string, number>();
  for (const d of deps60Res.data ?? []) {
    if (!d.player_id) continue;
    const k = d.player_id as string;
    const v = Number(d.valor ?? 0);
    const c = d.created_at as string;
    if (c >= iso30Strat) dep30Map.set(k, (dep30Map.get(k) ?? 0) + v);
    else dep3060Map.set(k, (dep3060Map.get(k) ?? 0) + v);
    if (c >= iso7Strat) dep7Map.set(k, (dep7Map.get(k) ?? 0) + v);
    else if (c >= iso14Strat) dep7_14Map.set(k, (dep7_14Map.get(k) ?? 0) + v);
  }

  let cVip = 0, cLeadQuente = 0, cLeadFrio = 0, cRisco = 0, cAltoPotencial = 0;
  let cAlertasAlta = 0, cVipAtivos7 = 0;
  const dep7Total = Array.from(dep7Map.values()).reduce((a, b) => a + b, 0);
  const dep7_14Total = Array.from(dep7_14Map.values()).reduce((a, b) => a + b, 0);
  const topPotenciais: { id: string; nome: string; score: number; total: number }[] = [];

  for (const p of allPlayersRes.data ?? []) {
    const enriched: PlayerLike = {
      ...p,
      dep_30d: dep30Map.get(p.id) ?? 0,
      dep_30_60d: dep3060Map.get(p.id) ?? 0,
    };
    const cls = classify(enriched);
    if (cls === "vip") cVip++;
    else if (cls === "lead_quente") cLeadQuente++;
    else if (cls === "lead_frio") cLeadFrio++;
    else if (cls === "em_risco") cRisco++;
    else if (cls === "alto_potencial") cAltoPotencial++;

    if (p.vip && p.ultimo_login && p.ultimo_login >= iso7Strat) cVipAtivos7++;

    const alerts = detectAlerts(enriched);
    cAlertasAlta += alerts.filter((a) => a.prioridade === "critico" || a.prioridade === "alto").length;

    const score = playerScore(enriched);
    if (score >= 60) {
      topPotenciais.push({
        id: p.id,
        nome: p.nome,
        score,
        total: Number(p.total_depositado ?? 0),
      });
    }
  }
  topPotenciais.sort((a, b) => b.score - a.score);

  // Retenção semanal: % que logou nos últimos 7d entre os com login nos 7-14d anteriores
  let denomRet = 0, numRet = 0;
  for (const p of allPlayersRes.data ?? []) {
    const ult = p.ultimo_login as string | null;
    if (ult && ult >= iso14Strat && ult < iso7Strat) denomRet++;
    if (ult && ult >= iso7Strat) numRet++;
  }
  const retencaoSemanal = denomRet > 0 ? Math.round((numRet / denomRet) * 100) : 0;
  const crescDep = dep7_14Total > 0
    ? Math.round(((dep7Total - dep7_14Total) / dep7_14Total) * 100)
    : dep7Total > 0 ? 100 : 0;

  const strategic = {
    em_risco: cRisco,
    lead_quente: cLeadQuente,
    lead_frio: cLeadFrio,
    alto_potencial: cAltoPotencial,
    vip_total: cVip,
    vip_ativos_7d: cVipAtivos7,
    alertas_criticos: cAlertasAlta,
    retencao_semanal: retencaoSemanal,
    cresc_dep_semanal: crescDep,
    top_potenciais: topPotenciais.slice(0, 5),
  };

  return {
    activeToday: activeToday.count ?? 0,
    newToday: newToday.count ?? 0,
    depsTodayCount,
    depositantesToday,
    totalToday,
    riskPlayers: riscoNoGame.count ?? 0,
    inactive7: inactive7Count,
    vipPlayers: vipDepTotal,
    vipDepAtivos,
    leadsQuentes,
    topToday,
    depositsChart,
    growthChart,
    hourChart,
    funnel,
    banca,
    bancaTotal,
    sacadoTotal,
    bancaPlayersCount,
    totalPlayersCount: total,
    strategic,
  };
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  accent?: boolean | "primary" | "success" | "warning" | "danger" | "ai";
  sub?: string;
}) {
  return (
    <MetricCard
      label={label}
      value={value}
      hint={sub}
      accent={accent === true ? "primary" : accent || "primary"}
      icon={<Icon className="h-4 w-4" />}
    />
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/50 bg-card/60 backdrop-blur">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="h-64 pt-2">{children}</CardContent>
    </Card>
  );
}

function Dashboard() {
  const [range, setRange] = useState<DateRange | undefined>(() => {
    const today = new Date();
    return { from: today, to: today };
  });
  const [open, setOpen] = useState(false);

  const from = range?.from ?? new Date();
  const to = range?.to ?? from;

  // Tenants acessíveis ao usuário (RLS já filtra). Super admin vê todos;
  // membro comum vê só o próprio.
  const { data: tenants } = useQuery({
    queryKey: ["accessible-tenants"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("id, nome")
        .order("nome");
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    staleTime: 5 * 60_000,
  });

  const STORAGE_KEY = "dashboard:active_tenant";
  const [activeTenantId, setActiveTenantIdRaw] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
  });
  // Se a escolha salva não está mais acessível (ou não há), cai no primeiro.
  const tenantId =
    tenants && tenants.length > 0
      ? (activeTenantId && tenants.some((t) => t.id === activeTenantId)
          ? activeTenantId
          : tenants[0].id)
      : null;
  const setActiveTenantId = (id: string) => {
    setActiveTenantIdRaw(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: [
      "dashboard",
      tenantId,
      brtDayKeyLocal(from),
      brtDayKeyLocal(to),
    ],
    queryFn: () => fetchDashboard({ from, to }, tenantId as string),
    enabled: !!tenantId,
    refetchInterval: 15000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const top = data.topToday;

  const fmt = (d: Date) => d.toLocaleDateString("pt-BR");
  const sameDay = from.toDateString() === to.toDateString();
  const setPreset = (days: number) => {
    const end = new Date();
    const start = new Date(Date.now() - (days - 1) * 86400000);
    setRange({ from: start, to: end });
    setOpen(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Visão geral de players, depósitos e inteligência estratégica"
        icon={<LayoutDashboard className="h-5 w-5 text-primary-foreground" />}
        actions={
          <div className="flex items-center gap-2">
          {tenants && tenants.length > 1 && (
            <Select
              value={tenantId ?? undefined}
              onValueChange={setActiveTenantId}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Selecione o tenant" />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="gap-2">
              <CalendarIcon className="h-4 w-4" />
              {sameDay ? fmt(from) : `${fmt(from)} - ${fmt(to)}`}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0">
            <div className="flex flex-col gap-2 border-b p-3">
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPreset(1)}>Hoje</Button>
                <Button size="sm" variant="ghost" onClick={() => setPreset(7)}>7 dias</Button>
                <Button size="sm" variant="ghost" onClick={() => setPreset(30)}>30 dias</Button>
                <Button size="sm" variant="ghost" onClick={() => setPreset(90)}>90 dias</Button>
              </div>
            </div>
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={2}
              initialFocus
            />
          </PopoverContent>
          </Popover>
          </div>
        }
      />

      <Card className="border-primary/30 bg-gradient-to-br from-primary/10 via-card/60 to-card/60 backdrop-blur">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/20 text-primary">
                <Wallet className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Banca total na casa
                </p>
                <p className="mt-1 text-3xl font-bold tracking-tight">
                  {brl(data.bancaTotal)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Saldo de {num(data.bancaPlayersCount)} players ativos (60d) · Já sacado: {brl(data.sacadoTotal)}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4 lg:gap-6">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Disponível</p>
                <p className="mt-1 text-lg font-semibold">{brl(data.banca.carteira)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Bloqueado</p>
                <p className="mt-1 text-lg font-semibold">{brl(data.banca.bloqueado)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Bônus</p>
                <p className="mt-1 text-lg font-semibold">{brl(data.banca.bonus)}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Players ativos hoje" value={num(data.activeToday)} icon={Users} accent="primary" />
        <StatCard label="Novos cadastros hoje" value={num(data.newToday)} icon={TrendingUp} accent="success" />
        <StatCard label="Depósitos hoje" value={num(data.depsTodayCount)} icon={ArrowDownToLine} accent="success" />
        <StatCard label="Depositantes hoje" value={num(data.depositantesToday)} icon={Users} accent="success" sub="Players distintos" />
        <StatCard label="Total depositado" value={brl(data.totalToday)} icon={ArrowUpRight} accent="primary" />
        <StatCard label="Players em risco" value={num(data.riskPlayers)} icon={AlertTriangle} accent="danger" sub="Sem jogar há 5-7 dias" />
        <StatCard label="7 dias inativos" value={num(data.inactive7)} icon={Moon} accent="warning" />
        <StatCard label="Players VIP" value={num(data.vipPlayers)} icon={Crown} accent="ai" sub="Depositaram > R$ 1.000" />
        <StatCard
          label="Top depositante hoje"
          value={top ? brl(top.total) : "—"}
          sub={top?.nome ?? "Sem depósitos hoje"}
          icon={Trophy}
          accent="warning"
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Inteligência Estratégica
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Players em risco" value={num(data.riskPlayers)} icon={AlertTriangle} accent="danger" sub="Sem jogar há 5-7 dias" />
          <StatCard label="Leads quentes" value={num(data.leadsQuentes)} icon={Flame} accent="warning" sub="Lucro ≥ R$ 1.000" />
          <StatCard label="VIPs ativos" value={`${num(data.vipDepAtivos)}/${num(data.vipPlayers)}`} icon={Crown} accent="ai" sub="Ativos · depósito > R$ 1.000" />
          <StatCard label="Alertas críticos" value={num(data.strategic.alertas_criticos)} icon={AlertTriangle} accent="danger" sub="Prioridade alta" />
          <StatCard label="Leads frios" value={num(data.strategic.lead_frio)} icon={Snowflake} accent="primary" />
        </div>

        {data.strategic.top_potenciais.length > 0 && (
          <Card className="border-border/50 bg-card/60 backdrop-blur">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Players com maior potencial</CardTitle>
              <p className="text-xs text-muted-foreground">Score combinado de frequência, retenção e depósitos</p>
            </CardHeader>
            <CardContent className="space-y-2 pt-2">
              {data.strategic.top_potenciais.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2">
                  <p className="text-sm font-medium truncate">{p.nome}</p>
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-xs text-muted-foreground">{brl(p.total)}</span>
                    <span className={`text-sm font-bold ${scoreColor(p.score)}`}>{p.score}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4">
        <ChartCard
          title="Depósitos (últimos 30 dias)"
          subtitle="Soma diária de depósitos aprovados, em fuso BRT"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.depositsChart}>
              <defs>
                <linearGradient id="depGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.78 0.22 250)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="oklch(0.78 0.22 250)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="oklch(1 0 0 / 0.06)" vertical={false} />
              <XAxis dataKey="day" stroke="oklch(0.65 0.03 250)" fontSize={10} tickLine={false} axisLine={false} interval={3} />
              <YAxis stroke="oklch(0.65 0.03 250)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => brl(Number(v))} width={80} />
              <Tooltip
                contentStyle={{
                  background: "oklch(0.16 0.025 260)",
                  border: "1px solid oklch(1 0 0 / 0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(l) => `Dia ${l}`}
                formatter={(value: number) => [brl(Number(value)), "Depósitos"]}
              />
              <Area type="monotone" dataKey="value" stroke="oklch(0.78 0.22 250)" strokeWidth={2} fill="url(#depGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Novos players (últimos 30 dias)"
          subtitle="Cadastros por dia (BRT)"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.growthChart}>
              <CartesianGrid stroke="oklch(1 0 0 / 0.06)" vertical={false} />
              <XAxis dataKey="day" stroke="oklch(0.65 0.03 250)" fontSize={10} tickLine={false} axisLine={false} interval={3} />
              <YAxis stroke="oklch(0.65 0.03 250)" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "oklch(0.16 0.025 260)",
                  border: "1px solid oklch(1 0 0 / 0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(l) => `Dia ${l}`}
                formatter={(value: number) => [`${num(Number(value))} novos`, "Cadastros"]}
              />
              <Bar dataKey="value" fill="oklch(0.78 0.18 160)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card className="border-border/50 bg-card/60 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Funil de conversão
            </CardTitle>
            <p className="text-xs text-muted-foreground">Indicadores-chave de ativação e retenção</p>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            {data.funnel.map((f) => (
              <div key={f.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{f.label}</span>
                  <span className="font-semibold tabular-nums">{f.value}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.min(100, Math.max(0, f.value))}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <ChartCard
          title="Atividade por horário"
          subtitle="Quantos eventos (logins, depósitos, jogos) aconteceram em cada hora do dia — soma dos últimos 7 dias"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.hourChart}>
              <CartesianGrid stroke="oklch(1 0 0 / 0.06)" vertical={false} />
              <XAxis dataKey="hour" stroke="oklch(0.65 0.03 250)" fontSize={10} tickLine={false} axisLine={false} interval={2} />
              <YAxis stroke="oklch(0.65 0.03 250)" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "oklch(0.16 0.025 260)",
                  border: "1px solid oklch(1 0 0 / 0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(label) => `Horário: ${label}`}
                formatter={(value: number) => [`${num(value)} eventos`, "Atividade"]}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="oklch(0.78 0.22 250)"
                strokeWidth={2}
                dot={{ fill: "oklch(0.78 0.22 250)", r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}