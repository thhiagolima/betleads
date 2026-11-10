import type { TenantCurrency } from "@/lib/currency";

import { round2 } from "./calc";
import { profitComputable } from "./money";
import type {
  DayActivity,
  FinanceKpis,
  PeriodSummary,
  SendItem,
  SendLine,
  SendUsage,
  WaterfallStep,
} from "./types";

const SEND_ITEM_ORDER: SendItem[] = ["sms", "voice_30s", "email", "webpush", "webpush_lead"];

const SEND_ITEM_LABEL: Record<SendItem, string> = {
  sms: "SMS",
  voice_30s: "Voz",
  email: "E-mail",
  webpush: "Web Push (envio)",
  webpush_lead: "Web Push (lead)",
};

const SEND_ITEM_UNIT_LABEL: Record<SendItem, string> = {
  sms: "envios",
  voice_30s: "blocos de 30 s",
  email: "e-mails",
  webpush: "pushes",
  webpush_lead: "inscrições",
};

/**
 * Unit costs go below a cent (e-mail at R$ 0,0004), so they keep four
 * decimals; round2 would show them as R$ 0.
 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

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
        unitCost: usage.units > 0 && !missingCost ? round4(usage.amount / usage.units) : null,
        previousAmount: previous === null ? null : (previousByItem.get(item) ?? null),
        missingCost,
      },
    ];
  });
}

/** True when some send has units without a registered provider cost (its amount is partial). */
export function hasMissingSendCost(sends: SendUsage[] | undefined): boolean {
  return (sends ?? []).some((usage) => usage.missingCostUnits > 0);
}

/** Lucro líquido ÷ net; n.a. (null) when the net is zero or negative, or there is no Lucro líquido. */
export function marginOf(cashResult: number | null, net: number): number | null {
  return net > 0 && cashResult !== null ? cashResult / net : null;
}

/**
 * Pure KPIs for the period: the ratios of §... none of them ever Infinity/NaN.
 * `metaSpend` is the Meta spend (Σ adSpendSuggested) over the same houses and
 * days as `activity`: CPM and Custo por clique divide it, not Anúncios (which
 * may hold other networks the Meta impressions/clicks do not cover).
 * Fora do BRL (`currency`), os retornos do CRM (receita da casa ÷ envios em
 * BRL) ficam null: não há câmbio entre as duas moedas.
 */
export function computeKpis(
  summary: PeriodSummary,
  activity: DayActivity,
  sends: SendUsage[],
  days: number,
  metaSpend: number,
  currency?: TenantCurrency | null,
): FinanceKpis {
  const sendCost = round2(sends.reduce((total, usage) => total + usage.amount, 0));
  const sameCurrency = profitComputable(currency);

  const hasImpressions = activity.adImpressions > 0;
  const cpm = hasImpressions ? (metaSpend / activity.adImpressions) * 1000 : null;
  const ctr = hasImpressions ? ratio(activity.adClicks, activity.adImpressions) : null;
  const costPerClick = hasImpressions ? ratio(metaSpend, activity.adClicks) : null;

  return {
    depositCount: activity.depositCount,
    withdrawalCount: activity.withdrawalCount,
    margin: marginOf(summary.cashResult, summary.net),
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
    sendCostIncomplete: hasMissingSendCost(sends),
    crmDirectRevenue: activity.crmDirectRevenue,
    crmInfluencedRevenue: activity.crmInfluencedRevenue,
    crmDirectReturn: sameCurrency ? ratio(activity.crmDirectRevenue, sendCost) : null,
    crmInfluencedReturn: sameCurrency ? ratio(activity.crmInfluencedRevenue, sendCost) : null,
  };
}

/**
 * The net-to-profit waterfall: Depósitos (start) down through Saques, a Net
 * subtotal, the fees, Anúncios, Envios, Mensalidade (omitted when the window
 * has no closed-month fee) and one down step per other-cost category, ending
 * at Lucro líquido (total). Zero-amount down steps are omitted; the total's
 * `end` equals `summary.cashResult` when `sendCost` and `categories` are the
 * same figures that produced it (betleadsUsage and otherCosts); when the
 * categories do not add up to `summary.otherCosts`, one "Outros custos" step
 * (down, or up when they exceed it) carries the residual. A negative cost
 * (e.g. a negative GGR fee) raises the result, so its step is "up". With
 * `sendCostIncomplete` (some sends without a registered provider cost) the
 * Envios step reads "Envios (parcial)" and shows even at R$ 0.
 * Fora do BRL (`currency`) os passos em BRL (Envios, Mensalidade) saem do
 * gráfico e ele termina no subtotal "Antes dos custos Betleads" (key
 * "house_result"), na moeda da casa, em vez do Lucro líquido.
 */
export function waterfallSteps(
  summary: PeriodSummary,
  sendCost: number,
  categories: Record<string, number>,
  options: { sendCostIncomplete?: boolean; currency?: TenantCurrency | null } = {},
): WaterfallStep[] {
  const sameCurrency = profitComputable(options.currency);
  const steps: WaterfallStep[] = [];
  let running = summary.depositAmount;
  steps.push({ key: "deposits", label: "Depósitos", kind: "start", start: 0, end: running });

  const down = (key: string, label: string, amount: number, keepZero = false) => {
    if (amount === 0 && !keepZero) return;
    const start = running;
    running = round2(running - amount);
    steps.push({ key, label, kind: amount < 0 ? "up" : "down", start, end: running });
  };

  down("withdrawals", "Saques", summary.withdrawalAmount);

  steps.push({ key: "net", label: "Net", kind: "subtotal", start: running, end: running });

  down("ggr_fee", "Taxa de GGR", summary.ggrFee);
  down("movement_fee", "Taxa de movimentação", summary.movementFee);
  down("ad_spend", "Anúncios", summary.adSpend);
  // Envios e Mensalidade são BRL: ficam fora de um gráfico na moeda da casa.
  if (sameCurrency) {
    if (options.sendCostIncomplete) down("sends", "Envios (parcial)", sendCost, true);
    else down("sends", "Envios", sendCost);
    if (summary.betleadsFee !== null) {
      down("fee", "Mensalidade", summary.betleadsFee);
    }
  }
  let categorized = 0;
  for (const [name, amount] of Object.entries(categories)) {
    down(`category:${name}`, name, amount);
    categorized += amount;
  }

  // Whatever the categories leave of otherCosts (or exceed it by) is one
  // reconciling step, so the total always ends at cashResult.
  const residual = round2(summary.otherCosts - categorized);
  if (Math.abs(residual) > 0.005) {
    const start = running;
    running = round2(running - residual);
    steps.push({
      key: "other_costs",
      label: "Outros custos",
      kind: residual > 0 ? "down" : "up",
      start,
      end: running,
    });
  }

  steps.push(
    sameCurrency
      ? { key: "profit", label: "Lucro líquido", kind: "total", start: running, end: running }
      : {
          key: "house_result",
          label: "Antes dos custos Betleads",
          kind: "subtotal",
          start: running,
          end: running,
        },
  );

  return steps;
}
