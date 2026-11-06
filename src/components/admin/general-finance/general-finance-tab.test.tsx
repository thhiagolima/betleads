import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { formatCentsBRL } from "@/components/billing/admin/billing-admin-ui";
import { brl } from "@/lib/format";

const queryState = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash,
    children,
    className,
  }: {
    to: string;
    hash?: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a data-router-link="" href={hash ? `${to}#${hash}` : to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/billing/general-finance.functions", () => ({
  adminGeneralFinance: vi.fn(),
}));
vi.mock("@/lib/billing/billing-admin.functions", () => ({
  adminBillingMonthlyCsv: vi.fn(),
}));

import { GeneralFinanceTab, monthFromInput } from "./general-finance-tab";

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
    ownProvider: false,
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
    ownProviderHouses: [],
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

  it("formats the missing-cost units in the card hint with pt-BR grouping", () => {
    resetQueryState();
    queryState.data = financeData({
      totals: totals({ infobip: { amount: 20, missingCostUnits: 12345 } }),
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("12.345 unidades sem custo cadastrado");
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

  it("shows the known provider amount plus the units without cost in the house row", () => {
    resetQueryState();
    queryState.data = financeData({
      houses: [house({ shortBrasil: { amount: 30, missingCostUnits: 1500 } })],
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain(`${brl(30)} + 1.500 sem custo`);
  });

  it("shows 'não cadastrado' when a provider has only units without cost", () => {
    resetQueryState();
    queryState.data = financeData({
      houses: [house({ infobip: { amount: 0, missingCostUnits: 40 } })],
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("não cadastrado");
    expect(html).toContain('title="margem superestimada: custo não cadastrado"');
  });

  it("does not mark the margin when every unit has a cost", () => {
    resetQueryState();
    queryState.data = financeData();

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).not.toContain("margem superestimada");
    expect(html).not.toContain("sem custo");
  });

  it("warns on the Margem card when a provider total has units without cost", () => {
    resetQueryState();
    queryState.data = financeData({
      totals: totals({ infobip: { amount: 20, missingCostUnits: 3 } }),
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("margem superestimada: há unidades sem custo cadastrado");
  });

  it("shows the own-provider badge and the approximate-split note", () => {
    resetQueryState();
    queryState.data = financeData({
      houses: [
        house({ tenantId: "a", name: "Casa A", ownProvider: true }),
        house({ tenantId: "b", name: "Casa B", ownProvider: true }),
      ],
      ownProviderHouses: ["Casa A", "Casa B"],
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain("fornecedor próprio");
    expect(html).toContain("Divisão Short Brasil/Infobip aproximada para: Casa A, Casa B");
  });

  it("shows no own-provider note when no house has its own provider", () => {
    resetQueryState();
    queryState.data = financeData();

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).not.toContain("fornecedor próprio");
    expect(html).not.toContain("aproximada para");
  });

  it("titles the billing-state section as today's situation, with lost houses under it", () => {
    resetQueryState();
    queryState.data = financeData({
      states: {
        counts: {
          ok: 1,
          due_soon: 0,
          overdue: 0,
          locked: 1,
          awaiting_first_payment: 0,
          exempt: 0,
          frozen: 0,
        },
        owedCents: 0,
        debtors: [],
        movements: { newPaying: ["Casa Nova"], lost: ["Casa Perdida"] },
      },
    });

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    const today = html.indexOf("Situação atual (hoje)");
    expect(today).toBeGreaterThan(-1);
    expect(
      html.indexOf("Perdidas (bloqueadas/congeladas sem pagar): Casa Perdida"),
    ).toBeGreaterThan(today);
    expect(html.indexOf("Quem está devendo")).toBeGreaterThan(today);
    expect(html.indexOf("Novas pagantes no mês: Casa Nova")).toBeLessThan(today);
  });

  it("links a debtor to Faturamento through the router", () => {
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

    expect(html).toMatch(
      /<a data-router-link="" href="\/admin#faturamento"[^>]*>Ver em Faturamento/,
    );
  });

  it("puts the SMS/voz/e-mail breakdown in the Consumo cell tooltip", () => {
    resetQueryState();
    queryState.data = financeData();

    const html = renderToStaticMarkup(<GeneralFinanceTab />);

    expect(html).toContain(`title="SMS ${brl(100)} · Voz ${brl(50)} · E-mail ${brl(10)}"`);
  });
});

describe("monthFromInput", () => {
  it("accepts a valid AAAA-MM value", () => {
    expect(monthFromInput("2026-11", "2026-09")).toBe("2026-09");
  });

  it("keeps the current month when the input is cleared or invalid", () => {
    expect(monthFromInput("2026-11", "")).toBe("2026-11");
    expect(monthFromInput("2026-11", "2026-13")).toBe("2026-11");
    expect(monthFromInput("2026-11", "abc")).toBe("2026-11");
  });
});
