import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CashflowCrmRow,
  CrmCard,
  HomeKpiCards,
  SecondaryMetrics,
  type HomeDashboardData,
  type HouseCrmFields,
} from "./dashboard-blocks";

// Render estático sem QueryClient, router nem HelpProvider: os hooks e o
// Link/Term viram versões simples.
vi.mock("@/hooks/use-tenant-currency", async () => {
  const { formatMoney } = await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    useMoney: () => ({
      currency: "BRL",
      money: (value: number | null | undefined) => formatMoney(value, "BRL"),
      symbol: "R$",
    }),
  };
});
vi.mock("@/hooks/use-enabled-channels", () => ({
  useEnabledChannels: () => ({ isEnabled: () => true, enabled: ["sms"], loading: false }),
}));
vi.mock("@/components/help/term", () => ({
  Term: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

/** Toda a formatação de dinheiro usa NBSP depois de "R$"; os textos dos testes usam espaço. */
function render(node: ReactNode) {
  return renderToStaticMarkup(node).replace(/[\u00a0\u202f]/g, " ");
}

function makeData(overrides: Partial<HomeDashboardData> = {}): HomeDashboardData {
  return {
    periodDays: 1,
    depositAmount: 225,
    depositGrowth: 10,
    depositCount: 8,
    depositors: 6,
    depositorsGrowth: 0,
    depositsPerDepositor: 1.33,
    newPlayers: 7,
    newPlayersGrowth: 0,
    ftd: 6,
    ftdGrowth: 0,
    ftdAmount: 175,
    ftdAmountGrowth: 0,
    ftdTicket: 29.1666,
    conversion: 85.7,
    conversionGrowth: 2.5,
    ticket: 28.125,
    ticketGrowth: 0,
    redepositAmount: 50,
    redepositCount: 1,
    redepositPlayers: 1,
    redepositGrowth: null,
    recoveredAmount: 0,
    recoveredNew: 0,
    recoveredReactivated: 0,
    recoveredReturning: 0,
    recoveredPlayers: 1,
    withdrawalAmount: 90,
    withdrawalCount: 3,
    withdrawalGrowth: 0,
    netAmount: 135,
    netGrowth: null,
    ftdRedepositRate: 33.3333,
    ftdRedepositRateGrowth: -1.2,
    ftdCohort: 6,
    ftdCohortRedeposited: 2,
    cashflowChart: [
      { key: "13h", label: "13h", deposits: 100, withdrawals: 0 },
      { key: "14h", label: "14h", deposits: 125, withdrawals: 90 },
    ],
    pixGenerated: 9,
    pixGeneratedGrowth: 0,
    pixPayRate: 88.888,
    pixUnpaid: 1,
    pixUnpaidAmount: 30,
    reactivationQueue: 4,
    liveEvents: [],
    ...overrides,
  } as HomeDashboardData;
}

const house: HouseCrmFields = {
  messageCost: 0,
  messageRoi: 0,
  activeFlows: 2,
  totalFlows: 3,
  walletBalance: 100,
  exempt: false,
  smsSent: 1234,
  smsClicks: 56,
  smsCtr: 4.538,
};

describe("HomeKpiCards", () => {
  it("shows the meta line under each value and the comparison on the conversion", () => {
    const html = render(<HomeKpiCards data={makeData()} sparkline={[]} />);
    expect(html).toContain("8 depósitos · ticket R$ 28,13");
    expect(html).toContain("1,3 depósito por jogador");
    expect(html).toContain("R$ 175,00 · ticket R$ 29,17");
    expect(html).toContain("6 de 7 cadastros");
    // Os 4 cartões comparam com o dia anterior, inclusive a Conversão.
    expect(html.match(/vs dia anterior/g)).toHaveLength(4);
  });

  it("uses the plural from 2 deposits per player on", () => {
    const html = render(
      <HomeKpiCards data={makeData({ depositsPerDepositor: 2.04 })} sparkline={[]} />,
    );
    expect(html).toContain("2,0 depósitos por jogador");
  });

  it('shows "—" when the FTD exists but its amount has not synced, and hides it without FTD', () => {
    const pending = render(<HomeKpiCards data={makeData({ ftdAmount: 0 })} sparkline={[]} />);
    expect(pending).toContain(">—<");
    expect(pending).not.toContain("R$ 0,00 · ticket");

    const none = render(
      <HomeKpiCards
        data={makeData({ ftd: 0, ftdAmount: 0, ftdTicket: 0, depositsPerDepositor: 0 })}
        sparkline={[]}
      />,
    );
    expect(none).not.toContain(">—<");
    expect(none).not.toContain("por jogador");
  });
});

describe("CrmCard", () => {
  it("shows the recovered count, SMS sent with clicks and hides empty rows", () => {
    const html = render(<CrmCard data={makeData()} house={house} />);
    expect(html).toContain("1 jogador recuperado");
    expect(html).toContain("1.234 · 56 cliques (4,5%)");
    expect(html).not.toContain("Cada R$ 1 em SMS trouxe");
    expect(html).toContain("Saldo");
  });

  it("hides Saldo for an exempt house and keeps the ROI when there is one", () => {
    const html = render(
      <CrmCard data={makeData()} house={{ ...house, exempt: true, messageRoi: 7.9 }} />,
    );
    expect(html).not.toContain("Saldo");
    expect(html).not.toContain("Isenta");
    expect(html).toContain("Cada R$ 1 em SMS trouxe");
  });

  it("renders only the lead rows for the expert (no house)", () => {
    const html = render(<CrmCard data={makeData({ recoveredPlayers: 0 })} />);
    expect(html).toContain("0 jogadores recuperados");
    expect(html).toContain("Em jornada agora");
    expect(html).not.toContain("SMS enviados");
  });
});

describe("CashflowCrmRow", () => {
  it("drops the chart with fewer than 2 points", () => {
    const html = render(
      <CashflowCrmRow
        data={makeData({
          cashflowChart: [{ key: "14h", label: "14h", deposits: 1, withdrawals: 0 }],
        })}
      />,
    );
    expect(html).not.toContain("Depósitos e saques");
    expect(html).toContain("Recuperado pelo CRM");
  });
});

describe("SecondaryMetrics", () => {
  it("shows the 4 cells with their details", () => {
    const html = render(<SecondaryMetrics data={makeData()} />);
    expect(html).toContain("Líquido");
    expect(html).toContain("saques R$ 90,00 · 3 saques");
    expect(html).toContain("1 jogador<");
    expect(html).toContain("33,3%");
    expect(html).toContain("↓ 1,2 p.p.");
    expect(html).toContain("2 de 6 FTDs");
    expect(html).toContain("R$ 30,00 · 88,9% pagos");
    expect(html).not.toContain("Novos clientes");
    expect(html).not.toContain("Ticket médio");
  });

  it("paints a negative net in the danger tone and blanks the FTD rate without a cohort", () => {
    const html = render(
      <SecondaryMetrics
        data={makeData({ netAmount: -40, ftdCohort: 0, ftdCohortRedeposited: 0 })}
      />,
    );
    expect(html).toContain("text-danger");
    expect(html).toContain("nenhum FTD no período");
    expect(html).not.toContain("p.p.");
  });
});
