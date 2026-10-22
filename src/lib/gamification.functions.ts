import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { invalidateServerResultCache, withServerResultCache } from "@/lib/server-result-cache";

import { levelForTotal, type LevelSlug, type PaidLevelSlug } from "@/lib/player-level";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";

export type { LevelSlug, PaidLevelSlug };
export type PlayerStatus = "active" | "cooling" | "sleeping" | "no_deposit";

export type GamificationSettings = {
  thresholds: Record<PaidLevelSlug, number>;
  coolingAfterDays: number;
  sleepingAfterDays: number;
  vipMinLevel: PaidLevelSlug;
};

export type GamificationLevelSummary = {
  slug: LevelSlug;
  label: string;
  min: number;
  count: number;
  percent: number;
  totalDeposited: number;
  stopped: number;
};

export type GamificationPlayer = {
  id: string;
  nome: string;
  player_external_id: string | null;
  total_depositado: number;
  total_sacado: number;
  ultimo_deposito: string | null;
  ftd_em: string | null;
  telefone: string | null;
  email: string | null;
  level: LevelSlug;
  status: PlayerStatus;
  daysWithoutDeposit: number | null;
};

export type GamificationData = {
  settings: GamificationSettings;
  levels: GamificationLevelSummary[];
  totals: {
    players: number;
    depositors: number;
    deposited: number;
    stoppedVipCount: number;
    activeCount: number;
    coolingCount: number;
    sleepingCount: number;
    noDepositCount: number;
  };
  segmentCounts: Record<PlayerStatus, Record<LevelSlug, number>>;
  vipStopped: GamificationPlayer[];
  ranking: GamificationPlayer[];
};

const DEFAULT_SETTINGS: GamificationSettings = {
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

const LEVELS: Array<{ slug: LevelSlug; label: string }> = [
  { slug: "novice", label: "Novato" },
  { slug: "bronze", label: "Bronze" },
  { slug: "silver", label: "Prata" },
  { slug: "gold", label: "Ouro" },
  { slug: "diamond", label: "Diamante" },
  { slug: "black", label: "Black VIP" },
];

const PAID_LEVELS: PaidLevelSlug[] = ["bronze", "silver", "gold", "diamond", "black"];

export type DbPlayer = {
  id: string;
  nome: string;
  player_external_id: string | null;
  total_depositado: number | null;
  total_sacado: number | null;
  ultimo_deposito: string | null;
  ftd_em: string | null;
  telefone: string | null;
  email: string | null;
};

/** Body of `getGamificationData`, exported for tests. */
export async function getGamificationDataFor(supabase: any): Promise<GamificationData> {
  const tenantId = await resolveCurrentTenantId(supabase);
  return readGamificationSnapshot(supabase, tenantId as string);
}

export const getGamificationData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GamificationData> =>
    getGamificationDataFor(context.supabase as any),
  );

export const saveGamificationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => normalizeSettingsInput(input))
  .handler(async ({ data, context }): Promise<GamificationData> => {
    const supabase = context.supabase as any;
    const tenantId = await resolveCurrentTenantId(supabase);

    const { error } = await supabase.from("gamification_settings").upsert(
      {
        tenant_id: tenantId,
        level_thresholds: data.thresholds,
        cooling_after_days: data.coolingAfterDays,
        sleeping_after_days: data.sleepingAfterDays,
        vip_min_level: data.vipMinLevel,
        updated_by: context.userId,
      },
      { onConflict: "tenant_id" },
    );
    if (error) {
      if (isMissingGamificationTable(error)) {
        throw new Error(
          "A tabela de gamificacao ainda nao foi criada. Aplique as migrations antes de salvar.",
        );
      }
      throw new Error(error.message);
    }

    invalidateServerResultCache(`gamification:${tenantId}:`);
    invalidateServerResultCache(`audience:${tenantId}:`);
    return readGamificationSnapshot(supabase, tenantId);
  });

export const RANKING_SEARCH_LIMIT = 200;

export type RankingSearchInput = {
  search?: string | null;
  level?: LevelSlug | "all" | null;
  onlyStopped?: boolean | null;
};

export type RankingSearchResult = {
  players: GamificationPlayer[];
  /** Total de jogadores da base que casam com a busca/filtros (sem o corte de 200). */
  total: number;
};

// C-07: o snapshot só traz os 200 maiores depositantes. Quando há busca, nível
// ou "só quem parou", a consulta vai à base inteira da casa (mesmas faixas e
// mesma regra de situação do RPC gamification_snapshot_v2) e devolve os 200
// maiores que casam, com o total real.
export const searchGamificationRanking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RankingSearchInput) => input ?? {})
  .handler(async ({ data, context }): Promise<RankingSearchResult> => {
    const supabase = context.supabase as any;
    const tenantId = await resolveCurrentTenantId(supabase);
    const settings = await readSettings(supabase, tenantId as string);

    let q = supabase
      .from("players")
      .select(
        "id,nome,player_external_id,total_depositado,total_sacado,ultimo_deposito,ftd_em,telefone,email",
        { count: "exact" },
      )
      .eq("tenant_id", tenantId);
    q = applyRankingFilters(q, data, settings);

    const {
      data: rows,
      count,
      error,
    } = await q
      .order("total_depositado", { ascending: false })
      .order("id", { ascending: true })
      .limit(RANKING_SEARCH_LIMIT);
    if (error) throw new Error(error.message);
    const players = ((rows ?? []) as DbPlayer[]).map((player) => enrichPlayer(player, settings));
    return { players, total: count ?? players.length };
  });

type RankingFilterable = {
  or: (filters: string) => RankingFilterable;
  gte: (column: string, value: unknown) => RankingFilterable;
  lt: (column: string, value: unknown) => RankingFilterable;
};

// PostgREST `or()`: vírgulas e parênteses quebram a expressão.
export function sanitizeRankingSearch(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/[\\%,()*]/g, " ")
    .trim();
}

export function applyRankingFilters<T extends RankingFilterable>(
  query: T,
  input: RankingSearchInput,
  settings: Pick<GamificationSettings, "thresholds" | "coolingAfterDays">,
  now: number = Date.now(),
): T {
  let q: RankingFilterable = query;
  const term = sanitizeRankingSearch(input.search);
  if (term) {
    const like = `%${term}%`;
    q = q.or(`nome.ilike.${like},telefone.ilike.${like},player_external_id.ilike.${like}`);
  }

  const t = settings.thresholds;
  switch (input.level) {
    case "novice":
      q = q.lt("total_depositado", t.bronze);
      break;
    case "bronze":
      q = q.gte("total_depositado", t.bronze).lt("total_depositado", t.silver);
      break;
    case "silver":
      q = q.gte("total_depositado", t.silver).lt("total_depositado", t.gold);
      break;
    case "gold":
      q = q.gte("total_depositado", t.gold).lt("total_depositado", t.diamond);
      break;
    case "diamond":
      q = q.gte("total_depositado", t.diamond).lt("total_depositado", t.black);
      break;
    case "black":
      q = q.gte("total_depositado", t.black);
      break;
    default:
      break;
  }

  if (input.onlyStopped) {
    // "Parou" = situação diferente de ativo: sem depósito, ou último depósito
    // (ou FTD, quando não há último depósito) há `coolingAfterDays` dias ou mais.
    const cutoff = new Date(now - settings.coolingAfterDays * 86400000).toISOString();
    q = q.or(
      [
        "and(ftd_em.is.null,total_depositado.lte.0)",
        `ultimo_deposito.lt.${cutoff}`,
        `and(ultimo_deposito.is.null,or(ftd_em.is.null,ftd_em.lt.${cutoff}))`,
      ].join(","),
    );
  }
  return q as T;
}

async function readGamificationSnapshot(supabase: any, tenantId: string) {
  return withServerResultCache<GamificationData>(
    `gamification:${tenantId}:summary`,
    30_000,
    async () => {
      const { data, error } = await supabase.rpc("gamification_snapshot_v2", {
        _tenant: tenantId,
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Sem acesso aos dados de gamificacao desta conta.");
      return data as GamificationData;
    },
  );
}

async function readSettings(supabase: any, tenantId: string): Promise<GamificationSettings> {
  const { data, error } = await supabase
    .from("gamification_settings")
    .select("level_thresholds, cooling_after_days, sleeping_after_days, vip_min_level")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    if (isMissingGamificationTable(error)) return DEFAULT_SETTINGS;
    throw new Error(error.message);
  }
  if (!data) return DEFAULT_SETTINGS;

  return normalizeSettingsInput({
    thresholds: data.level_thresholds,
    coolingAfterDays: data.cooling_after_days,
    sleepingAfterDays: data.sleeping_after_days,
    vipMinLevel: data.vip_min_level,
  });
}

async function readPlayers(supabase: any, tenantId: string): Promise<DbPlayer[]> {
  const rows: DbPlayer[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("players")
      .select(
        "id,nome,player_external_id,total_depositado,total_sacado,ultimo_deposito,ftd_em,telefone,email",
      )
      .eq("tenant_id", tenantId)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    const batch = (data ?? []) as DbPlayer[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  return rows;
}

export function buildGamificationData(
  players: DbPlayer[],
  settings: GamificationSettings,
): GamificationData {
  const ranked = players
    .map((player) => enrichPlayer(player, settings))
    .sort((a, b) => b.total_depositado - a.total_depositado);

  const byLevel = new Map<LevelSlug, GamificationPlayer[]>();
  for (const level of LEVELS) byLevel.set(level.slug, []);
  for (const player of ranked) byLevel.get(player.level)?.push(player);

  const totalPlayers = ranked.length;
  const levels = LEVELS.map(({ slug, label }) => {
    const levelPlayers = byLevel.get(slug) ?? [];
    return {
      slug,
      label,
      min: levelMin(slug, settings),
      count: levelPlayers.length,
      percent: totalPlayers ? Math.round((levelPlayers.length / totalPlayers) * 100) : 0,
      totalDeposited: sum(levelPlayers.map((p) => p.total_depositado)),
      stopped: levelPlayers.filter((p) => p.status !== "active").length,
    };
  });

  const vipMinRank = levelRank(settings.vipMinLevel);
  const vipStopped = ranked.filter(
    (player) =>
      levelRank(player.level) >= vipMinRank &&
      player.status !== "active" &&
      player.status !== "no_deposit",
  );

  const segmentCounts = Object.fromEntries(
    (["active", "cooling", "sleeping", "no_deposit"] as PlayerStatus[]).map((status) => [
      status,
      Object.fromEntries(
        LEVELS.map(({ slug }) => [
          slug,
          ranked.filter((player) => player.status === status && player.level === slug).length,
        ]),
      ) as Record<LevelSlug, number>,
    ]),
  ) as Record<PlayerStatus, Record<LevelSlug, number>>;

  return {
    settings,
    levels,
    totals: {
      players: totalPlayers,
      depositors: ranked.filter((p) => p.total_depositado > 0 || p.ftd_em).length,
      deposited: sum(ranked.map((p) => p.total_depositado)),
      // total real (sem corte): a lista exibida abaixo é que se limita a 8
      stoppedVipCount: vipStopped.length,
      activeCount: ranked.filter((p) => p.status === "active").length,
      coolingCount: ranked.filter((p) => p.status === "cooling").length,
      sleepingCount: ranked.filter((p) => p.status === "sleeping").length,
      noDepositCount: ranked.filter((p) => p.status === "no_deposit").length,
    },
    segmentCounts,
    vipStopped: vipStopped.slice(0, 8),
    ranking: ranked.slice(0, 200),
  };
}

function enrichPlayer(player: DbPlayer, settings: GamificationSettings): GamificationPlayer {
  const total = Number(player.total_depositado ?? 0);
  const ftd = player.ftd_em;
  const lastDeposit = player.ultimo_deposito ?? ftd;
  const daysWithoutDeposit = daysSince(lastDeposit);
  const status: PlayerStatus =
    !ftd && total <= 0
      ? "no_deposit"
      : daysWithoutDeposit == null
        ? "no_deposit"
        : daysWithoutDeposit >= settings.sleepingAfterDays
          ? "sleeping"
          : daysWithoutDeposit >= settings.coolingAfterDays
            ? "cooling"
            : "active";

  return {
    id: player.id,
    nome: player.nome,
    player_external_id: player.player_external_id,
    total_depositado: total,
    total_sacado: Number(player.total_sacado ?? 0),
    ultimo_deposito: player.ultimo_deposito,
    ftd_em: player.ftd_em,
    telefone: player.telefone,
    email: player.email,
    level: levelFor(total, settings),
    status,
    daysWithoutDeposit,
  };
}

function normalizeSettingsInput(input: unknown): GamificationSettings {
  const value = (input ?? {}) as Partial<GamificationSettings> & {
    thresholds?: Partial<Record<PaidLevelSlug, unknown>>;
  };
  const thresholds = {
    ...DEFAULT_SETTINGS.thresholds,
    ...(value.thresholds ?? {}),
  };

  const clean: GamificationSettings = {
    thresholds: {
      bronze: toCurrency(thresholds.bronze),
      silver: toCurrency(thresholds.silver),
      gold: toCurrency(thresholds.gold),
      diamond: toCurrency(thresholds.diamond),
      black: toCurrency(thresholds.black),
    },
    coolingAfterDays: toInt(value.coolingAfterDays, DEFAULT_SETTINGS.coolingAfterDays),
    sleepingAfterDays: toInt(value.sleepingAfterDays, DEFAULT_SETTINGS.sleepingAfterDays),
    vipMinLevel: PAID_LEVELS.includes(value.vipMinLevel as PaidLevelSlug)
      ? (value.vipMinLevel as PaidLevelSlug)
      : DEFAULT_SETTINGS.vipMinLevel,
  };

  if (
    clean.thresholds.bronze < 0 ||
    clean.thresholds.silver <= clean.thresholds.bronze ||
    clean.thresholds.gold <= clean.thresholds.silver ||
    clean.thresholds.diamond <= clean.thresholds.gold ||
    clean.thresholds.black <= clean.thresholds.diamond
  ) {
    throw new Error(
      "As faixas precisam ser crescentes: Bronze < Prata < Ouro < Diamante < Black VIP.",
    );
  }

  if (clean.coolingAfterDays < 1) throw new Error("Esfriando precisa ser pelo menos 1 dia.");
  if (clean.sleepingAfterDays < clean.coolingAfterDays) {
    throw new Error("Dormindo precisa ser maior ou igual a Esfriando.");
  }

  return clean;
}

function levelFor(total: number, settings: GamificationSettings): LevelSlug {
  return levelForTotal(total, settings.thresholds);
}

function levelMin(level: LevelSlug, settings: GamificationSettings) {
  return level === "novice" ? 0 : settings.thresholds[level];
}

function levelRank(level: LevelSlug) {
  return LEVELS.findIndex((item) => item.slug === level);
}

function daysSince(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function toCurrency(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number * 100) / 100);
}

function toInt(value: unknown, fallback: number) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.floor(number));
}

function isMissingGamificationTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    String(error.message ?? "")
      .toLowerCase()
      .includes("gamification_settings")
  );
}
