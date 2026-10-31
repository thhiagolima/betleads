// Formato do overview de Aquisição e LTV, devolvido pela RPC marketing_overview
// (supabase/migrations/20261019100000_aquisicao_ltv_al1.sql). Compartilhado entre o
// servidor e a tela para que os dois não divirjam.

export type SpendByCurrency = { currency: string; spend: number };

export type MarketingTotals = {
  /** Gasto em BRL. Contas em outra moeda ficam em spendOther e não entram nas razões. */
  spend: number;
  spendOther: SpendByCurrency[];
  impressions: number;
  clicks: number;
  linkClicks: number;
  /** Cadastros do período (todas as origens). */
  players: number;
  /** FTDs da casa no período (todas as origens). */
  ftd: number;
  /** Cadastros e FTDs atribuídos a anúncio ou campanha. */
  paidPlayers: number;
  paidFtd: number;
  markedPlayers: number;
  orphanPlayers: number;
  /** Depósitos aprovados dos jogadores pagos dentro do período. */
  revenue: number;
  withdrawals: number;
  /** revenue - withdrawals. */
  net: number;
  ftdRevenue: number;
  redepositRevenue: number;
  /** net / spend. */
  roas: number | null;
  /** revenue / spend. */
  roasGross: number | null;
  /** spend / paidFtd. */
  cpaFtd: number | null;
  /** spend / paidPlayers. */
  cacSignup: number | null;
};

export type AttributionHealth = {
  total: number;
  marked: number;
  matched: number;
  missingUtm: number;
  crm: number;
  ambiguous: number;
  orphan: number;
  pending: number;
  matchRate: number | null;
};

type BusinessColumns = {
  players: number;
  ftd: number;
  revenue: number;
  net: number;
};

export type CreativeRow = BusinessColumns & {
  creative: string;
  campaign: string | null;
  campaign_id: string | null;
  adset: string | null;
  ad_id: string | null;
  thumbnail_url: string | null;
  spend: number;
  spendOther: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  ftdRevenue: number;
  redepositRevenue: number;
};

export type CampaignRow = BusinessColumns & {
  campaign: string;
  campaign_id: string | null;
  match_status: "matched_campaign" | "no_spend";
  spend: number;
  spendOther: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  ftdRevenue: number;
  redepositRevenue: number;
};

export type AudienceRow = BusinessColumns & {
  adset: string;
  spend: number;
  ads: number;
  impressions: number;
  clicks: number;
};

export type OthersRow = Partial<BusinessColumns> & {
  count: number;
  spend: number;
  impressions?: number;
  clicks?: number;
  linkClicks?: number;
};

export type OrphanAttributionRow = {
  campaign: string;
  creative: string;
  adset: string | null;
  source: string | null;
  provider: string | null;
  ambiguous: boolean;
  players: number;
  ftd: number;
  revenue: number;
};

export type DailyPoint = {
  date: string;
  label: string;
  spend: number;
  ftd: number;
  signups: number;
};

export type MoneyRow = {
  creative: string;
  campaign: string | null;
  thumbnail_url: string | null;
  revenue: number;
  share: number;
};

/** MB4-04: presente quando o overview foi filtrado por contas de anúncio. */
export type MarketingOverviewFilter = {
  ad_account_ids: string[];
  players_scope: "matched_only";
};

export type MarketingOverviewRpc = {
  period: { from: string; to: string };
  totals: MarketingTotals;
  attributionHealth: AttributionHealth;
  creatives: CreativeRow[];
  creativesOthers: OthersRow;
  campaigns: CampaignRow[];
  campaignsOthers: OthersRow;
  audiences: AudienceRow[];
  audiencesOthers: OthersRow;
  orphanAttributions: OrphanAttributionRow[];
  daily: DailyPoint[];
  filter?: MarketingOverviewFilter | null;
};

export type MarketingOverview = MarketingOverviewRpc & {
  moneyMap: MoneyRow[];
  filter: MarketingOverviewFilter | null;
};

/** Normaliza números (o Postgres devolve numeric como número ou texto) e calcula o mapa de receita. */
export function buildMarketingOverview(raw: MarketingOverviewRpc): MarketingOverview {
  const num = (value: unknown) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const nullableNum = (value: unknown) => (value == null ? null : num(value));
  const numbers = <T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T => {
    const out = { ...row };
    for (const key of keys) out[key] = num(row[key]) as T[keyof T];
    return out;
  };

  const t = raw.totals;
  const totals: MarketingTotals = {
    ...numbers(t, [
      "spend",
      "impressions",
      "clicks",
      "linkClicks",
      "players",
      "ftd",
      "paidPlayers",
      "paidFtd",
      "markedPlayers",
      "orphanPlayers",
      "revenue",
      "withdrawals",
      "net",
      "ftdRevenue",
      "redepositRevenue",
    ]),
    spendOther: (t.spendOther ?? []).map((row) => ({
      currency: row.currency,
      spend: num(row.spend),
    })),
    roas: nullableNum(t.roas),
    roasGross: nullableNum(t.roasGross),
    cpaFtd: nullableNum(t.cpaFtd),
    cacSignup: nullableNum(t.cacSignup),
  };

  const business = ["players", "ftd", "revenue", "net"] as const;
  const creatives = (raw.creatives ?? []).map((row) =>
    numbers(row, [
      ...business,
      "spend",
      "spendOther",
      "impressions",
      "clicks",
      "linkClicks",
      "ftdRevenue",
      "redepositRevenue",
    ]),
  );
  const campaigns = (raw.campaigns ?? []).map((row) =>
    numbers(row, [
      ...business,
      "spend",
      "spendOther",
      "impressions",
      "clicks",
      "linkClicks",
      "ftdRevenue",
      "redepositRevenue",
    ]),
  );
  const audiences = (raw.audiences ?? []).map((row) =>
    numbers(row, [...business, "spend", "ads", "impressions", "clicks"]),
  );
  const others = (row: OthersRow | null | undefined): OthersRow => {
    const out: OthersRow = { count: 0, spend: 0 };
    for (const [key, value] of Object.entries(row ?? {})) {
      (out as Record<string, number>)[key] = num(value);
    }
    return out;
  };

  const revenue = creatives.reduce((sum, row) => sum + row.revenue, 0);
  const moneyMap = creatives
    .filter((row) => row.revenue > 0)
    .map((row): MoneyRow => ({
      creative: row.creative,
      campaign: row.campaign,
      thumbnail_url: row.thumbnail_url,
      revenue: row.revenue,
      share: revenue > 0 ? (row.revenue / revenue) * 100 : 0,
    }));

  const h = raw.attributionHealth;
  return {
    period: raw.period,
    totals,
    attributionHealth: {
      ...numbers(h, [
        "total",
        "marked",
        "matched",
        "missingUtm",
        "crm",
        "ambiguous",
        "orphan",
        "pending",
      ]),
      matchRate: nullableNum(h.matchRate),
    },
    creatives,
    creativesOthers: others(raw.creativesOthers),
    campaigns,
    campaignsOthers: others(raw.campaignsOthers),
    audiences,
    audiencesOthers: others(raw.audiencesOthers),
    orphanAttributions: (raw.orphanAttributions ?? []).map((row) =>
      numbers(row, ["players", "ftd", "revenue"]),
    ),
    daily: (raw.daily ?? []).map((row) => numbers(row, ["spend", "ftd", "signups"])),
    moneyMap,
    filter: raw.filter
      ? {
          ad_account_ids: [...(raw.filter.ad_account_ids ?? [])],
          players_scope: "matched_only",
        }
      : null,
  };
}

export type PeriodPreset = "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month";

function brtKey(at: Date) {
  // Brasília é UTC-3 fixo (sem horário de verão desde 2019), como em src/lib/tz.ts.
  return new Date(at.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** Soma dias a uma data YYYY-MM-DD do calendário. */
export function addDays(key: string, days: number) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Quantidade de dias de um período, contando as duas pontas. */
export function periodDays(from: string, to: string) {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** Período de um preset no calendário de Brasília. Depois das 21h, "hoje" continua sendo hoje. */
export function brtPeriodRange(preset: PeriodPreset, now: Date = new Date()) {
  const today = brtKey(now);
  const [year, month] = today.split("-").map(Number);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  let from = today;
  let to = today;
  if (preset === "yesterday") from = to = addDays(today, -1);
  else if (preset === "7d") from = addDays(today, -6);
  else if (preset === "30d") from = addDays(today, -29);
  else if (preset === "this_month") from = firstOfMonth;
  else if (preset === "last_month") {
    to = addDays(firstOfMonth, -1);
    from = `${year - (month === 1 ? 1 : 0)}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}-01`;
  }
  return { from, to, days: periodDays(from, to) };
}

/** Hoje (YYYY-MM-DD) em Brasília. */
export function brtToday(now: Date = new Date()) {
  return brtKey(now);
}

const PERIOD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

/** Valida o período da tela (datas do calendário de Brasília). */
export function parseOverviewPeriod(from: unknown, to: unknown) {
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !PERIOD.test(from) ||
    !PERIOD.test(to)
  ) {
    throw new Error("Período inválido.");
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const real = (key: string, time: number) => new Date(time).toISOString().slice(0, 10) === key;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !real(from, start) || !real(to, end)) {
    throw new Error("Período inválido.");
  }
  if (start > end) {
    throw new Error("Período inválido.");
  }
  if ((end - start) / 86_400_000 > MAX_DAYS) {
    throw new Error("O período máximo é de 1 ano.");
  }
  return { from, to };
}
