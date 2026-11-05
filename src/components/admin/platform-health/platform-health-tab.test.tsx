import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { formatMoney } from "@/lib/currency";

const queryState = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/platform-health/platform-health.functions", () => ({
  adminPlatformHealth: vi.fn(),
}));

import { PlatformHealthTab } from "./platform-health-tab";

function resetQueryState() {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.isError = false;
}

const house = (overrides: Partial<Record<string, unknown>> = {}) => ({
  tenantId: "t1",
  name: "Casa",
  moeda: "BRL",
  level: "green",
  reason: null,
  current: { registrations: 100, ftds: 50, recovered: 1000, conversion: 50 },
  base: { registrations: 100, ftds: 50, recovered: 1000, conversion: 50 },
  deltas: { registrationsPct: 0, ftdsPct: 0, conversionPts: 0, recoveredPct: 0 },
  worstDelta: 0,
  ...overrides,
});

describe("PlatformHealthTab", () => {
  it("shows a green all-clear line when there are no alerts", () => {
    resetQueryState();
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [],
      houses: [],
      quietHouses: [],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Tudo funcionando — verificado às");
  });

  it("renders critical alerts before warning alerts, both with their message", () => {
    resetQueryState();
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [
        {
          key: "webhook:t1:silence",
          kind: "webhook",
          severity: "critical",
          message: "ForrandoBet sem webhook há 3 h (normal dela: a cada poucos minutos)",
          tenantId: "t1",
          since: "2026-11-04T09:00:00.000Z",
          href: "/webhooks",
        },
        {
          key: "provider:shortio",
          kind: "provider",
          severity: "warning",
          message: "Short.io: 20% dos links adiados por limite de chamadas — todas as casas",
          tenantId: null,
          since: null,
          href: "/admin#canais",
        },
      ],
      houses: [],
      quietHouses: [],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("ForrandoBet sem webhook há 3 h");
    expect(html).toContain("Short.io: 20% dos links adiados");
    expect(html.indexOf("CRÍTICO")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("ATENÇÃO")).toBeGreaterThan(html.indexOf("CRÍTICO"));
  });

  it("renders house rows in the given order with the reason text under a red house", () => {
    resetQueryState();
    const redHouse = house({
      tenantId: "red",
      name: "Sorte da Bet",
      level: "red",
      reason: "Cadastros −83% (107 vs ~636/semana)",
      current: { registrations: 107, ftds: 2, recovered: 0, conversion: 1.9 },
      base: { registrations: 636, ftds: 20, recovered: 0, conversion: 3.1 },
      deltas: { registrationsPct: -83, ftdsPct: -90, conversionPts: -5, recoveredPct: null },
      worstDelta: -90,
    });
    const greenHouse = house({
      tenantId: "green",
      name: "Sorte Alta",
      level: "green",
      reason: null,
    });
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [],
      houses: [redHouse, greenHouse],
      quietHouses: [],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Sorte da Bet");
    expect(html).toContain("Cadastros −83% (107 vs ~636/semana)");
    expect(html.indexOf("Sorte da Bet")).toBeLessThan(html.indexOf("Sorte Alta"));
  });

  it("formats an ARS house's recovery in ARS", () => {
    resetQueryState();
    const arsHouse = house({
      tenantId: "ars",
      name: "Los Hermanos",
      moeda: "ARS",
      level: "yellow",
      reason: "Recuperação −30% (R$ 50.000 vs ~R$ 70.000/semana)",
      current: { registrations: 500, ftds: 100, recovered: 50_000, conversion: 20 },
      deltas: { registrationsPct: 2, ftdsPct: 1, conversionPts: 0, recoveredPct: -30 },
    });
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [],
      houses: [arsHouse],
      quietHouses: [],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain(formatMoney(50_000, "ARS", { decimals: 0 }));
  });

  it("summarizes the quiet houses in one line", () => {
    resetQueryState();
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [],
      houses: [],
      quietHouses: [
        { tenantId: "a", name: "A" },
        { tenantId: "b", name: "B" },
      ],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("+ 2 casas sem movimento (A, B)");
  });

  it("shows the window footer text with the window.to date", () => {
    resetQueryState();
    queryState.data = {
      checkedAt: "2026-11-04T12:00:00.000Z",
      window: { from: "2026-10-29", to: "2026-11-04" },
      alerts: [],
      houses: [],
      quietHouses: [],
    };

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain(
      "Últimos 7 dias até 04/11 contra a média das 4 semanas anteriores. Casas demo fora.",
    );
  });

  it("renders a loading placeholder while the query is pending", () => {
    resetQueryState();
    queryState.isLoading = true;

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("animate-pulse");
  });

  it("renders an error message when the query fails", () => {
    resetQueryState();
    queryState.isError = true;

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Não foi possível carregar a saúde das casas.");
  });
});
