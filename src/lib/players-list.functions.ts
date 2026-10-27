import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { applyActiveWithin, applyInactiveAtLeast, applyInactivityWindow } from "./player-activity";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";

// Colunas usadas pela tabela /players. Mantenha em sincronia com o tipo Player no route.
const COLS =
  "id,nome,telefone,email,player_external_id,origem,expert,status,ultimo_login,ultimo_jogo,ultimo_deposito,total_depositado,total_sacado,saldo_carteira,saldo_bonus,tags,vip,risco,created_at,ftd_em,last_cashback_paid_at,last_cashback_amount,total_cashback_paid";

export type PlayerRow = {
  id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  player_external_id: string | null;
  origem: string | null;
  expert: string | null;
  status: string;
  ultimo_login: string | null;
  ultimo_jogo: string | null;
  ultimo_deposito: string | null;
  total_depositado: number;
  total_sacado: number;
  saldo_carteira: number;
  saldo_bonus: number;
  tags: string[];
  vip: boolean;
  risco: string;
  created_at: string;
  ftd_em: string | null;
  last_cashback_paid_at: string | null;
  last_cashback_amount: number | null;
  total_cashback_paid: number | null;
  deposits_count: number;
};

type Input = {
  page: number;
  pageSize: number;
  filter: string;
  // Dois ou mais comportamentos são avaliados pela RPC SQL, com AND/OR.
  behaviorFilters?: string[] | null;
  behaviorOperator?: "and" | "or" | null;
  gamificationStatus?: string | null;
  gamificationLevel?: string | null;
  search: string;
  sortKey:
    | "ultimo_login"
    | "ultimo_jogo"
    | "total_depositado"
    | "total_sacado"
    | "ultimo_deposito"
    | "saldo"
    | "lucro"
    | "status"
    | "origem"
    | null;
  sortDir: "asc" | "desc";
  // IDs pré-calculados (filtros de alerta vindos de outras server-fns).
  // Quando presente, a listagem é restrita a esse conjunto.
  idsIn?: string[] | null;
  // Filtro por intervalo de datas em coluna específica (created_at ou ftd_em).
  // dateFrom/dateTo são ISO em UTC (calculados no client a partir de BRT).
  dateField?: "created_at" | "ftd_em" | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

// PostgREST `or()` espera valores escapados: vírgulas/parênteses quebram a query.
function sanitizeSearch(s: string) {
  return s.replace(/[\\%,()*]/g, " ").trim();
}

const ISO = (d: number) => new Date(d).toISOString();

type PaidLevelSlug = "bronze" | "silver" | "gold" | "diamond" | "black";

type GamificationSettings = {
  thresholds: Record<PaidLevelSlug, number>;
  coolingAfterDays: number;
  sleepingAfterDays: number;
  vipMinLevel: PaidLevelSlug;
};

type QueryLike = {
  from?: never;
  select?: never;
  maybeSingle?: () => Promise<{
    data: {
      level_thresholds?: unknown;
      cooling_after_days?: unknown;
      sleeping_after_days?: unknown;
      vip_min_level?: unknown;
    } | null;
    error: { message: string } | null;
  }>;
  lt: (column: string, value: unknown) => QueryLike;
  lte: (column: string, value: unknown) => QueryLike;
  gt?: (column: string, value: unknown) => QueryLike;
  gte: (column: string, value: unknown) => QueryLike;
  not: (column: string, operator: string, value: unknown) => QueryLike;
  is: (column: string, value: unknown) => QueryLike;
};

type SettingsClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        maybeSingle: () => Promise<{
          data: {
            level_thresholds?: unknown;
            cooling_after_days?: unknown;
            sleeping_after_days?: unknown;
            vip_min_level?: unknown;
          } | null;
          error: { message: string } | null;
        }>;
      };
      maybeSingle: () => Promise<{
        data: {
          level_thresholds?: unknown;
          cooling_after_days?: unknown;
          sleeping_after_days?: unknown;
          vip_min_level?: unknown;
        } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

type DepositCountFilter = {
  eq: (column: string, value: unknown) => DepositCountFilter;
  range: (
    from: number,
    to: number,
  ) => Promise<{
    data: Array<{ player_id: string | null }> | null;
    error: { message: string } | null;
  }>;
};

type DepositCountClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => DepositCountFilter;
    };
  };
};

const DEFAULT_GAMIFICATION: GamificationSettings = {
  thresholds: {
    bronze: 10,
    silver: 200,
    gold: 500,
    diamond: 1000,
    black: 3000,
  },
  coolingAfterDays: 2,
  sleepingAfterDays: 7,
  vipMinLevel: "diamond",
};

async function readGamificationSettings(
  client: unknown,
  tenantId: string,
): Promise<GamificationSettings> {
  const supabase = client as SettingsClient;
  const { data, error } = await supabase
    .from("gamification_settings")
    .select("level_thresholds,cooling_after_days,sleeping_after_days,vip_min_level")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error || !data) return DEFAULT_GAMIFICATION;
  const raw = (data.level_thresholds ?? {}) as Partial<Record<PaidLevelSlug, unknown>>;
  const numberOr = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const vipMinLevel = ["bronze", "silver", "gold", "diamond", "black"].includes(
    String(data.vip_min_level),
  )
    ? (data.vip_min_level as PaidLevelSlug)
    : DEFAULT_GAMIFICATION.vipMinLevel;

  return {
    thresholds: {
      bronze: numberOr(raw.bronze, DEFAULT_GAMIFICATION.thresholds.bronze),
      silver: numberOr(raw.silver, DEFAULT_GAMIFICATION.thresholds.silver),
      gold: numberOr(raw.gold, DEFAULT_GAMIFICATION.thresholds.gold),
      diamond: numberOr(raw.diamond, DEFAULT_GAMIFICATION.thresholds.diamond),
      black: numberOr(raw.black, DEFAULT_GAMIFICATION.thresholds.black),
    },
    coolingAfterDays: numberOr(data.cooling_after_days, DEFAULT_GAMIFICATION.coolingAfterDays),
    sleepingAfterDays: numberOr(data.sleeping_after_days, DEFAULT_GAMIFICATION.sleepingAfterDays),
    vipMinLevel,
  };
}

function vipThreshold(settings: GamificationSettings) {
  return settings.thresholds[settings.vipMinLevel];
}

function needsGamificationSettings(filter: string, status?: string | null, level?: string | null) {
  return (
    isGamificationFilter(filter) ||
    Boolean(status) ||
    Boolean(level) ||
    ["vip", "vip_em_risco", "quase_vip"].includes(filter)
  );
}

function isGamificationFilter(filter: string) {
  return filter.startsWith("nivel_") || filter.startsWith("situacao_");
}

function applyGamificationFilter<T extends QueryLike>(
  q: T,
  filter: string,
  settings: GamificationSettings,
): T {
  const t = settings.thresholds;
  const now = Date.now();
  const daysAgo = (n: number) => ISO(now - n * 86400000);

  switch (filter) {
    case "nivel_novice":
      return q.lt("total_depositado", t.bronze) as T;
    case "nivel_bronze":
      return q.gte("total_depositado", t.bronze).lt("total_depositado", t.silver) as T;
    case "nivel_silver":
      return q.gte("total_depositado", t.silver).lt("total_depositado", t.gold) as T;
    case "nivel_gold":
      return q.gte("total_depositado", t.gold).lt("total_depositado", t.diamond) as T;
    case "nivel_diamond":
      return q.gte("total_depositado", t.diamond).lt("total_depositado", t.black) as T;
    case "nivel_black":
      return q.gte("total_depositado", t.black) as T;
    case "situacao_active":
      return q
        .not("ftd_em", "is", null)
        .gte("ultimo_deposito", daysAgo(settings.coolingAfterDays)) as T;
    case "situacao_cooling":
      return q
        .not("ftd_em", "is", null)
        .lt("ultimo_deposito", daysAgo(settings.coolingAfterDays))
        .gte("ultimo_deposito", daysAgo(settings.sleepingAfterDays)) as T;
    case "situacao_sleeping":
      return q
        .not("ftd_em", "is", null)
        .lt("ultimo_deposito", daysAgo(settings.sleepingAfterDays)) as T;
    case "situacao_no_deposit":
      return q.is("ftd_em", null).lte("total_depositado", 0) as T;
    default:
      return q;
  }
}

function applyGamificationDimensions<T extends QueryLike>(
  q: T,
  status: string | null | undefined,
  level: string | null | undefined,
  settings: GamificationSettings,
): T {
  let result = q;
  if (status) result = applyGamificationFilter(result, `situacao_${status}`, settings);
  if (level) result = applyGamificationFilter(result, `nivel_${level}`, settings);
  return result;
}

async function attachDepositCounts(
  client: unknown,
  rows: PlayerRow[],
  // CON-08: tenant of the rows, so the deposits query carries an explicit tenant filter
  // instead of relying on RLS alone. Every players query here is pinned to the active
  // house, including the players_by_behavior_filters path.
  tenantId: string | null,
): Promise<PlayerRow[]> {
  const supabase = client as DepositCountClient;
  if (rows.length === 0) return rows;
  const ids = rows.map((row) => row.id);
  const counts = new Map<string, number>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    let query = supabase.from("deposits").select("player_id").in("player_id", ids);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data, error } = await query.eq("status", "aprovado").range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);

    const batch = data ?? [];
    for (const deposit of batch) {
      if (deposit.player_id)
        counts.set(deposit.player_id, (counts.get(deposit.player_id) ?? 0) + 1);
    }
    if (batch.length < pageSize) break;
  }

  return rows.map((row) => ({
    ...row,
    deposits_count: counts.get(row.id) ?? 0,
  }));
}

export const getPlayersPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Input) => data)
  .handler(async ({ data, context }): Promise<{ rows: PlayerRow[]; total: number }> => {
    const {
      page,
      pageSize,
      filter,
      behaviorFilters: rawBehaviorFilters,
      behaviorOperator,
      gamificationStatus,
      gamificationLevel,
      search,
      sortKey,
      sortDir,
      idsIn,
      dateField,
      dateFrom,
      dateTo,
    } = data;
    const supabase = context.supabase;
    const tenantId = await resolveCurrentTenantId(supabase as any);
    const behaviorFilters = Array.from(
      new Set((rawBehaviorFilters ?? []).filter((value) => typeof value === "string" && value)),
    );
    const primaryBehaviorFilter = behaviorFilters[0] ?? filter;
    const usesCombinedBehaviorFilters = behaviorFilters.length > 1;
    const gamificationSettings =
      needsGamificationSettings(primaryBehaviorFilter, gamificationStatus, gamificationLevel) ||
      behaviorFilters.some((value) => ["vip", "vip_em_risco", "quase_vip"].includes(value))
        ? await readGamificationSettings(supabase, tenantId as string)
        : DEFAULT_GAMIFICATION;

    // Helper para aplicar filtros de janela / regra no PostgREST builder.
    const now = Date.now();
    const daysAgo = (n: number) => ISO(now - n * 86400000);
    // Início do dia em BRT (America/Sao_Paulo) expresso em UTC.
    const todayStartBrt = (() => {
      const now = new Date();
      const brt = new Date(now.getTime() - 3 * 3600 * 1000);
      const y = brt.getUTCFullYear(),
        m = brt.getUTCMonth(),
        d = brt.getUTCDate();
      return new Date(Date.UTC(y, m, d) + 3 * 3600 * 1000).toISOString();
    })();

    // Para sort saldo/lucro precisamos calcular em JS (não há expressão arbitrária no .order()).
    const computeClient = sortKey === "saldo" || sortKey === "lucro";

    let q: any = usesCombinedBehaviorFilters
      ? (supabase as any)
          .rpc("players_by_behavior_filters", {
            _filters: behaviorFilters,
            _operator: behaviorOperator === "or" ? "or" : "and",
            _vip_threshold: vipThreshold(gamificationSettings),
          })
          .select(COLS, { count: "exact" })
          // The RPC is security invoker with no tenant filter (a super admin would get every
          // house): pin it to the active house like the plain query below.
          .eq("tenant_id", tenantId)
      : supabase.from("players").select(COLS, { count: "exact" }).eq("tenant_id", tenantId);

    // 1) Restrição por IDs (alerta) — vem primeiro pra cortar volume.
    if (idsIn) {
      if (idsIn.length === 0) return { rows: [], total: 0 };
      q = q.in("id", idsIn);
    }

    // 2) Busca textual.
    const s = sanitizeSearch(search);
    if (s) {
      const term = `%${s}%`;
      q = q.or(
        `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
      );
    }

    // 3) Filtros de janela / regra.
    if (!usesCombinedBehaviorFilters)
      switch (primaryBehaviorFilter) {
        case "recorrentes":
          q = applyActiveWithin(q, daysAgo(4));
          break;
        case "ativo":
          q = q.not("ftd_em", "is", null);
          break;
        case "em_risco":
          q = applyInactiveAtLeast(q, daysAgo(7));
          break;
        case "risco_5_7":
          q = applyInactivityWindow(q, daysAgo(5), daysAgo(7));
          break;
        case "vip":
          q = q.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`);
          break;
        case "vip_em_risco":
          q = applyInactiveAtLeast(
            q.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`),
            daysAgo(7),
          );
          break;
        case "quase_vip":
          q = q
            .eq("vip", false)
            .gte("total_depositado", vipThreshold(gamificationSettings) * 0.7)
            .lt("total_depositado", vipThreshold(gamificationSettings));
          break;
        case "leads_quentes":
          q = applyActiveWithin(q, daysAgo(4)).gte("ultimo_deposito", daysAgo(7));
          break;
        case "com_saldo":
          // saldo_carteira + saldo_bonus > 0 → usa OR sobre cada coluna positiva (próximo o suficiente, pega o relevante)
          q = applyActiveWithin(q.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`), daysAgo(60));
          break;
        case "deposito_hoje":
          q = q.gte("ultimo_deposito", todayStartBrt);
          break;
        case "ftd_hoje":
          q = q.gte("ftd_em", todayStartBrt);
          break;
        case "nao_converteram":
          q = q.is("ftd_em", null);
          break;
        case "risco_inicial":
          q = applyInactivityWindow(q, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null);
          break;
        case "risco_moderado":
          q = applyInactivityWindow(q, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null);
          break;
        case "risco_alto":
          q = applyInactivityWindow(q, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null);
          break;
        case "quase_perdido":
          q = applyInactivityWindow(q, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null);
          break;
        case "recuperacao_dificil":
          q = applyInactivityWindow(q, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null);
          break;
        case "perdidos":
          q = applyInactiveAtLeast(q, daysAgo(60)).not("ftd_em", "is", null);
          break;
        case "cashback_pago_hoje":
          q = q.gte("last_cashback_paid_at", todayStartBrt);
          break;
        // "todos" e quaisquer filtros desconhecidos não restringem nada.
        default:
          q = applyGamificationFilter(q, filter, gamificationSettings);
          break;
      }
    q = applyGamificationDimensions(q, gamificationStatus, gamificationLevel, gamificationSettings);

    // 4) Range de datas (independente dos chips).
    if (dateField && dateFrom && dateTo) {
      q = q.gte(dateField, dateFrom).lte(dateField, dateTo);
      if (dateField === "ftd_em") q = q.not("ftd_em", "is", null);
    }

    // Caminho rápido: ordenação em coluna direta + range no servidor.
    if (!computeClient) {
      const orderCol =
        sortKey === "ultimo_login"
          ? "ultimo_login"
          : sortKey === "ultimo_jogo"
            ? "ultimo_jogo"
            : sortKey === "total_depositado"
              ? "total_depositado"
              : sortKey === "total_sacado"
                ? "total_sacado"
                : sortKey === "ultimo_deposito"
                  ? "ultimo_deposito"
                  : sortKey === "status"
                    ? "status"
                    : sortKey === "origem"
                      ? "origem"
                      : "ultimo_login";
      const ascending = sortDir === "asc";
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const {
        data: rows,
        count,
        error,
      } = await q.order(orderCol, { ascending, nullsFirst: false }).range(from, to);
      if (error) throw new Error(error.message);
      const enrichedRows = await attachDepositCounts(
        supabase,
        (rows ?? []) as unknown as PlayerRow[],
        tenantId as string,
      );
      return { rows: enrichedRows, total: count ?? 0 };
    }

    // Caminho com sort em saldo/lucro: traz todos os IDs do filtro (cols mínimas),
    // ordena em JS, fatia a página, e busca as linhas completas só dela.
    type Slim = {
      id: string;
      total_depositado: number;
      total_sacado: number;
      saldo_carteira: number;
      saldo_bonus: number;
    };
    // Reaproveita a mesma query, mas projeta só as colunas de cálculo.
    // (Refaz por simplicidade — PostgREST não permite trocar select depois.)
    let slim: any = usesCombinedBehaviorFilters
      ? (supabase as any)
          .rpc("players_by_behavior_filters", {
            _filters: behaviorFilters,
            _operator: behaviorOperator === "or" ? "or" : "and",
            _vip_threshold: vipThreshold(gamificationSettings),
          })
          .select("id,total_depositado,total_sacado,saldo_carteira,saldo_bonus", { count: "exact" })
          // The RPC is security invoker with no tenant filter (a super admin would get every
          // house): pin it to the active house like the plain query below.
          .eq("tenant_id", tenantId)
      : supabase
          .from("players")
          .select("id,total_depositado,total_sacado,saldo_carteira,saldo_bonus", { count: "exact" })
          .eq("tenant_id", tenantId);
    if (idsIn) slim = slim.in("id", idsIn);
    if (s) {
      const term = `%${s}%`;
      slim = slim.or(
        `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
      );
    }
    // duplica o switch acima — pequeno custo de manutenção em troca de simplicidade
    if (!usesCombinedBehaviorFilters)
      switch (primaryBehaviorFilter) {
        case "recorrentes":
          slim = applyActiveWithin(slim, daysAgo(4));
          break;
        case "ativo":
          slim = slim.not("ftd_em", "is", null);
          break;
        case "em_risco":
          slim = applyInactiveAtLeast(slim, daysAgo(7));
          break;
        case "risco_5_7":
          slim = applyInactivityWindow(slim, daysAgo(5), daysAgo(7));
          break;
        case "vip":
          slim = slim.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`);
          break;
        case "vip_em_risco":
          slim = applyInactiveAtLeast(
            slim.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`),
            daysAgo(7),
          );
          break;
        case "quase_vip":
          slim = slim
            .eq("vip", false)
            .gte("total_depositado", vipThreshold(gamificationSettings) * 0.7)
            .lt("total_depositado", vipThreshold(gamificationSettings));
          break;
        case "leads_quentes":
          slim = applyActiveWithin(slim, daysAgo(4)).gte("ultimo_deposito", daysAgo(7));
          break;
        case "com_saldo":
          slim = applyActiveWithin(slim.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`), daysAgo(60));
          break;
        case "deposito_hoje":
          slim = slim.gte("ultimo_deposito", todayStartBrt);
          break;
        case "ftd_hoje":
          slim = slim.gte("ftd_em", todayStartBrt);
          break;
        case "nao_converteram":
          slim = slim.is("ftd_em", null);
          break;
        case "risco_inicial":
          slim = applyInactivityWindow(slim, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null);
          break;
        case "risco_moderado":
          slim = applyInactivityWindow(slim, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null);
          break;
        case "risco_alto":
          slim = applyInactivityWindow(slim, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null);
          break;
        case "quase_perdido":
          slim = applyInactivityWindow(slim, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null);
          break;
        case "recuperacao_dificil":
          slim = applyInactivityWindow(slim, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null);
          break;
        case "perdidos":
          slim = applyInactiveAtLeast(slim, daysAgo(60)).not("ftd_em", "is", null);
          break;
        case "cashback_pago_hoje":
          slim = slim.gte("last_cashback_paid_at", todayStartBrt);
          break;
        default:
          slim = applyGamificationFilter(slim, filter, gamificationSettings);
          break;
      }
    slim = applyGamificationDimensions(
      slim,
      gamificationStatus,
      gamificationLevel,
      gamificationSettings,
    );
    if (dateField && dateFrom && dateTo) {
      slim = slim.gte(dateField, dateFrom).lte(dateField, dateTo);
      if (dateField === "ftd_em") slim = slim.not("ftd_em", "is", null);
    }

    // Pagina até 20k pra cobrir tenants grandes; o conjunto vem só com 5 cols numéricas (≈ 60 bytes/linha).
    const PAGE = 1000;
    const all: Slim[] = [];
    let total = 0;
    for (let from = 0; ; from += PAGE) {
      const { data: chunk, count, error } = await slim.range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (chunk ?? []) as unknown as Slim[];
      all.push(...batch);
      if (count != null) total = count;
      if (batch.length < PAGE) break;
      if (all.length >= 20000) break;
    }
    const dir = sortDir === "asc" ? 1 : -1;
    all.sort((a, b) => {
      const va =
        sortKey === "saldo"
          ? Number(a.saldo_carteira ?? 0) + Number(a.saldo_bonus ?? 0)
          : Number(a.total_depositado ?? 0) - Number(a.total_sacado ?? 0);
      const vb =
        sortKey === "saldo"
          ? Number(b.saldo_carteira ?? 0) + Number(b.saldo_bonus ?? 0)
          : Number(b.total_depositado ?? 0) - Number(b.total_sacado ?? 0);
      return (va - vb) * dir;
    });
    const fromIdx = (page - 1) * pageSize;
    const pageIds = all.slice(fromIdx, fromIdx + pageSize).map((r) => r.id);
    if (pageIds.length === 0) return { rows: [], total: total || all.length };
    const { data: rows, error: rowsErr } = await supabase
      .from("players")
      .select(COLS)
      .in("id", pageIds);
    if (rowsErr) throw new Error(rowsErr.message);
    // re-ordena conforme pageIds
    const byId = new Map((rows ?? []).map((r) => [(r as { id: string }).id, r]));
    const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean) as unknown as PlayerRow[];
    const enrichedRows = await attachDepositCounts(supabase, ordered, tenantId as string);
    return { rows: enrichedRows, total: total || all.length };
  });

// Retorna TODOS os player_external_id que casam com o filtro+search+idsIn atuais.
// Usado pra "Copiar IDs do filtro" — não pagina e não traz colunas extras.
type IdsInput = {
  filter: string;
  behaviorFilters?: string[] | null;
  behaviorOperator?: "and" | "or" | null;
  gamificationStatus?: string | null;
  gamificationLevel?: string | null;
  search: string;
  idsIn?: string[] | null;
  dateField?: "created_at" | "ftd_em" | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

type FilteredQueryResult = { q: any; empty: false } | { q: null; empty: true };

// Monta a query de players com o MESMO filtro da listagem (chips, busca,
// gamificação, datas e IDs de alerta), projetando só `columns`. Usado pelas
// ações que valem para o filtro inteiro: copiar IDs, público de SMS e CSV.
async function buildFilteredPlayersQuery(
  supabase: any,
  data: IdsInput,
  columns: string,
): Promise<FilteredQueryResult> {
  const {
    filter,
    behaviorFilters: rawBehaviorFilters,
    behaviorOperator,
    gamificationStatus,
    gamificationLevel,
    search,
    idsIn,
    dateField,
    dateFrom,
    dateTo,
  } = data;
  const tenantId = await resolveCurrentTenantId(supabase);
  const behaviorFilters = Array.from(
    new Set((rawBehaviorFilters ?? []).filter((value) => typeof value === "string" && value)),
  );
  const primaryBehaviorFilter = behaviorFilters[0] ?? filter;
  const usesCombinedBehaviorFilters = behaviorFilters.length > 1;
  const gamificationSettings =
    needsGamificationSettings(primaryBehaviorFilter, gamificationStatus, gamificationLevel) ||
    behaviorFilters.some((value) => ["vip", "vip_em_risco", "quase_vip"].includes(value))
      ? await readGamificationSettings(supabase, tenantId as string)
      : DEFAULT_GAMIFICATION;
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString();
  const todayStartBrt = (() => {
    const current = new Date();
    const brt = new Date(current.getTime() - 3 * 3600 * 1000);
    return new Date(
      Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + 3 * 3600 * 1000,
    ).toISOString();
  })();

  let q: any = usesCombinedBehaviorFilters
    ? supabase
        .rpc("players_by_behavior_filters", {
          _filters: behaviorFilters,
          _operator: behaviorOperator === "or" ? "or" : "and",
          _vip_threshold: vipThreshold(gamificationSettings),
        })
        .select(columns, { count: "exact" })
        // The RPC is security invoker with no tenant filter (a super admin would get every
        // house): pin it to the active house like the plain query below.
        .eq("tenant_id", tenantId)
    : supabase.from("players").select(columns, { count: "exact" }).eq("tenant_id", tenantId);

  if (idsIn) {
    if (idsIn.length === 0) return { q: null, empty: true };
    q = q.in("id", idsIn);
  }

  const s = sanitizeSearch(search);
  if (s) {
    const term = `%${s}%`;
    q = q.or(
      `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
    );
  }

  if (!usesCombinedBehaviorFilters)
    switch (primaryBehaviorFilter) {
      case "recorrentes":
        q = applyActiveWithin(q, daysAgo(4));
        break;
      case "ativo":
        q = q.not("ftd_em", "is", null);
        break;
      case "em_risco":
        q = applyInactiveAtLeast(q, daysAgo(7));
        break;
      case "risco_5_7":
        q = applyInactivityWindow(q, daysAgo(5), daysAgo(7));
        break;
      case "vip":
        q = q.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`);
        break;
      case "vip_em_risco":
        q = applyInactiveAtLeast(
          q.or(`vip.eq.true,total_depositado.gte.${vipThreshold(gamificationSettings)}`),
          daysAgo(7),
        );
        break;
      case "quase_vip":
        q = q
          .eq("vip", false)
          .gte("total_depositado", vipThreshold(gamificationSettings) * 0.7)
          .lt("total_depositado", vipThreshold(gamificationSettings));
        break;
      case "leads_quentes":
        q = applyActiveWithin(q, daysAgo(4)).gte("ultimo_deposito", daysAgo(7));
        break;
      case "com_saldo":
        q = applyActiveWithin(q.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`), daysAgo(60));
        break;
      case "deposito_hoje":
        q = q.gte("ultimo_deposito", todayStartBrt);
        break;
      case "ftd_hoje":
        q = q.gte("ftd_em", todayStartBrt);
        break;
      case "nao_converteram":
        q = q.is("ftd_em", null);
        break;
      case "risco_inicial":
        q = applyInactivityWindow(q, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null);
        break;
      case "risco_moderado":
        q = applyInactivityWindow(q, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null);
        break;
      case "risco_alto":
        q = applyInactivityWindow(q, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null);
        break;
      case "quase_perdido":
        q = applyInactivityWindow(q, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null);
        break;
      case "recuperacao_dificil":
        q = applyInactivityWindow(q, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null);
        break;
      case "perdidos":
        q = applyInactiveAtLeast(q, daysAgo(60)).not("ftd_em", "is", null);
        break;
      case "cashback_pago_hoje":
        q = q.gte("last_cashback_paid_at", todayStartBrt);
        break;
      default:
        q = applyGamificationFilter(q, filter, gamificationSettings);
        break;
    }
  q = applyGamificationDimensions(q, gamificationStatus, gamificationLevel, gamificationSettings);

  if (dateField && dateFrom && dateTo) {
    q = q.gte(dateField, dateFrom).lte(dateField, dateTo);
    if (dateField === "ftd_em") q = q.not("ftd_em", "is", null);
  }

  return { q, empty: false };
}

export const getPlayersFilteredExternalIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: IdsInput) => data)
  .handler(
    async ({ data, context }): Promise<{ ids: string[]; missing: number; total: number }> => {
      const built = await buildFilteredPlayersQuery(context.supabase, data, "player_external_id");
      if (built.empty) return { ids: [], missing: 0, total: 0 };
      const q = built.q;

      const PAGE = 1000;
      const ids: string[] = [];
      let missing = 0;
      let total = 0;
      for (let from = 0; ; from += PAGE) {
        const { data: chunk, count, error } = await q.range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const batch = (chunk ?? []) as Array<{ player_external_id: string | null }>;
        for (const row of batch) {
          const v = (row.player_external_id ?? "").trim();
          if (v) ids.push(v);
          else missing++;
        }
        if (count != null) total = count;
        if (batch.length < PAGE) break;
        if (ids.length + missing >= 50000) break;
      }
      // dedup, mantém ordem
      const seen = new Set<string>();
      const dedup: string[] = [];
      for (const id of ids)
        if (!seen.has(id)) {
          seen.add(id);
          dedup.push(id);
        }
      return { ids: dedup, missing, total: total || ids.length + missing };
    },
  );

/** Teto da seleção "filtro atual" enviada para campanha (mesmo do público de seleção). */
export const PLAYERS_SELECTION_LIMIT = 50_000;

/**
 * Ids internos dos jogadores do filtro atual, para virar público de seleção.
 * Corta nos 50 mil primeiros por data de cadastro (mais antigos primeiro) e
 * avisa (`truncated`).
 */
export const getPlayersFilteredPlayerIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: IdsInput) => data)
  .handler(
    async ({ data, context }): Promise<{ ids: string[]; total: number; truncated: boolean }> => {
      const built = await buildFilteredPlayersQuery(context.supabase, data, "id");
      if (built.empty) return { ids: [], total: 0, truncated: false };
      // Ordem estável entre as páginas e explicável no aviso de corte: os mais
      // antigos por data de cadastro primeiro (id desempata).
      const q = built.q.order("created_at", { ascending: true }).order("id", { ascending: true });

      const PAGE = 1000;
      const seen = new Set<string>();
      let total = 0;
      for (let from = 0; from < PLAYERS_SELECTION_LIMIT; from += PAGE) {
        const to = Math.min(from + PAGE, PLAYERS_SELECTION_LIMIT) - 1;
        const { data: chunk, count, error } = await q.range(from, to);
        if (error) throw new Error(error.message);
        const batch = (chunk ?? []) as Array<{ id: string }>;
        for (const row of batch) if (row.id) seen.add(row.id);
        if (count != null) total = count;
        if (batch.length < to - from + 1) break;
      }
      const ids = Array.from(seen);
      total = Math.max(total, ids.length);
      return { ids, total, truncated: total > ids.length };
    },
  );

// Colunas do CSV de Jogadores (sem deposits_count, que exigiria outra consulta).
const EXPORT_COLS =
  "id,nome,telefone,email,player_external_id,origem,expert,status,vip,ultimo_login,ultimo_jogo,ultimo_deposito,total_depositado,total_sacado,saldo_carteira,saldo_bonus,tags,created_at,ftd_em";

export const PLAYERS_EXPORT_LIMIT = 50_000;

const EXPORT_SORT_COLUMNS = new Set([
  "ultimo_login",
  "ultimo_jogo",
  "total_depositado",
  "total_sacado",
  "ultimo_deposito",
  "status",
  "origem",
]);

export type PlayerExportRow = Omit<
  PlayerRow,
  | "deposits_count"
  | "risco"
  | "last_cashback_paid_at"
  | "last_cashback_amount"
  | "total_cashback_paid"
>;

type ExportInput = IdsInput & {
  sortKey?: string | null;
  sortDir?: "asc" | "desc" | null;
};

// C-06: o CSV exporta o filtro inteiro (não só a página), com o mesmo filtro da
// listagem e um teto de segurança de PLAYERS_EXPORT_LIMIT linhas.
export const getPlayersFilteredExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: ExportInput) => data)
  .handler(
    async ({
      data,
      context,
    }): Promise<{ rows: PlayerExportRow[]; total: number; truncated: boolean }> => {
      const built = await buildFilteredPlayersQuery(context.supabase, data, EXPORT_COLS);
      if (built.empty) return { rows: [], total: 0, truncated: false };
      const orderCol =
        data.sortKey && EXPORT_SORT_COLUMNS.has(data.sortKey) ? data.sortKey : "ultimo_login";
      // `id` como desempate deixa a paginação estável entre os blocos de 1.000.
      const q = built.q
        .order(orderCol, { ascending: data.sortDir === "asc", nullsFirst: false })
        .order("id", { ascending: true });

      const PAGE = 1000;
      const rows: PlayerExportRow[] = [];
      let total = 0;
      for (let from = 0; from < PLAYERS_EXPORT_LIMIT; from += PAGE) {
        const to = Math.min(from + PAGE, PLAYERS_EXPORT_LIMIT) - 1;
        const { data: chunk, count, error } = await q.range(from, to);
        if (error) throw new Error(error.message);
        const batch = (chunk ?? []) as PlayerExportRow[];
        rows.push(...batch);
        if (count != null) total = count;
        if (batch.length < to - from + 1) break;
      }
      total = total || rows.length;
      return { rows, total, truncated: total > rows.length };
    },
  );
