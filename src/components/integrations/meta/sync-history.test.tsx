import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/meta.functions", () => ({
  getMetaSyncRunJobs: vi.fn(),
  getMetaSyncRuns: vi.fn(),
}));

import {
  SyncHistoryList,
  SyncRunJobsList,
  durationText,
  runJobsRefetchInterval,
  triggerLabel,
  type MetaSyncRunRow,
} from "./sync-history";

function run(overrides: Partial<MetaSyncRunRow> = {}): MetaSyncRunRow {
  return {
    id: "run-1",
    trigger_type: "manual",
    days: 7,
    status: "completed",
    total_accounts: 3,
    processed_accounts: 3,
    successful_accounts: 3,
    failed_accounts: 0,
    rows_imported: 1234,
    started_at: "2026-10-30T14:00:00.000Z",
    finished_at: "2026-10-30T14:03:30.000Z",
    error_summary: null,
    created_at: "2026-10-30T13:59:00.000Z",
    ...overrides,
  };
}

describe("triggerLabel / durationText", () => {
  it("labels manual, scheduled (28-day) and backfill runs", () => {
    expect(triggerLabel({ trigger_type: "manual", days: 7 })).toBe("manual");
    expect(triggerLabel({ trigger_type: "scheduled", days: 3 })).toBe("automática");
    expect(triggerLabel({ trigger_type: "scheduled", days: 28 })).toBe("automática (28 dias)");
    expect(triggerLabel({ trigger_type: "backfill", days: 90 })).toBe("importação inicial");
  });

  it("measures started → finished, or says it is still running", () => {
    expect(durationText(run())).toBe("3 min");
    expect(
      durationText(
        run({ started_at: "2026-10-30T12:00:00Z", finished_at: "2026-10-30T13:05:00Z" }),
      ),
    ).toBe("1 h 05 min");
    expect(durationText(run({ finished_at: "2026-10-30T14:00:20.000Z" }))).toBe("menos de 1 min");
    expect(durationText(run({ status: "running", finished_at: null }))).toBe("em andamento");
    expect(durationText(run({ status: "queued", started_at: null, finished_at: null }))).toBe(
      "na fila",
    );
  });
});

describe("SyncHistoryList", () => {
  it("shows the empty state", () => {
    const html = renderToStaticMarkup(<SyncHistoryList runs={[]} />);
    expect(html).toContain("Histórico de sincronizações");
    expect(html).toContain("Nenhuma sincronização ainda.");
  });

  it("lists each run with trigger, status, accounts, failures, rows, duration, BRT date and errors", () => {
    const html = renderToStaticMarkup(
      <SyncHistoryList
        runs={[
          run({
            id: "run-2",
            trigger_type: "scheduled",
            days: 28,
            status: "partial",
            processed_accounts: 3,
            failed_accounts: 1,
            error_summary: "Conta act_9: token sem permissão ads_read",
          }),
          run({ id: "run-3", trigger_type: "backfill", status: "running", finished_at: null }),
          run(),
        ]}
      />,
    );
    expect(html).toContain("automática (28 dias)");
    expect(html).toContain("concluída com atenção");
    expect(html).toContain("3 de 3 contas");
    expect(html).toContain("1 falhou");
    expect(html).toContain("1.234 linhas importadas");
    expect(html).toContain("Conta act_9: token sem permissão ads_read");
    expect(html).toContain("importação inicial");
    expect(html).toContain("em andamento");
    expect(html).toContain("manual");
    expect(html).toContain("3 min");
    // 13:59 UTC = 10:59 em Brasília.
    expect(html).toContain("30/10, 10:59");
    // Fechado por padrão: as contas só carregam ao abrir.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Contas da sincronização");
  });

  it("keeps only the latest 10 runs", () => {
    const runs = Array.from({ length: 12 }, (_, i) => run({ id: `run-${i}` }));
    const html = renderToStaticMarkup(<SyncHistoryList runs={runs} />);
    expect(html.match(/aria-expanded=/g)).toHaveLength(10);
  });
});

describe("runJobsRefetchInterval", () => {
  it("polls an open run's accounts every 3 s only while the run is active", () => {
    expect(runJobsRefetchInterval(true)).toBe(3000);
    expect(runJobsRefetchInterval(false)).toBe(false);
  });
});

describe("SyncRunJobsList", () => {
  it("lists each account's status and error", () => {
    const html = renderToStaticMarkup(
      <SyncRunJobsList
        jobs={[
          {
            accountId: "acc-2",
            accountName: "SA - Captação 02",
            metaAdAccountId: "act_456",
            status: "failed",
            attemptCount: 3,
            rateLimitedCount: 1,
            rowsImported: 0,
            lastError: "A chave não possui mais acesso a esta conta.",
            finishedAt: "2026-10-30T14:03:00.000Z",
          },
          {
            accountId: "acc-1",
            accountName: null,
            metaAdAccountId: "act_123",
            status: "completed",
            attemptCount: 1,
            rateLimitedCount: 0,
            rowsImported: 1,
            lastError: null,
            finishedAt: null,
          },
        ]}
      />,
    );
    expect(html).toContain("SA - Captação 02");
    expect(html).toContain("falhou");
    expect(html).toContain("3 tentativas");
    expect(html).toContain("1 limite da Meta");
    expect(html).toContain("A chave não possui mais acesso a esta conta.");
    expect(html).toContain("act_123");
    expect(html).toContain("concluída");
    expect(html).toContain("1 linha importada");
  });

  it("shows the empty and error states", () => {
    expect(renderToStaticMarkup(<SyncRunJobsList jobs={[]} />)).toContain(
      "Nenhuma conta nesta sincronização.",
    );
    expect(renderToStaticMarkup(<SyncRunJobsList jobs={[]} failed />)).toContain(
      "Não foi possível carregar as contas desta sincronização.",
    );
  });
});
