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

/** Origin with real spend and no conversion at all. */
export const isWaste = (source: CrmSource) =>
  source.cost >= 50 && source.directPlayers === 0 && source.influencedPlayers === 0;
