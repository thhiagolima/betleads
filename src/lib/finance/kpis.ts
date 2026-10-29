import { round2 } from "./calc";
import type { DayActivity, FinanceKpis, PeriodSummary, SendItem, SendLine, SendUsage, WaterfallStep } from "./types";

const SEND_ITEM_ORDER: SendItem[] = ["sms", "voice_30s", "email"];

const SEND_ITEM_LABEL: Record<SendItem, string> = {
  sms: "SMS",
  voice_30s: "Voz",
  email: "E-mail",
};

const SEND_ITEM_UNIT_LABEL: Record<SendItem, string> = {
  sms: "envios",
  voice_30s: "blocos de 30 s",
  email: "e-mails",
};

/** A ratio whose denominator is 0 is null, never Infinity or NaN. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Sums a list of DayActivity (one per day) into the window's totals. */
export function sumActivity(days: DayActivity[]): DayActivity {
  const sum = (pick: (d: DayActivity) => number) =>
    days.reduce((total, day) => total + pick(day), 0);

  return {
    depositCount: sum((d) => d.depositCount),
    depositorCount: sum((d) => d.depositorCount),
    withdrawalCount: sum((d) => d.withdrawalCount),
    generatedPixCount: sum((d) => d.generatedPixCount),
    crmSent: sum((d) => d.crmSent),
    crmClicks: sum((d) => d.crmClicks),
    crmDirectConversions: sum((d) => d.crmDirectConversions),
    crmDirectRevenue: round2(sum((d) => d.crmDirectRevenue)),
    crmInfluencedRevenue: round2(sum((d) => d.crmInfluencedRevenue)),
    adImpressions: sum((d) => d.adImpressions),
    adClicks: sum((d) => d.adClicks),
  };
}

/**
 * One send line per channel present in `current`, ordered SMS, Voz, E-mail.
 * `unitCost` is amount / units when units > 0 and the channel's provider
 * cost is not missing; a channel with missing provider cost is flagged
 * (`missingCost`) and never shown with a real unit cost of R$ 0.
 */
export function sendLines(current: SendUsage[], previous: SendUsage[] | null): SendLine[] {
  const previousByItem = new Map((previous ?? []).map((usage) => [usage.item, usage.amount]));

  return SEND_ITEM_ORDER.flatMap((item) => {
    const usage = current.find((u) => u.item === item);
    if (!usage) return [];

    const missingCost = usage.missingCostUnits > 0;
    return [
      {
        item,
        label: SEND_ITEM_LABEL[item],
        unitLabel: SEND_ITEM_UNIT_LABEL[item],
        units: usage.units,
        amount: usage.amount,
        unitCost: usage.units > 0 && !missingCost ? round2(usage.amount / usage.units) : null,
        previousAmount: previous === null ? null : previousByItem.get(item) ?? null,
        missingCost,
      },
    ];
  });
}

/** Pure KPIs for the period: the ratios of §... none of them ever Infinity/NaN. */
export function computeKpis(
  summary: PeriodSummary,
  activity: DayActivity,
  sends: SendUsage[],
  days: number,
): FinanceKpis {
  const sendCost = round2(sends.reduce((total, usage) => total + usage.amount, 0));

  const hasImpressions = activity.adImpressions > 0;
  const cpm = hasImpressions ? (summary.adSpend / activity.adImpressions) * 1000 : null;
  const ctr = hasImpressions ? ratio(activity.adClicks, activity.adImpressions) : null;
  const costPerClick = hasImpressions ? ratio(summary.adSpend, activity.adClicks) : null;

  return {
    margin: ratio(summary.cashResult, summary.net),
    ticketMedio: ratio(summary.depositAmount, activity.depositCount),
    saqueMedio: ratio(summary.withdrawalAmount, activity.withdrawalCount),
    depositorsPerDay: days === 0 ? null : activity.depositorCount / days,
    withdrawalShare: ratio(summary.withdrawalAmount, summary.depositAmount),
    pixConversion: ratio(activity.depositCount, activity.generatedPixCount),
    registrationToFtd: ratio(summary.ftds, summary.registrations),
    ftdMedio: ratio(summary.ftdDepositAmount, summary.ftds),
    ggrShareOfDeposits: ratio(summary.ggr, summary.depositAmount),
    cpm,
    ctr,
    costPerClick,
    sendCost,
    crmDirectRevenue: activity.crmDirectRevenue,
    crmInfluencedRevenue: activity.crmInfluencedRevenue,
    crmDirectReturn: ratio(activity.crmDirectRevenue, sendCost),
    crmInfluencedReturn: ratio(activity.crmInfluencedRevenue, sendCost),
  };
}

/**
 * The net-to-profit waterfall: Depósitos (start) down through Saques, a Net
 * subtotal, the fees, Anúncios, Envios, Mensalidade (omitted when the window
 * has no closed-month fee) and one down step per other-cost category, ending
 * at Lucro líquido (total). Zero-amount down steps are omitted; the total's
 * `end` equals `summary.cashResult` when `sendCost` and `categories` are the
 * same figures that produced it (betleadsUsage and otherCosts).
 */
export function waterfallSteps(
  summary: PeriodSummary,
  sendCost: number,
  categories: Record<string, number>,
): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = summary.depositAmount;
  steps.push({ key: "deposits", label: "Depósitos", kind: "start", start: 0, end: running });

  const down = (key: string, label: string, amount: number) => {
    if (amount === 0) return;
    const start = running;
    running = round2(running - amount);
    steps.push({ key, label, kind: "down", start, end: running });
  };

  down("withdrawals", "Saques", summary.withdrawalAmount);

  steps.push({ key: "net", label: "Net", kind: "subtotal", start: running, end: running });

  down("ggr_fee", "Taxa de GGR", summary.ggrFee);
  down("movement_fee", "Taxa de movimentação", summary.movementFee);
  down("ad_spend", "Anúncios", summary.adSpend);
  down("sends", "Envios", sendCost);
  if (summary.betleadsFee !== null) {
    down("fee", "Mensalidade", summary.betleadsFee);
  }
  for (const [name, amount] of Object.entries(categories)) {
    down(`category:${name}`, name, amount);
  }

  steps.push({ key: "profit", label: "Lucro líquido", kind: "total", start: running, end: running });

  return steps;
}
