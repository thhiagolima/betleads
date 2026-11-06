import { describe, expect, it } from "vitest";

import { computeMonthRows, sumMonthRows, type MonthData } from "./billing-month-report";

const PAYING = "00000000-0000-4000-8000-0000000000aa";
const EXEMPT = "00000000-0000-4000-8000-0000000000bb";
const OTHER = "00000000-0000-4000-8000-0000000000cc";

function baseData(overrides: Partial<MonthData> = {}): MonthData {
  return {
    month: "2026-10",
    tenants: [],
    invoicesPaid: [],
    topups: [],
    usage: [],
    pixFees: [],
    ...overrides,
  };
}

describe("computeMonthRows", () => {
  it("computes a paying house's mensalidade, topup, consumoSms and shortBrasil cost", () => {
    const data = baseData({
      tenants: [
        { id: PAYING, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico", exempt: false },
      ],
      invoicesPaid: [{ tenant_id: PAYING, paid_amount_cents: 400000 }],
      topups: [
        { tenant_id: PAYING, paid_amount_cents: 50000 },
        { tenant_id: PAYING, paid_amount_cents: 50000 },
      ],
      // 1000 reserved (R$ 80) minus a 10-unit refund (R$ 0,80), all at 0.059 cost.
      usage: [
        {
          tenant_id: PAYING,
          item: "sms",
          units: 990,
          sale_amount: 79.2,
          provider_cost: 990 * 0.059,
          missing_cost_units: 0,
        },
      ],
    });

    const [row] = computeMonthRows(data);
    expect(row.mensalidadeReais).toBe(4000);
    expect(row.topupReais).toBe(1000);
    expect(row.topupCount).toBe(2);
    expect(row.consumoSms).toBeCloseTo(79.2, 6);
    expect(row.shortBrasil.amount).toBeCloseTo(58.41, 2);
    expect(row.shortBrasil.missingCostUnits).toBe(0);
    expect(row.receitaBruta).toBeCloseTo(4079.2, 6);
    // margemPct = receitaLiquida / receitaBruta * 100
    const receitaLiquida = row.receitaBruta - row.custoFornecedor - row.taxaPixReais;
    expect(row.margemPct).toBeCloseTo((receitaLiquida / row.receitaBruta) * 100, 6);
  });

  it("routes voice and e-mail usage to infobip, tracking missingCostUnits for a null cost", () => {
    const data = baseData({
      tenants: [
        { id: PAYING, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico", exempt: false },
      ],
      usage: [
        {
          tenant_id: PAYING,
          item: "voice_30s",
          units: 100,
          sale_amount: 10,
          provider_cost: 100 * 0.034,
          missing_cost_units: 0,
        },
        {
          tenant_id: PAYING,
          item: "email",
          units: 500,
          sale_amount: 0.2,
          provider_cost: 0,
          missing_cost_units: 500,
        },
      ],
    });

    const [row] = computeMonthRows(data);
    expect(row.shortBrasil.amount).toBe(0);
    expect(row.infobip.amount).toBeCloseTo(100 * 0.034, 6);
    expect(row.infobip.missingCostUnits).toBe(500);
  });

  it("counts an exempt house's cost even though its SMS amount is 0, and includes it in sumMonthRows", () => {
    const data = baseData({
      tenants: [
        { id: EXEMPT, nome: "Casa Isenta", slug: "casa-isenta", plano: "interno", exempt: true },
      ],
      usage: [
        {
          tenant_id: EXEMPT,
          item: "sms",
          units: 200,
          sale_amount: 0,
          provider_cost: 200 * 0.059,
          missing_cost_units: 0,
        },
      ],
    });

    const [row] = computeMonthRows(data);
    expect(row.exempt).toBe(true);
    expect(row.mensalidadeReais).toBe(0);
    expect(row.consumoSms).toBeCloseTo(0, 6);
    expect(row.shortBrasil.amount).toBeCloseTo(200 * 0.059, 6);

    const totals = sumMonthRows([row]);
    expect(totals.shortBrasil.amount).toBeCloseTo(200 * 0.059, 6);
    expect(totals.custoFornecedor).toBeCloseTo(200 * 0.059, 6);
  });

  it("returns all zeros and a null margemPct for an empty month", () => {
    const data = baseData();
    const rows = computeMonthRows(data);
    expect(rows).toEqual([]);

    const totals = sumMonthRows(rows);
    expect(totals).toEqual({
      mensalidadeReais: 0,
      topupReais: 0,
      topupCount: 0,
      consumoSms: 0,
      consumoVoz: 0,
      consumoEmail: 0,
      shortBrasil: { amount: 0, missingCostUnits: 0 },
      infobip: { amount: 0, missingCostUnits: 0 },
      custoFornecedor: 0,
      taxaPixReais: 0,
      receitaBruta: 0,
      receitaLiquida: 0,
      margemPct: null,
    });
  });

  it("lists paying houses before exempt ones, otherwise keeping tenants order", () => {
    const data = baseData({
      tenants: [
        { id: EXEMPT, nome: "Casa Isenta", slug: "casa-isenta", plano: "interno", exempt: true },
        { id: PAYING, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico", exempt: false },
      ],
    });
    const rows = computeMonthRows(data);
    expect(rows.map((r) => r.tenantId)).toEqual([PAYING, EXEMPT]);
  });
});

describe("sumMonthRows", () => {
  it("recomputes margemPct from the summed receita rather than averaging rows' own margemPct", () => {
    const data = baseData({
      tenants: [
        { id: PAYING, nome: "Casa A", slug: "casa-a", plano: "crm_unico", exempt: false },
        { id: EXEMPT, nome: "Casa B", slug: "casa-b", plano: "crm_unico", exempt: false },
      ],
      invoicesPaid: [
        { tenant_id: PAYING, paid_amount_cents: 100000 },
        { tenant_id: EXEMPT, paid_amount_cents: 300000 },
      ],
    });
    const rows = computeMonthRows(data);
    const totals = sumMonthRows(rows);
    expect(totals.receitaBruta).toBe(4000);
    expect(totals.margemPct).toBeCloseTo(100, 6);
  });
});

describe("computeMonthRows usage aggregates", () => {
  it("maps each item's sale_amount to its consumo and sums every provider_cost into custoFornecedor", () => {
    const data = baseData({
      tenants: [
        { id: PAYING, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico", exempt: false },
      ],
      usage: [
        {
          tenant_id: PAYING,
          item: "sms",
          units: 100,
          sale_amount: 8,
          provider_cost: 5.9,
          missing_cost_units: 3,
        },
        {
          tenant_id: PAYING,
          item: "voice_30s",
          units: 10,
          sale_amount: 1,
          provider_cost: 0.34,
          missing_cost_units: 0,
        },
        {
          tenant_id: PAYING,
          item: "email",
          units: 50,
          sale_amount: 0.05,
          provider_cost: 0.02,
          missing_cost_units: 7,
        },
        {
          tenant_id: OTHER,
          item: "sms",
          units: 999,
          sale_amount: 99,
          provider_cost: 99,
          missing_cost_units: 99,
        },
      ],
    });

    const [row] = computeMonthRows(data);
    expect(row.consumoSms).toBe(8);
    expect(row.consumoVoz).toBe(1);
    expect(row.consumoEmail).toBe(0.05);
    expect(row.shortBrasil).toEqual({ amount: 5.9, missingCostUnits: 3 });
    expect(row.infobip.amount).toBeCloseTo(0.36, 6);
    expect(row.infobip.missingCostUnits).toBe(7);
    expect(row.custoFornecedor).toBeCloseTo(6.26, 6);
  });
});
