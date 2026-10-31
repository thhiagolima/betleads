import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: () => undefined,
  dataUpdatedAt: new Date("2026-10-30T15:00:00.000Z").getTime(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/meta-admin.functions", () => ({
  adminListMetaHouses: vi.fn(),
  adminTestMetaAlert: vi.fn(),
}));
vi.mock("@/lib/meta.functions", () => ({
  getMetaSyncRunJobs: vi.fn(),
  getMetaSyncRuns: vi.fn(),
}));

import type { MetaHouseRow } from "@/lib/meta-admin.server";
import { META_ALERT_FALLBACK_LABEL, MetaHousesPanel, metaAlertLabel } from "./meta-houses-panel";

type AlertCode = MetaHouseRow["alerts"][number]["code"];

function house(overrides: Partial<MetaHouseRow> = {}): MetaHouseRow {
  return {
    tenantId: "t-1",
    tenantName: "Sorte Alta",
    connections: { total: 2, connected: 1, error: 1 },
    accounts: { selected: 3, total: 5, inError: 1 },
    lastSuccessAt: "2026-10-30T12:00:00.000Z",
    latestRun: {
      status: "partial",
      triggerType: "scheduled",
      createdAt: "2026-10-30T11:00:00.000Z",
      finishedAt: "2026-10-30T11:05:00.000Z",
    },
    alerts: [
      { code: "account_error", message: "Conta act_9 em erro há mais de 24 h." },
      { code: "token_expiring", message: "A chave “Mídia” expira em 3 dias." },
    ],
    ...overrides,
  };
}

describe("MetaHousesPanel", () => {
  it("lists each house with keys, accounts, last read, latest run and alert texts", () => {
    queryState.data = [
      house(),
      house({
        tenantId: "t-2",
        tenantName: "Casa Dois",
        connections: { total: 1, connected: 1, error: 0 },
        accounts: { selected: 1, total: 1, inError: 0 },
        lastSuccessAt: null,
        latestRun: null,
        alerts: [],
      }),
    ];
    const html = renderToStaticMarkup(<MetaHousesPanel />);
    expect(html).toContain("Meta Ads por casa");
    expect(html).toContain("1 casa com alerta.");
    expect(html).toContain("Sorte Alta");
    expect(html).toContain("Casa Dois");
    expect(html).toContain("1 de 2 conectadas");
    expect(html).toContain("1 com erro");
    expect(html).toContain("3 de 5 marcadas");
    expect(html).toContain("1 em erro");
    expect(html).toContain("há 3 h");
    expect(html).toContain("sem leitura");
    expect(html).toContain("concluída com atenção");
    expect(html).toContain("automática");
    expect(html).toContain("Conta com erro");
    expect(html).toContain("Conta act_9 em erro há mais de 24 h.");
    expect(html).toContain("Chave expirando");
    expect(html).toContain("A chave “Mídia” expira em 3 dias.");
    expect(html).toContain("sem alertas");
    expect(html).toContain("Testar alerta");
  });

  it("labels connection_error in Portuguese and unknown codes generically", () => {
    expect(metaAlertLabel("connection_error")).toBe("Chave com erro");
    expect(metaAlertLabel("brand_new_code")).toBe(META_ALERT_FALLBACK_LABEL);
    expect(metaAlertLabel("toString")).toBe(META_ALERT_FALLBACK_LABEL);
    queryState.data = [
      house({
        alerts: [
          { code: "connection_error" as AlertCode, message: "A chave “Mídia” está com erro." },
          { code: "brand_new_code" as unknown as AlertCode, message: "Algo novo." },
        ],
      }),
    ];
    const html = renderToStaticMarkup(<MetaHousesPanel />);
    expect(html).toContain("Chave com erro");
    expect(html).toContain("A chave “Mídia” está com erro.");
    expect(html).toContain(META_ALERT_FALLBACK_LABEL);
    expect(html).not.toContain("brand_new_code");
    expect(html).toContain("Algo novo.");
  });

  it("shows the empty state but keeps the test button", () => {
    queryState.data = [];
    const html = renderToStaticMarkup(<MetaHousesPanel />);
    expect(html).toContain("Nenhuma casa com a Meta conectada.");
    expect(html).toContain("Testar alerta");
  });
});
