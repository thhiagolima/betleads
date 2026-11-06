import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatMoney } from "@/lib/currency";

const queryState = {
  data: undefined as unknown,
  isLoading: false,
  isError: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/platform-health/platform-health.functions", () => ({
  adminPlatformHealth: vi.fn(),
}));
vi.mock("@/lib/platform-health/platform-alerts.functions", () => ({
  adminAcknowledgeAlert: vi.fn(),
  adminSilenceAlert: vi.fn(),
  adminAlertHistory: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AlertHistoryList, AlertRow, formatSince } from "./health-alerts-strip";
import { openHref, PlatformHealthTab } from "./platform-health-tab";

function resetQueryState() {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.isError = false;
}

/** checkedAt 12:00 UTC = 09:00 in São Paulo. */
function healthData(overrides: Record<string, unknown> = {}) {
  return {
    checkedAt: "2026-11-04T12:00:00.000Z",
    window: { from: "2026-10-29", to: "2026-11-04" },
    alerts: [],
    houses: [],
    quietHouses: [],
    housesUnavailable: false,
    recoveryUnavailable: false,
    ...overrides,
  };
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

  it("a failed background refetch keeps the last data with a small stale line", () => {
    resetQueryState();
    queryState.isError = true;
    queryState.data = healthData({ houses: [house({ name: "Sorte Alta" })] });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).not.toContain("Não foi possível carregar a saúde das casas.");
    expect(html).toContain("Sorte Alta");
    expect(html).toContain("Falha ao atualizar — mostrando dados de 09:00");
  });

  it("always shows 'verificado às HH:MM' (São Paulo) in the alerts card header", () => {
    resetQueryState();
    queryState.data = healthData({
      alerts: [
        {
          key: "provider:shortio",
          kind: "provider",
          severity: "warning",
          message: "Short.io: 25% dos links adiados",
          tenantId: null,
          since: null,
          href: "/admin#canais",
        },
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("verificado às 09:00");
    expect(html).not.toContain("Tudo funcionando");
  });

  it("renders an alert with href null as a non-clickable row", () => {
    resetQueryState();
    queryState.data = healthData({
      alerts: [
        {
          key: "source:finance_days",
          kind: "source",
          severity: "warning",
          message: "Não foi possível verificar finance_days",
          tenantId: null,
          since: null,
          href: null,
        },
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Não foi possível verificar finance_days");
    // No clickable "open" area for this row (no screen fixes it) — only the
    // Reconhecer/Silenciar action buttons, never nested inside another button.
    expect(html).not.toContain("hover:text-foreground");
    expect(html).toContain("Reconhecer");
    expect(html).toContain("Silenciar 24 h");
  });

  it("housesUnavailable shows a load-failure line instead of an empty table", () => {
    resetQueryState();
    queryState.data = healthData({ housesUnavailable: true });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Não foi possível carregar os números das casas.");
    expect(html).not.toContain("Recuperação CRM");
  });

  it("recoveryUnavailable shows — in the recovery cell instead of a value", () => {
    resetQueryState();
    queryState.data = healthData({
      recoveryUnavailable: true,
      houses: [
        house({
          current: { registrations: 100, ftds: 50, recovered: 0, conversion: 50 },
          deltas: { registrationsPct: 0, ftdsPct: 0, conversionPts: 0, recoveredPct: null },
        }),
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).not.toContain(formatMoney(0, "BRL", { decimals: 0 }));
  });

  it("every alert row offers Reconhecer and Silenciar 24 h", () => {
    resetQueryState();
    queryState.data = healthData({
      alerts: [
        {
          key: "job:a",
          kind: "job",
          severity: "critical",
          message: "Robô travado",
          tenantId: null,
          since: null,
          href: "/admin#canais",
          stored: null,
        },
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Reconhecer");
    expect(html).toContain("Silenciar 24 h");
  });

  it("an acknowledged alert stays listed, muted, tagged 'reconhecido'", () => {
    resetQueryState();
    queryState.data = healthData({
      alerts: [
        {
          key: "job:a",
          kind: "job",
          severity: "critical",
          message: "Robô travado",
          tenantId: null,
          since: null,
          href: "/admin#canais",
          stored: {
            openedAt: "2026-11-04T10:00:00.000Z",
            acknowledgedAt: "2026-11-04T10:05:00.000Z",
            silencedUntil: null,
          },
        },
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Robô travado");
    expect(html).toContain("reconhecido");
    expect(html).toContain("opacity-70");
  });

  it("a silenced alert is hidden from the list and counted in the 'silenciados' line", () => {
    resetQueryState();
    // Far enough in the future that it stays "silenced" (still > now) regardless of when this
    // test actually runs.
    const silencedUntil = "2099-11-05T20:00:00.000Z";
    queryState.data = healthData({
      alerts: [
        {
          key: "job:a",
          kind: "job",
          severity: "critical",
          message: "Robô A travado",
          tenantId: null,
          since: null,
          href: "/admin#canais",
          stored: {
            openedAt: "2026-11-04T10:00:00.000Z",
            acknowledgedAt: null,
            silencedUntil,
          },
        },
        {
          key: "job:b",
          kind: "job",
          severity: "warning",
          message: "Robô B parcial",
          tenantId: null,
          since: null,
          href: "/admin#canais",
          stored: null,
        },
      ],
    });

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).not.toContain("Robô A travado");
    expect(html).toContain("Robô B parcial");
    expect(html).toContain("1 silenciado até 17:00 — mostrar");
  });

  it("the Saúde tab offers a 30-day history button", () => {
    resetQueryState();
    queryState.data = healthData();

    const html = renderToStaticMarkup(<PlatformHealthTab />);

    expect(html).toContain("Histórico (30 dias)");
  });
});

describe("AlertHistoryList", () => {
  it("lists resolved alerts with message, opened/resolved times and duration", () => {
    const html = renderToStaticMarkup(
      <AlertHistoryList
        history={[
          {
            id: "r1",
            message: "Robô A travado",
            openedAt: "2026-11-01T10:00:00.000Z",
            resolvedAt: "2026-11-01T13:00:00.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("Robô A travado");
    expect(html).toContain("aberto em");
    expect(html).toContain("resolvido em");
    expect(html).toContain("3 h");
  });

  it("shows an empty-state message when there is nothing resolved", () => {
    const html = renderToStaticMarkup(<AlertHistoryList history={[]} />);

    expect(html).toContain("Nenhum alerta resolvido nos últimos 30 dias.");
  });
});

describe("AlertRow (fix round 1: tag replaces the matching action button)", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");
  const baseAlert = {
    key: "job:a",
    kind: "job" as const,
    severity: "critical" as const,
    message: "Robô A travado",
    tenantId: null,
    since: null,
    href: "/admin#canais",
  };
  const noop = () => {};

  it("a silenced row shows 'silenciado até HH:MM' and no 'Silenciar 24 h' button, but keeps Reconhecer", () => {
    const html = renderToStaticMarkup(
      <AlertRow
        alert={{
          ...baseAlert,
          stored: {
            openedAt: "2026-11-04T10:00:00.000Z",
            acknowledgedAt: null,
            silencedUntil: "2026-11-05T20:00:00.000Z",
          },
        }}
        now={now}
        onOpen={noop}
        onAcknowledge={noop}
        onSilence={noop}
        pending={false}
      />,
    );

    expect(html).toContain("silenciado até 17:00");
    expect(html).not.toContain("Silenciar 24 h");
    expect(html).toContain("Reconhecer");
  });

  it("an acknowledged row shows 'reconhecido' and no 'Reconhecer' button, but keeps Silenciar", () => {
    const html = renderToStaticMarkup(
      <AlertRow
        alert={{
          ...baseAlert,
          stored: {
            openedAt: "2026-11-04T10:00:00.000Z",
            acknowledgedAt: "2026-11-04T10:05:00.000Z",
            silencedUntil: null,
          },
        }}
        now={now}
        onOpen={noop}
        onAcknowledge={noop}
        onSilence={noop}
        pending={false}
      />,
    );

    expect(html).toContain("reconhecido");
    expect(html).not.toContain("Reconhecer");
    expect(html).toContain("Silenciar 24 h");
  });

  it("under sm the actions stack below the message (column), side by side from sm up", () => {
    const html = renderToStaticMarkup(
      <AlertRow
        alert={{ ...baseAlert, stored: null }}
        now={now}
        onOpen={noop}
        onAcknowledge={noop}
        onSilence={noop}
        pending={false}
      />,
    );

    const rowClass = /^<div class="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(rowClass.split(" ")).toEqual(
      expect.arrayContaining(["flex", "flex-col", "sm:flex-row", "sm:items-center"]),
    );
    expect(rowClass.split(" ")).not.toContain("items-center");
  });
});

describe("formatSince", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");

  it("floors hours: 23.5 h ago reads 'há 23 h', never 'há 24 h'", () => {
    const since = new Date(now.getTime() - 23.5 * 3_600_000).toISOString();
    expect(formatSince(since, now)).toBe("há 23 h");
  });

  it("formats 'desde DD/MM' in São Paulo (01:00 UTC on 11-03 is 11-02 there)", () => {
    expect(formatSince("2026-11-03T01:00:00.000Z", now)).toBe("desde 02/11");
  });
});

describe("openHref", () => {
  function stubWindow() {
    const setItem = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem }, location: { assign } });
    return { setItem, assign };
  }

  it("switches the active house for a house screen", () => {
    const { setItem, assign } = stubWindow();
    openHref("/webhooks", "t1");
    expect(setItem).toHaveBeenCalledWith("betleads:active-tenant", "t1");
    expect(assign).toHaveBeenCalledWith("/webhooks");
  });

  it("keeps the active house for an /admin screen", () => {
    const { setItem, assign } = stubWindow();
    openHref("/admin#saldo", "t1");
    expect(setItem).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/admin#saldo");
  });
});
