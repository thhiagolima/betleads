// Central de Resultados (F2): pure aggregation of crm_results_daily rows.
// Direct (click) and influenced (recovered) are separate levels, never summed.
// The click conversion is the headline measure (client, 16/10). Since
// rule_version 3 it only counts players who were not already active at the
// click (docs/AUDITORIA_NUMEROS_RESULTADOS_CRM_2026-10-19.md).

export type CrmResultRow = {
  metric_date: string;
  source_type: "journey" | "campaign" | "other";
  source_key: string;
  source_id: string | null;
  step_position: number;
  player_state: string;
  sent: number;
  failed: number;
  cost: number;
  recipients: number;
  human_clicks: number;
  /** Clicked SMS that brought a deposit of a non-active player (cohort of the click). */
  converted_clicks?: number;
  direct_conversions: number;
  /** Players converted by a click, on the day of their first deposit from it. */
  direct_players?: number;
  direct_revenue: number;
  /** Deposits after a click of players already active: never in the return. */
  direct_active_conversions?: number;
  direct_active_players?: number;
  direct_active_revenue?: number;
  influenced_players: number;
  influenced_deposits: number;
  influenced_revenue: number;
};

export type CrmMetrics = {
  sent: number;
  failed: number;
  cost: number;
  recipients: number;
  humanClicks: number;
  convertedClicks: number;
  directConversions: number;
  directPlayers: number;
  directRevenue: number;
  directActivePlayers: number;
  directActiveRevenue: number;
  influencedPlayers: number;
  influencedDeposits: number;
  influencedRevenue: number;
};

export type CrmMetricsWithRatios = CrmMetrics & {
  /** Clicked SMS / SMS sent. */
  clickRate: number | null;
  /** Converted clicked SMS / clicked SMS (same clicks, up to 7 days to deposit). */
  conversionRate: number | null;
  /** Cost per converted player; null when nobody converted. */
  costPerConversion: number | null;
  /** Click revenue / cost; null without cost. */
  clickRoi: number | null;
  /** Fewer than MIN_CONVERSIONS converted players: ratios are not reliable. */
  smallSample: boolean;
  /** Cost per influenced player; null when nobody was recovered. */
  costPerRecovered: number | null;
  /** Influenced revenue / cost; null without cost. */
  roi: number | null;
  /** Influenced players / recipients. */
  recoveryRate: number | null;
};

/** Below this many converted players a return is shown as "amostra pequena". */
export const MIN_CONVERSIONS = 5;

export const PLAYER_STATE_LABELS: Record<string, string> = {
  sem_ftd: "Sem 1º depósito",
  ativo: "Ativo (< 2 dias)",
  esfriando: "Esfriando (2–7 dias)",
  dormindo: "Dormindo (7–30 dias)",
  perdido: "Perdido (30+ dias)",
  sem_historico: "Sem histórico",
  desconhecido: "Sem jogador",
};

/** States in which a deposit can be a recovery; sends to others are not aimed at recovery. */
export const RECOVERABLE_STATES = new Set(["sem_ftd", "esfriando", "dormindo", "perdido"]);

const empty = (): CrmMetrics => ({
  sent: 0,
  failed: 0,
  cost: 0,
  recipients: 0,
  humanClicks: 0,
  convertedClicks: 0,
  directConversions: 0,
  directPlayers: 0,
  directRevenue: 0,
  directActivePlayers: 0,
  directActiveRevenue: 0,
  influencedPlayers: 0,
  influencedDeposits: 0,
  influencedRevenue: 0,
});

function add(target: CrmMetrics, row: CrmResultRow) {
  target.sent += Number(row.sent) || 0;
  target.failed += Number(row.failed) || 0;
  target.cost += Number(row.cost) || 0;
  target.recipients += Number(row.recipients) || 0;
  target.humanClicks += Number(row.human_clicks) || 0;
  target.convertedClicks += Number(row.converted_clicks) || 0;
  target.directConversions += Number(row.direct_conversions) || 0;
  target.directPlayers += Number(row.direct_players) || 0;
  target.directRevenue += Number(row.direct_revenue) || 0;
  target.directActivePlayers += Number(row.direct_active_players) || 0;
  target.directActiveRevenue += Number(row.direct_active_revenue) || 0;
  target.influencedPlayers += Number(row.influenced_players) || 0;
  target.influencedDeposits += Number(row.influenced_deposits) || 0;
  target.influencedRevenue += Number(row.influenced_revenue) || 0;
}

export function withRatios(metrics: CrmMetrics): CrmMetricsWithRatios {
  return {
    ...metrics,
    clickRate: metrics.sent > 0 ? metrics.humanClicks / metrics.sent : null,
    conversionRate: metrics.humanClicks > 0 ? metrics.convertedClicks / metrics.humanClicks : null,
    costPerConversion: metrics.directPlayers > 0 ? metrics.cost / metrics.directPlayers : null,
    clickRoi: metrics.cost > 0 ? metrics.directRevenue / metrics.cost : null,
    smallSample: metrics.directPlayers < MIN_CONVERSIONS,
    costPerRecovered:
      metrics.influencedPlayers > 0 ? metrics.cost / metrics.influencedPlayers : null,
    roi: metrics.cost > 0 ? metrics.influencedRevenue / metrics.cost : null,
    recoveryRate: metrics.recipients > 0 ? metrics.influencedPlayers / metrics.recipients : null,
  };
}

/** Distinct players of the whole period (crm_click_players_period). */
export type PeriodPlayers = { converted: number; active: number };

/**
 * Period totals with distinct players: the daily rows count a player once per
 * day, origin and SMS, so their sum can pass the real number of people.
 */
export function withPeriodPlayers<T extends CrmMetricsWithRatios>(
  totals: T,
  players: PeriodPlayers | null,
): T {
  if (!players) return totals;
  return {
    ...totals,
    ...withRatios({
      ...totals,
      directPlayers: players.converted,
      directActivePlayers: players.active,
    }),
  };
}

export type CrmSource = CrmMetricsWithRatios & {
  key: string;
  type: CrmResultRow["source_type"];
  sourceId: string | null;
  name: string;
  /** Cost spent on players who were already active (not a recovery target). */
  costOnActive: number;
  steps: Array<CrmMetricsWithRatios & { position: number }>;
};

export type CrmResults = {
  totals: CrmMetricsWithRatios & { costOnActive: number };
  daily: Array<{ date: string; cost: number; influencedRevenue: number; directRevenue: number }>;
  sources: CrmSource[];
  states: Array<CrmMetricsWithRatios & { state: string; label: string }>;
};

/**
 * Aggregates daily rows into totals, a daily series, a ranking by origin (with
 * its journey steps) and a view by player state at send.
 */
export function aggregateCrmResults(
  rows: CrmResultRow[],
  names: Record<string, string> = {},
): CrmResults {
  const totals = empty();
  let totalCostOnActive = 0;
  const daily = new Map<
    string,
    { cost: number; influencedRevenue: number; directRevenue: number }
  >();
  const sources = new Map<
    string,
    {
      metrics: CrmMetrics;
      costOnActive: number;
      type: CrmResultRow["source_type"];
      sourceId: string | null;
      key: string;
      steps: Map<number, CrmMetrics>;
    }
  >();
  const states = new Map<string, CrmMetrics>();

  for (const row of rows) {
    add(totals, row);
    const onActive = row.player_state === "ativo" ? Number(row.cost) || 0 : 0;
    totalCostOnActive += onActive;

    const day = daily.get(row.metric_date) ?? { cost: 0, influencedRevenue: 0, directRevenue: 0 };
    day.cost += Number(row.cost) || 0;
    day.influencedRevenue += Number(row.influenced_revenue) || 0;
    day.directRevenue += Number(row.direct_revenue) || 0;
    daily.set(row.metric_date, day);

    const sourceKey = `${row.source_type}:${row.source_key}`;
    const source = sources.get(sourceKey) ?? {
      metrics: empty(),
      costOnActive: 0,
      type: row.source_type,
      sourceId: row.source_id,
      key: row.source_key,
      steps: new Map<number, CrmMetrics>(),
    };
    add(source.metrics, row);
    source.costOnActive += onActive;
    source.sourceId = source.sourceId ?? row.source_id;
    const step = source.steps.get(row.step_position) ?? empty();
    add(step, row);
    source.steps.set(row.step_position, step);
    sources.set(sourceKey, source);

    const state = states.get(row.player_state) ?? empty();
    add(state, row);
    states.set(row.player_state, state);
  }

  return {
    totals: { ...withRatios(totals), costOnActive: totalCostOnActive },
    daily: [...daily.entries()]
      .map(([date, value]) => ({ date, ...value }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    sources: [...sources.values()]
      .map((source) => ({
        ...withRatios(source.metrics),
        key: source.key,
        type: source.type,
        sourceId: source.sourceId,
        name: (source.sourceId && names[source.sourceId]) || source.key,
        costOnActive: source.costOnActive,
        steps: [...source.steps.entries()]
          .map(([position, metrics]) => ({ position, ...withRatios(metrics) }))
          .sort((a, b) => a.position - b.position),
      }))
      .sort(
        (a, b) =>
          b.directRevenue - a.directRevenue ||
          b.influencedRevenue - a.influencedRevenue ||
          b.cost - a.cost,
      ),
    states: [...states.entries()]
      .map(([state, metrics]) => ({
        state,
        label: PLAYER_STATE_LABELS[state] ?? state,
        ...withRatios(metrics),
      }))
      .sort((a, b) => b.sent - a.sent),
  };
}

export type JourneyStepInfo = {
  position: number;
  step_type: string;
  is_enabled: boolean;
  config: unknown;
};

const CHANNEL_LABEL: Record<string, string> = {
  email: "e-mail",
  whatsapp: "WhatsApp",
  voice: "voz",
  call: "voz",
};

function delayLabel(seconds: number) {
  if (seconds <= 0) return "na entrada";
  const hours = seconds / 3600;
  if (hours < 24) return `+${Math.round(hours)} h`;
  const days = hours / 24;
  return `+${Number.isInteger(days) ? days : days.toFixed(1).replace(".", ",")} dia${days === 1 ? "" : "s"}`;
}

/**
 * Readable names for a journey's sending steps: "1ª mensagem · na entrada",
 * "2ª mensagem · +2 dias". Waits do not get a number, so the messages are
 * counted 1, 2, 3 instead of the raw positions 0, 2, 4.
 */
export function stepLabels(steps: JourneyStepInfo[]): Record<number, string> {
  const labels: Record<number, string> = {};
  let elapsed = 0;
  let message = 0;
  for (const step of [...steps].sort((a, b) => a.position - b.position)) {
    if (!step.is_enabled || step.step_type === "end") continue;
    if (step.step_type === "wait") {
      const config = (step.config ?? {}) as { delay_seconds?: unknown };
      elapsed += Number(config.delay_seconds ?? 0) || 0;
      continue;
    }
    message += 1;
    const channel = CHANNEL_LABEL[step.step_type];
    labels[step.position] =
      `${message}ª mensagem · ${delayLabel(elapsed)}${channel ? ` · ${channel}` : ""}`;
  }
  return labels;
}

export type HoldoutGroup = { players: number; returned: number; revenue: number };

export type HoldoutComparison = {
  treatedRate: number | null;
  controlRate: number | null;
  /** Treated rate minus control rate (percentage points as a fraction). */
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** The 95% interval excludes zero. */
  significant: boolean;
  /** Enough players and returns in both groups to read the result. */
  sufficient: boolean;
  /** Extra returns attributable to the journey: lift x treated players. */
  incrementalPlayers: number | null;
  /** Extra revenue: (revenue per treated - revenue per control) x treated players. */
  incrementalRevenue: number | null;
};

/** Minimum per group before a holdout result is shown as readable (R-04). */
export const HOLDOUT_MIN_PLAYERS = 100;
export const HOLDOUT_MIN_RETURNS = 10;

/**
 * Two-proportion comparison of the 7-day return of players who received the
 * journey (treated) against the control group, with a 95% normal interval.
 */
export function compareHoldout(treated: HoldoutGroup, control: HoldoutGroup): HoldoutComparison {
  const rate = (group: HoldoutGroup) => (group.players > 0 ? group.returned / group.players : null);
  const treatedRate = rate(treated);
  const controlRate = rate(control);
  const sufficient =
    treated.players >= HOLDOUT_MIN_PLAYERS &&
    control.players >= HOLDOUT_MIN_PLAYERS &&
    treated.returned + control.returned >= HOLDOUT_MIN_RETURNS;
  if (treatedRate == null || controlRate == null) {
    return {
      treatedRate,
      controlRate,
      lift: null,
      ciLow: null,
      ciHigh: null,
      significant: false,
      sufficient: false,
      incrementalPlayers: null,
      incrementalRevenue: null,
    };
  }
  const lift = treatedRate - controlRate;
  const se = Math.sqrt(
    (treatedRate * (1 - treatedRate)) / treated.players +
      (controlRate * (1 - controlRate)) / control.players,
  );
  const ciLow = lift - 1.96 * se;
  const ciHigh = lift + 1.96 * se;
  return {
    treatedRate,
    controlRate,
    lift,
    ciLow,
    ciHigh,
    significant: sufficient && (ciLow > 0 || ciHigh < 0),
    sufficient,
    incrementalPlayers: lift * treated.players,
    incrementalRevenue:
      (treated.revenue / treated.players - control.revenue / control.players) * treated.players,
  };
}
