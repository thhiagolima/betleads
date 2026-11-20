// API de leitura: serie_diaria (docs/superpowers/specs/2026-11-20-api-leitura-design.md §6).
// One row per house per day for up to 366 days, for BI-sized pulls. Reads the
// same daily sources as the finance panel once for the whole period
// (finance_days with the monthly GGR split exactly like the panel, plus
// finance_send_usage and finance_activity_days), so a day here equals that
// day in the panel. Permission is the finance panel's own (resolveScope).
import { z } from "zod";

import { resolveScope } from "@/lib/finance-dashboard.functions";
import {
  clampToToday,
  fetchActivityDays,
  fetchFinanceDays,
  fetchMonthlyGgr,
  fetchSendUsage,
  financeDaysWithMonthlyGgr,
  num,
  sendUsageTotal,
  sumSendUsage,
  todaySaoPaulo,
  type ActivityDayRow,
  type SendUsageRow,
} from "@/lib/finance/finance-data.server";
import type { McpIdentity } from "@/lib/mcp/access.server";
import { escopoInput, periodoInput, toRangeAndPreset } from "@/lib/mcp/inputs.server";
import { toDashboardScope } from "@/lib/mcp/read-tools.server";

/** Most days one serie_diaria call may cover. */
export const MAX_DIAS_SERIE = 366;

export const serieDiariaInput = z.object({
  escopo: escopoInput,
  periodo: periodoInput.describe(
    `{preset: today|yesterday|7d|month} ou {inicio, fim} (AAAA-MM-DD), dias no horário de Brasília; até ${MAX_DIAS_SERIE} dias, e dias depois de hoje ficam de fora.`,
  ),
});

export type SerieDiariaLinha = {
  data: string;
  casa_id: string;
  cadastros: number;
  ftds: number;
  valor_ftds: number;
  valor_depositado: number;
  valor_sacado: number;
  depositos: number;
  depositantes: number;
  saques: number;
  /** null while the day has no ad spend entered. */
  anuncios: number | null;
  /** null while the day has no GGR. */
  ggr: number | null;
  /** True when ggr is the day's share of the month's accumulated GGR. */
  ggr_estimado: boolean;
  net: number;
  taxa_ggr: number;
  taxa_movimentacao: number;
  /** Anúncios or GGR still missing (they count as 0 in net). */
  pendente: boolean;
  crm_enviados: number;
  crm_cliques: number;
  crm_conversoes_diretas: number;
  crm_receita_direta: number;
  /** Always BRL. */
  custo_envios_brl: number;
};

const DAY_MS = 86_400_000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const monthStartOf = (day: string) => `${day.slice(0, 7)}-01`;
function lastDayOfMonth(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

export async function serieDiaria(
  identity: McpIdentity,
  args: unknown,
  now: Date = new Date(),
) {
  const input = serieDiariaInput.parse(args);
  const { range: asked } = toRangeAndPreset(input.periodo, now);
  if (asked.from > asked.to) throw new Error("Período inválido: o início é depois do fim.");
  const today = todaySaoPaulo();
  const range = clampToToday(asked, today);
  if (!range) throw new Error("O período começa depois de hoje.");
  if (daysBetween(range.from, range.to) > MAX_DIAS_SERIE) {
    throw new Error(`No máximo ${MAX_DIAS_SERIE} dias por chamada. Divida o período.`);
  }

  const { label, tenants } = await resolveScope(identity.userId, toDashboardScope(input.escopo));
  const ids = tenants.map((tenant) => tenant.id);
  const casas = tenants
    .map((tenant) => ({ id: tenant.id, nome: tenant.nome, moeda: tenant.moeda }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const periodo = { inicio: range.from, fim: range.to };
  if (!ids.length) return { rotulo: label, periodo, casas, linhas: [] as SerieDiariaLinha[] };

  // A month's accumulated GGR is split over every day of that month (as in
  // the panel), so the days are read from the first month's 1st to the last
  // month's end (or today), and only the asked days are returned.
  const daysSpan = {
    from: monthStartOf(range.from),
    to: lastDayOfMonth(range.to) > today ? today : lastDayOfMonth(range.to),
  };
  const [dayRows, monthlyRows, sendRows, activityRows] = await Promise.all([
    fetchFinanceDays(ids, daysSpan),
    fetchMonthlyGgr(ids, monthStartOf(range.from), monthStartOf(range.to)),
    fetchSendUsage(ids, range),
    fetchActivityDays(ids, range),
  ]);

  const key = (tenantId: string, day: string) => `${tenantId}|${day}`;
  const sendByKey = new Map<string, SendUsageRow[]>();
  for (const row of sendRows as SendUsageRow[]) {
    const k = key(row.tenant_id, row.metric_date);
    const list = sendByKey.get(k) ?? [];
    list.push(row);
    sendByKey.set(k, list);
  }
  const activityByKey = new Map<string, ActivityDayRow>();
  for (const row of activityRows as ActivityDayRow[]) {
    activityByKey.set(key(row.tenant_id, row.metric_date), row);
  }

  const linhas: SerieDiariaLinha[] = financeDaysWithMonthlyGgr(dayRows, monthlyRows)
    .filter(({ day }) => day.date >= range.from && day.date <= range.to)
    .map(({ tenantId, day }) => {
      const k = key(tenantId, day.date);
      const activity = activityByKey.get(k);
      const sends = sendByKey.get(k);
      return {
        data: day.date,
        casa_id: tenantId,
        cadastros: day.registrations,
        ftds: day.ftds,
        valor_ftds: round2(day.ftdDepositAmount),
        valor_depositado: round2(day.depositAmount),
        valor_sacado: round2(day.withdrawalAmount),
        depositos: num(activity?.deposit_count),
        depositantes: num(activity?.depositor_count),
        saques: num(activity?.withdrawal_count),
        anuncios: day.adSpend,
        ggr: day.ggr == null ? null : round2(day.ggr),
        ggr_estimado: day.ggrEstimated,
        net: round2(day.net),
        taxa_ggr: round2(day.ggrFee),
        taxa_movimentacao: round2(day.movementFee),
        pendente: day.pending,
        crm_enviados: num(activity?.crm_sent),
        crm_cliques: num(activity?.crm_clicks),
        crm_conversoes_diretas: num(activity?.crm_direct_conversions),
        crm_receita_direta: round2(num(activity?.crm_direct_revenue)),
        custo_envios_brl: sends ? round2(sendUsageTotal(sumSendUsage(sends))) : 0,
      };
    })
    .sort((a, b) => (a.data === b.data ? a.casa_id.localeCompare(b.casa_id) : a.data < b.data ? -1 : 1));

  return { rotulo: label, periodo, casas, linhas };
}
