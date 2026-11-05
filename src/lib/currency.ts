/**
 * Moeda de exibição da casa (`tenants.moeda`, ISO 4217). Os valores da casa
 * (depósitos, saques, GGR, LTV, saldo do player) chegam do webhook já na moeda
 * local e são gravados como vieram; aqui só se escolhe como exibi-los, no
 * formato convencional de cada país. A cobrança da plataforma (carteira, SMS,
 * mensalidade) é sempre BRL e continua usando `brl()` de `@/lib/format`.
 */
export const TENANT_CURRENCIES = ["BRL", "ARS", "CLP", "COP", "MXN", "PEN", "PYG", "UYU", "USD"] as const;

export type TenantCurrency = (typeof TENANT_CURRENCIES)[number];

export const DEFAULT_CURRENCY: TenantCurrency = "BRL";

/** Locale de formatação convencional de cada moeda (símbolo, separadores, casas). */
const CURRENCY_LOCALE: Record<TenantCurrency, string> = {
  BRL: "pt-BR",
  ARS: "es-AR",
  CLP: "es-CL",
  COP: "es-CO",
  MXN: "es-MX",
  PEN: "es-PE",
  PYG: "es-PY",
  UYU: "es-UY",
  USD: "en-US",
};

export const CURRENCY_LABEL: Record<TenantCurrency, string> = {
  BRL: "Real brasileiro (BRL)",
  ARS: "Peso argentino (ARS)",
  CLP: "Peso chileno (CLP)",
  COP: "Peso colombiano (COP)",
  MXN: "Peso mexicano (MXN)",
  PEN: "Sol peruano (PEN)",
  PYG: "Guarani paraguaio (PYG)",
  UYU: "Peso uruguaio (UYU)",
  USD: "Dólar americano (USD)",
};

export function isTenantCurrency(value: unknown): value is TenantCurrency {
  return typeof value === "string" && (TENANT_CURRENCIES as readonly string[]).includes(value);
}

/** Valor desconhecido/ausente cai no padrão BRL (casas antigas, linha sem a coluna). */
export function toTenantCurrency(value: unknown): TenantCurrency {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : value;
  return isTenantCurrency(upper) ? upper : DEFAULT_CURRENCY;
}

export type MoneyFormatOptions = {
  /** Casas decimais fixas; por padrão, as da moeda (2 para BRL/ARS, 0 para CLP/PYG). */
  decimals?: number;
  /** Notação compacta ("$ 1,2 mil"), para eixos de gráfico. */
  compact?: boolean;
};

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: TenantCurrency, options: MoneyFormatOptions): Intl.NumberFormat {
  const key = `${currency}|${options.decimals ?? ""}|${options.compact ? 1 : 0}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
      style: "currency",
      currency,
      ...(options.compact ? { notation: "compact" as const } : {}),
      ...(options.decimals != null
        ? { minimumFractionDigits: options.decimals, maximumFractionDigits: options.decimals }
        : {}),
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** Formata um valor da casa na moeda dela. `null`/`undefined` viram 0. */
export function formatMoney(
  value: number | null | undefined,
  currency: TenantCurrency | string | null | undefined = DEFAULT_CURRENCY,
  options: MoneyFormatOptions = {},
): string {
  const n = Number(value ?? 0);
  return formatterFor(toTenantCurrency(currency), options).format(Number.isFinite(n) ? n : 0);
}

/** Só o símbolo da moeda ("R$", "$", "S/"), para rótulos como "Cashback ($)". */
export function currencySymbol(currency: TenantCurrency | string | null | undefined): string {
  const parts = formatterFor(toTenantCurrency(currency), { decimals: 0 }).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? toTenantCurrency(currency);
}
