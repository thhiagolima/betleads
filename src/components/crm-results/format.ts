import type { CrmSource } from "@/lib/crm-results";
import type { getCrmResults } from "@/lib/crm-results.functions";
import { formatMoney, toTenantCurrency, type TenantCurrency } from "@/lib/currency";
import { brl } from "@/lib/format";

export type Data = Awaited<ReturnType<typeof getCrmResults>>;

const decimal = (value: number, digits: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Percent with 1 decimal, or 2 below 1% so 0,47% does not become 0,5%. */
export const pct = (value: number | null) =>
  value == null ? "—" : `${decimal(value * 100, Math.abs(value) < 0.01 ? 2 : 1)}%`;
export const ratio = (value: number | null) => (value == null ? "—" : `${decimal(value, 1)}x`);
/** Return as "R$ 7,90" (deposits brought by each R$ 1 of SMS), easier to read than "7,9x". */
export const perReal = (value: number | null) => (value == null ? "—" : brl(value));
/** Custo da plataforma (SMS), sempre em BRL. */
export const cost = (value: number | null) => (value == null ? "—" : brl(value));
/** Valor da casa (depósitos, receita recuperada) na moeda dela. */
export const money = (value: number | null, currency: TenantCurrency | string) =>
  value == null ? "—" : formatMoney(value, currency);

/**
 * Receita da casa em moeda local e custo em BRL: sem câmbio, a razão entre os
 * dois (retorno) não tem sentido. Só se calcula quando a casa opera em BRL.
 */
export const isCrossCurrency = (currency: TenantCurrency | string) =>
  toTenantCurrency(currency) !== "BRL";
export const crossCurrencyNote = (currency: TenantCurrency | string) =>
  `Receita em ${toTenantCurrency(currency)} e custo em BRL: sem conversão de câmbio`;
export const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
export const periodLabel = (from: string, to: string) =>
  from === to ? dayLabel(from) : `${dayLabel(from)} a ${dayLabel(to)}`;

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
/** "sáb 01/11" for one day, "25/10 a 31/10" for a range. */
export const compareLabel = (from: string, to: string) =>
  from === to
    ? `${WEEKDAYS[new Date(`${from}T12:00:00Z`).getUTCDay()]} ${dayLabel(from)}`
    : periodLabel(from, to);

export type DeltaView = { text: string; tone: "success" | "danger" | "muted" };

/**
 * Variation against the previous period. Percent only when both periods are
 * big enough (`comparable`); otherwise the absolute difference, always grey.
 * `neutral` metrics (cost, volume) are never green or red: spending less
 * usually just means sending less.
 */
export function deltaView({
  current,
  previous,
  better = "high",
  neutral = false,
  comparable,
  formatDiff,
}: {
  current: number | null;
  previous: number | null | undefined;
  better?: "high" | "low";
  neutral?: boolean;
  comparable: boolean;
  formatDiff: (value: number) => string;
}): DeltaView | null {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  if (!comparable || previous === 0) {
    if (Math.abs(diff) < 1e-9) return { text: "igual", tone: "muted" };
    return { text: `${diff > 0 ? "+" : "−"}${formatDiff(Math.abs(diff))}`, tone: "muted" };
  }
  const change = diff / Math.abs(previous);
  if (!Number.isFinite(change)) return null;
  const arrow = change >= 0 ? "▲" : "▼";
  const text =
    change > 2
      ? `${arrow} ${decimal(current / previous, 1)}x`
      : `${arrow} ${decimal(Math.abs(change) * 100, 0)}%`;
  const good = better === "high" ? change >= 0 : change <= 0;
  const tone = neutral || Math.abs(change) < 0.005 ? "muted" : good ? "success" : "danger";
  return { text, tone };
}

/** Origin with real spend and no conversion at all. */
export const isWaste = (source: CrmSource) =>
  source.cost >= 50 && source.directPlayers === 0 && source.influencedPlayers === 0;
