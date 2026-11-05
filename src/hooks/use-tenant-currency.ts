import { useCallback } from "react";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import {
  currencySymbol,
  formatMoney,
  toTenantCurrency,
  type MoneyFormatOptions,
  type TenantCurrency,
} from "@/lib/currency";

/**
 * Moeda da casa ativa (ou de `tenantId`, nas telas do super admin que olham
 * outra casa). Enquanto o switcher carrega, BRL. Usa o mesmo query key do
 * switcher, então não dispara outra requisição.
 */
export function useTenantCurrency(tenantId?: string | null): TenantCurrency {
  const { tenants, active } = useActiveTenant();
  const tenant = tenantId ? tenants.find((option) => option.id === tenantId) : active;
  return toTenantCurrency(tenant?.moeda);
}

/**
 * Formatador dos valores da casa (depósitos, saques, GGR, LTV, saldo) na moeda
 * dela. Para custos da plataforma (SMS, voz, e-mail, carteira) use `brl()`.
 */
export function useMoney(tenantId?: string | null) {
  const currency = useTenantCurrency(tenantId);
  const money = useCallback(
    (value: number | null | undefined, options?: MoneyFormatOptions) =>
      formatMoney(value, currency, options),
    [currency],
  );
  return { currency, money, symbol: currencySymbol(currency) };
}
