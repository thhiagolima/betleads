// Moeda no financeiro. Os valores da casa (depósitos, saques, GGR, anúncios,
// taxas e outros custos lançados) estão na moeda dela (tenants.moeda); os
// custos Betleads (envios, mensalidade) são sempre BRL. Sem câmbio, um
// resultado que subtrai BRL de outra moeda não existe: summarize() devolve
// Lucro líquido/ROI null nessas casas, e somas entre casas só juntam casas da
// mesma moeda.
import { DEFAULT_CURRENCY, toTenantCurrency, type TenantCurrency } from "@/lib/currency";

import { round2 } from "./calc";

/** Moeda dos custos da plataforma (envios, mensalidade, carteira). */
export const PLATFORM_CURRENCY: TenantCurrency = "BRL";

/**
 * True quando receita e custos Betleads estão na mesma moeda, ou seja, quando
 * dá para calcular Lucro líquido, margem e ROI (só casas em BRL).
 */
export function profitComputable(currency: TenantCurrency | string | null | undefined): boolean {
  return toTenantCurrency(currency) === PLATFORM_CURRENCY;
}

/** "Receita em ARS e custos em BRL: sem conversão de câmbio". */
export function mixedCurrencyNote(currency: TenantCurrency | string | null | undefined): string {
  return `Receita em ${toTenantCurrency(currency)} e custos em ${PLATFORM_CURRENCY}: sem conversão de câmbio`;
}

/** BRL primeiro, depois as outras moedas em ordem alfabética. */
export function byCurrency(a: TenantCurrency, b: TenantCurrency) {
  if (a === b) return 0;
  if (a === PLATFORM_CURRENCY) return -1;
  if (b === PLATFORM_CURRENCY) return 1;
  return a.localeCompare(b);
}

/** As moedas distintas, BRL primeiro. */
export function distinctCurrencies(
  currencies: Array<TenantCurrency | string | null | undefined>,
): TenantCurrency[] {
  return [...new Set(currencies.map(toTenantCurrency))].sort(byCurrency);
}

/**
 * A moeda única de um conjunto de casas; null quando há mais de uma (aí não
 * existe total somado). Sem casas, BRL.
 */
export function singleCurrency(
  currencies: Array<TenantCurrency | string | null | undefined>,
): TenantCurrency | null {
  const distinct = distinctCurrencies(currencies);
  if (distinct.length === 0) return DEFAULT_CURRENCY;
  return distinct.length === 1 ? distinct[0] : null;
}

/** Os itens agrupados por moeda, BRL primeiro; cada grupo mantém a ordem recebida. */
export function groupByCurrency<T>(
  items: T[],
  currencyOf: (item: T) => TenantCurrency | string | null | undefined,
): Array<{ currency: TenantCurrency; items: T[] }> {
  const groups = new Map<TenantCurrency, T[]>();
  for (const item of items) {
    const currency = toTenantCurrency(currencyOf(item));
    const list = groups.get(currency);
    if (list) list.push(item);
    else groups.set(currency, [item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byCurrency(a, b))
    .map(([currency, list]) => ({ currency, items: list }));
}

export type CurrencyTotal = { currency: TenantCurrency; amount: number | null };

/**
 * Um total por moeda, nunca uma soma entre moedas. Um valor null (ex.: Lucro
 * líquido de uma casa fora do BRL) deixa o total daquela moeda null.
 */
export function totalsByCurrency<T>(
  items: T[],
  currencyOf: (item: T) => TenantCurrency | string | null | undefined,
  valueOf: (item: T) => number | null,
): CurrencyTotal[] {
  return groupByCurrency(items, currencyOf).map(({ currency, items: list }) => {
    let amount: number | null = 0;
    for (const item of list) {
      const value = valueOf(item);
      if (value === null || amount === null) amount = null;
      else amount += value;
    }
    return { currency, amount: amount === null ? null : round2(amount) };
  });
}
