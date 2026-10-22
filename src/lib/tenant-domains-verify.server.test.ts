// Task 6: runTenantDomainVerification — selection/processing loop for the
// periodic DNS verification cron. refreshTenantDomain and supabaseAdmin are
// mocked; isDomainDueForCheck runs for real (it's pure) against controlled
// created_at/last_checked_at fixtures.
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();

vi.mock("@/lib/tenant-domains.server", () => ({
  refreshTenantDomain: (...args: unknown[]) => refreshMock(...args),
}));

let candidateRows: Record<string, unknown>[] = [];
let lastQuery: { eqCalls: [string, unknown][]; isCalls: [string, unknown][] } | null = null;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      const query = { eqCalls: [] as [string, unknown][], isCalls: [] as [string, unknown][] };
      lastQuery = query;
      const builder = {
        select: (_cols: string) => builder,
        is: (col: string, val: unknown) => {
          query.isCalls.push([col, val]);
          return builder;
        },
        eq: (col: string, val: unknown) => {
          query.eqCalls.push([col, val]);
          return builder;
        },
        order: (_col: string, _opts: unknown) => Promise.resolve({ data: candidateRows, error: null }),
      };
      return builder;
    },
  },
}));

import { runTenantDomainVerification } from "@/lib/tenant-domains-verify.server";

const NOW = new Date("2026-10-21T12:00:00.000Z");

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "id-1",
    kind: "shortener",
    status: "verified",
    created_at: "2026-01-01T00:00:00.000Z",
    last_checked_at: "2026-10-20T12:00:00.000Z", // 24h ago: due (verified interval)
    ...overrides,
  };
}

beforeEach(() => {
  refreshMock.mockReset();
  refreshMock.mockImplementation(async (id: string) => ({ id, status: "verified" }));
  candidateRows = [];
  lastQuery = null;
});

describe("runTenantDomainVerification", () => {
  it("only processes domains that are due for a check", async () => {
    candidateRows = [
      row({ id: "due", last_checked_at: "2026-10-20T11:00:00.000Z" }), // 25h ago: due
      row({ id: "not-due", last_checked_at: "2026-10-21T11:30:00.000Z" }), // 30min ago: not due
    ];

    const result = await runTenantDomainVerification(NOW);

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith("due", { requestVerify: false });
    expect(result.checked).toBe(1);
  });

  it("caps processing at 50 domains per run", async () => {
    candidateRows = Array.from({ length: 60 }, (_, i) =>
      row({ id: `due-${i}`, last_checked_at: "2026-10-20T00:00:00.000Z" }),
    );

    const result = await runTenantDomainVerification(NOW);

    expect(refreshMock).toHaveBeenCalledTimes(50);
    expect(result.checked).toBe(50);
  });

  it("does not let one failure stop the rest", async () => {
    candidateRows = [
      row({ id: "fails", last_checked_at: "2026-10-20T00:00:00.000Z" }),
      row({ id: "succeeds", last_checked_at: "2026-10-20T00:00:00.000Z" }),
    ];
    refreshMock.mockImplementation(async (id: string) => {
      if (id === "fails") throw new Error("provider down");
      return { id, status: "verified" };
    });

    const result = await runTenantDomainVerification(NOW);

    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 2, verified: 1, failed: 1 });
  });

  it("counts a resulting status of 'failed' as failed, not just thrown errors", async () => {
    candidateRows = [row({ id: "goes-failed", last_checked_at: "2026-10-20T00:00:00.000Z" })];
    refreshMock.mockImplementation(async (id: string) => ({ id, status: "failed" }));

    const result = await runTenantDomainVerification(NOW);

    expect(result).toEqual({ checked: 1, verified: 0, failed: 1 });
  });

  it("requests verify only for email domains that are not yet verified", async () => {
    candidateRows = [
      row({ id: "email-pending", kind: "email", status: "pending", last_checked_at: "2026-10-20T00:00:00.000Z" }),
      row({ id: "email-verified", kind: "email", status: "verified", last_checked_at: "2026-10-20T00:00:00.000Z" }),
      row({ id: "shortener-pending", kind: "shortener", status: "pending", last_checked_at: "2026-10-20T00:00:00.000Z" }),
    ];

    await runTenantDomainVerification(NOW);

    expect(refreshMock).toHaveBeenCalledWith("email-pending", { requestVerify: true });
    expect(refreshMock).toHaveBeenCalledWith("email-verified", { requestVerify: false });
    expect(refreshMock).toHaveBeenCalledWith("shortener-pending", { requestVerify: false });
  });

  it("filters removed_at is null and non-demo tenants at the query layer", async () => {
    candidateRows = [];

    await runTenantDomainVerification(NOW);

    expect(lastQuery).not.toBeNull();
    expect(lastQuery!.isCalls).toContainEqual(["removed_at", null]);
    expect(lastQuery!.eqCalls).toContainEqual(["tenants.is_demo", false]);
  });
});
