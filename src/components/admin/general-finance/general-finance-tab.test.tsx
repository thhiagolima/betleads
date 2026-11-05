import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { formatCentsBRL } from "@/components/billing/admin/billing-admin-ui";

const queryState = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/billing/general-finance.functions", () => ({
  adminGeneralFinance: vi.fn(),
}));
vi.mock("@/lib/billing/billing-admin.functions", () => ({
  adminBillingMonthlyCsv: vi.fn(),
}));

import { GeneralFinanceTab } from "./general-finance-tab";

function resetQueryState() {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.isError = false;
}

type HouseOverrides = Partial<Record<string, unknown>>;

function house(overrides: HouseOverrides = {}) {
  return {
    tenantId: "t1",
    name: "Sorte Alta",
    slug: "sorte-alta",
    plan: "crm_unico",
    exempt: false,
    mensalidadeReais: 4000,
    topupReais: 500,
    topupCount: 2,
    consumoSms: 100,
    consumoVoz: 50,
    consumoEmail: 10,
    shortBrasil: { amount: 30, missingCostUnits: 0 },
    infobip: { amount: 20, missingCostUnits: 0 },
    custoFornecedor: 50,
    taxaPixReais: 15,
    receitaBruta: 4160,
    receitaLiquida: 4095,
    margemPct: 98.4,
    bucket: "ok",
    daysOverdue: null,
    openInvoiceCents: null,
    ...overrides,
  };
}

function totals(overrides: HouseOverrides = {}) {
  return {
    mensalidadeReais: 4000,
    topupReais: 500,
    topupCount: 2,
    consumoSms: 100,
    consumoVoz: 50,
    consumoEmail: 10,
    shortBrasil: { amount: 30, missingCostUnits: 0 },
    infobip: { amount: 20, missingCostUnits: 0 },
    custoFornecedor: 50,
    taxaPixReais: 15,
    receitaBruta: 4160,
    receitaLiquida: 4095,
    margemPct: 98.4,
    ...overrides,
  };
}

function financeData(overrides: HouseOverrides = {}) {
  return {
    month: "2026-11",
    generatedAt: "2026-11-05T12:00:00.000Z",
    totals: totals(),
    states: {
      counts: {
        ok: 1,
        due_soon: 0,
        overdue: 0,
        locked: 0,
        awaiting_first_payment: 0,
        exempt: 0,
        frozen: 0,
      },
      owedCents: 0,
      debtors: [],
      movements: { newPaying: [], lost: [] },
    },
    houses: [house()],
    ...overrides,
  };
}

describe("GeneralFinanceTab", () => {
  it("shows the monthly totals in the cards", () => {
    resetQueryState();
    queryState.data = financeData();

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain(formatCentsBRL(400000));
    expect(html).toContain(formatCentsBRL(50000));
  });

  it("shows a missing-cost hint on a provider card when missingCostUnits > 0", () => {
    resetQueryState();
    queryState.data = financeData({
      totals: totals({ shortBrasil: { amount: 30, missingCostUnits: 7 } }),
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("7 unidades sem custo cadastrado");
  });

  it("shows days overdue for a debtor", () => {
    resetQueryState();
    queryState.data = financeData({
      states: {
        counts: {
          ok: 0,
          due_soon: 0,
          overdue: 1,
          locked: 0,
          awaiting_first_payment: 0,
          exempt: 0,
          frozen: 0,
        },
        owedCents: 12000,
        debtors: [
          {
            tenantId: "t2",
            name: "Casa Devedora",
            amountCents: 12000,
            daysOverdue: 10,
            bucket: "overdue",
          },
        ],
        movements: { newPaying: [], lost: [] },
      },
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("Casa Devedora");
    expect(html).toContain("10 dias de atraso");
  });

  it("shows the bucket label when a debtor has no daysOverdue", () => {
    resetQueryState();
    queryState.data = financeData({
      states: {
        counts: {
          ok: 0,
          due_soon: 0,
          overdue: 0,
          locked: 0,
          awaiting_first_payment: 1,
          exempt: 0,
          frozen: 0,
        },
        owedCents: 5000,
        debtors: [
          {
            tenantId: "t3",
            name: "Casa Nova",
            amountCents: 5000,
            daysOverdue: null,
            bucket: "awaiting_first_payment",
          },
        ],
        movements: { newPaying: [], lost: [] },
      },
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("Casa Nova");
    expect(html).toContain("Aguardando 1º pagamento");
  });

  it("shows 'Ninguém devendo.' when there are no debtors", () => {
    resetQueryState();
    queryState.data = financeData();

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("Ninguém devendo.");
  });

  it("shows — for a null margin on an empty month", () => {
    resetQueryState();
    queryState.data = financeData({
      totals: totals({ receitaBruta: 0, receitaLiquida: 0, margemPct: null }),
      houses: [house({ receitaBruta: 0, receitaLiquida: 0, margemPct: null })],
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("—");
  });

  it("shows the 'isenta' badge for an exempt house", () => {
    resetQueryState();
    queryState.data = financeData({ houses: [house({ exempt: true })] });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("isenta");
  });

  it("renders houses in the given server order", () => {
    resetQueryState();
    queryState.data = financeData({
      houses: [house({ tenantId: "a", name: "Casa A" }), house({ tenantId: "b", name: "Casa B" })],
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html.indexOf("Casa A")).toBeLessThan(html.indexOf("Casa B"));
  });

  it("shows the movements line, omitting empty parts", () => {
    resetQueryState();
    queryState.data = financeData({
      states: {
        counts: {
          ok: 1,
          due_soon: 0,
          overdue: 0,
          locked: 0,
          awaiting_first_payment: 0,
          exempt: 0,
          frozen: 0,
        },
        owedCents: 0,
        debtors: [],
        movements: { newPaying: ["Casa Nova"], lost: [] },
      },
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("Novas pagantes no mês: Casa Nova");
    expect(html).not.toContain("Perdidas");
  });

  it("renders a loading placeholder while the query is pending", () => {
    resetQueryState();
    queryState.isLoading = true;

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("animate-pulse");
  });

  it("renders an error message when the query fails and there is no data", () => {
    resetQueryState();
    queryState.isError = true;

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("Não foi possível carregar o financeiro geral.");
  });
});
