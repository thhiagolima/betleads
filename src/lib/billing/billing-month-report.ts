// Pure monthly per-house computation, shared by the admin CSV
// (adminBillingMonthlyCsvFor, billing-admin.functions.ts) and the "Financeiro
// geral" screen. No server imports here on purpose: this module is safe to
// import from a client component for its types.
//
// Formulas (I4, controller ruling, binding — moved here unchanged from the CSV):
//   receitaBruta    = mensalidadeReais + consumoSms + consumoVoz + consumoEmail
//                      (topupReais is an informational cash column, not revenue)
//   receitaLiquida  = receitaBruta − custoFornecedor − taxaPixReais
//   margemPct       = receitaLiquida / receitaBruta × 100, null when receitaBruta is 0
//                      (avoids a division by zero)
//   custoFornecedor = shortBrasil.amount + infobip.amount, each the sum over that
//                      provider's ledger rows of sign × units × provider_unit_cost
//                      (sign +1 for usage_reservation, −1 for usage_refund; a null
//                      provider_unit_cost counts as 0 in the amount, but its units
//                      are tracked in missingCostUnits so the gap is visible)

export type MonthTenant = {
  id: string;
  nome: string;
  slug: string;
  plano: string | null;
  exempt: boolean;
};

export type MonthLedgerRow = {
  tenant_id: string;
  item: string | null;
  units: number;
  amount: number;
  provider_unit_cost: number | null;
  entry_type: string;
};

export type MonthData = {
  month: string;
  tenants: MonthTenant[];
  invoicesPaid: Array<{ tenant_id: string; paid_amount_cents: number }>;
  topups: Array<{ tenant_id: string; paid_amount_cents: number }>;
  ledger: MonthLedgerRow[];
  pixFees: Array<{ tenant_id: string; fee_cents: number }>;
};

/** A provider's monthly cost, in reais. */
export type ProviderCost = { amount: number; missingCostUnits: number };

export type MonthHouseRow = {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  exempt: boolean;
  mensalidadeReais: number;
  topupReais: number;
  topupCount: number;
  consumoSms: number;
  consumoVoz: number;
  consumoEmail: number;
  shortBrasil: ProviderCost;
  infobip: ProviderCost;
  custoFornecedor: number; // = shortBrasil.amount + infobip.amount
  taxaPixReais: number;
  receitaBruta: number;
  receitaLiquida: number;
  margemPct: number | null;
};

export type MonthTotals = Omit<MonthHouseRow, "tenantId" | "name" | "slug" | "plan" | "exempt">;

function sumCentsBy<T>(
  rows: T[],
  tenantId: string,
  pick: (row: T) => number,
  matchKey: (row: T) => string,
): number {
  return rows.filter((row) => matchKey(row) === tenantId).reduce((acc, row) => acc + pick(row), 0);
}

/** sms ledger rows feed Short Brasil's cost; voice_30s/email rows feed Infobip's. */
function providerFor(item: string | null): "shortBrasil" | "infobip" {
  return item === "sms" ? "shortBrasil" : "infobip";
}

function emptyProviderCost(): ProviderCost {
  return { amount: 0, missingCostUnits: 0 };
}

function buildRow(tenant: MonthTenant, data: MonthData): MonthHouseRow {
  const mensalidadeCents = sumCentsBy(
    data.invoicesPaid,
    tenant.id,
    (r) => Number(r.paid_amount_cents ?? 0),
    (r) => r.tenant_id,
  );
  const topupRowsForTenant = data.topups.filter((r) => r.tenant_id === tenant.id);
  const topupCents = topupRowsForTenant.reduce(
    (acc, r) => acc + Number(r.paid_amount_cents ?? 0),
    0,
  );

  const ledgerForTenant = data.ledger.filter((r) => r.tenant_id === tenant.id);

  const consumoByItem = (item: string) =>
    -ledgerForTenant
      .filter((r) => r.item === item)
      .reduce((acc, r) => acc + Number(r.amount ?? 0), 0);

  const consumoSms = consumoByItem("sms");
  const consumoVoz = consumoByItem("voice_30s");
  const consumoEmail = consumoByItem("email");

  const shortBrasil = emptyProviderCost();
  const infobip = emptyProviderCost();
  for (const row of ledgerForTenant) {
    const bucket = providerFor(row.item) === "shortBrasil" ? shortBrasil : infobip;
    const sign = row.entry_type === "usage_reservation" ? 1 : -1;
    const units = Number(row.units ?? 0);
    if (row.provider_unit_cost == null) {
      bucket.missingCostUnits += units;
    } else {
      bucket.amount += sign * units * Number(row.provider_unit_cost);
    }
  }

  const taxaPixCents = sumCentsBy(
    data.pixFees,
    tenant.id,
    (r) => Number(r.fee_cents ?? 0),
    (r) => r.tenant_id,
  );

  const mensalidadeReais = mensalidadeCents / 100;
  const topupReais = topupCents / 100;
  const taxaPixReais = taxaPixCents / 100;
  const custoFornecedor = shortBrasil.amount + infobip.amount;
  const receitaBruta = mensalidadeReais + consumoSms + consumoVoz + consumoEmail;
  const receitaLiquida = receitaBruta - custoFornecedor - taxaPixReais;
  const margemPct = receitaBruta !== 0 ? (receitaLiquida / receitaBruta) * 100 : null;

  return {
    tenantId: tenant.id,
    name: tenant.nome,
    slug: tenant.slug,
    plan: tenant.plano,
    exempt: tenant.exempt,
    mensalidadeReais,
    topupReais,
    topupCount: topupRowsForTenant.length,
    consumoSms,
    consumoVoz,
    consumoEmail,
    shortBrasil,
    infobip,
    custoFornecedor,
    taxaPixReais,
    receitaBruta,
    receitaLiquida,
    margemPct,
  };
}

/** Paying houses first, then exempt ones; within each group, `data.tenants` order. */
export function computeMonthRows(data: MonthData): MonthHouseRow[] {
  const rows = data.tenants.map((tenant) => buildRow(tenant, data));
  const paying = rows.filter((r) => !r.exempt);
  const exempt = rows.filter((r) => r.exempt);
  return [...paying, ...exempt];
}

/** Sums every numeric field across rows; `margemPct` is recomputed from the summed receita, not
 * averaged from the rows' own `margemPct`. */
export function sumMonthRows(rows: MonthHouseRow[]): MonthTotals {
  const totals = rows.reduce(
    (acc, r) => ({
      mensalidadeReais: acc.mensalidadeReais + r.mensalidadeReais,
      topupReais: acc.topupReais + r.topupReais,
      topupCount: acc.topupCount + r.topupCount,
      consumoSms: acc.consumoSms + r.consumoSms,
      consumoVoz: acc.consumoVoz + r.consumoVoz,
      consumoEmail: acc.consumoEmail + r.consumoEmail,
      shortBrasil: {
        amount: acc.shortBrasil.amount + r.shortBrasil.amount,
        missingCostUnits: acc.shortBrasil.missingCostUnits + r.shortBrasil.missingCostUnits,
      },
      infobip: {
        amount: acc.infobip.amount + r.infobip.amount,
        missingCostUnits: acc.infobip.missingCostUnits + r.infobip.missingCostUnits,
      },
      custoFornecedor: acc.custoFornecedor + r.custoFornecedor,
      taxaPixReais: acc.taxaPixReais + r.taxaPixReais,
      receitaBruta: acc.receitaBruta + r.receitaBruta,
      receitaLiquida: acc.receitaLiquida + r.receitaLiquida,
      margemPct: null as number | null,
    }),
    {
      mensalidadeReais: 0,
      topupReais: 0,
      topupCount: 0,
      consumoSms: 0,
      consumoVoz: 0,
      consumoEmail: 0,
      shortBrasil: emptyProviderCost(),
      infobip: emptyProviderCost(),
      custoFornecedor: 0,
      taxaPixReais: 0,
      receitaBruta: 0,
      receitaLiquida: 0,
      margemPct: null as number | null,
    },
  );

  return {
    ...totals,
    margemPct:
      totals.receitaBruta !== 0 ? (totals.receitaLiquida / totals.receitaBruta) * 100 : null,
  };
}
