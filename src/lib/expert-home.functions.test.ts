// Início do expert: mapeamento do payload de `expert_home_summary`, o resumo
// zerado e os guards de `getExpertHomeSummaryFor` (o recorte de leads vem
// sempre de `requireExpertContext`, nunca do navegador). `supabaseAdmin` é um
// fake mínimo que registra as chamadas; o cache de resultados é desligado.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  fromCalls: [] as string[],
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  resetAt: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({
      data: fake.resetAt ? { reset_at: fake.resetAt } : null,
      error: null,
    }),
  };
  return {
    supabaseAdmin: {
      from: (table: string) => {
        fake.fromCalls.push(table);
        return query;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        fake.rpcCalls.push({ name, args });
        return fake.rpcResult;
      },
    },
  };
});

vi.mock("@/lib/server-result-cache", () => ({
  withServerResultCache: (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
}));

const mockRequireExpertContext = vi.fn();
vi.mock("@/lib/expert-access.server", () => ({
  requireExpertContext: (...args: unknown[]) => mockRequireExpertContext(...args),
}));

import { mapDashboardRpc } from "./dashboard.functions";
import {
  getExpertHomeSummaryFor,
  mapExpertHomeRpc,
  zeroExpertHomeSummary,
} from "./expert-home.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const EXPERT = "00000000-0000-4000-8000-0000000000e1";
const CTX = { userId: "u1", activeTenantId: TENANT };
const RANGE = { from: "2026-10-31T03:00:00.000Z", to: "2026-11-06T15:00:00.000Z" };

function expertContext(tipo: "restrito" | "total", affiliateIds: string[]) {
  return {
    tenantId: TENANT,
    tenantNome: "Casa",
    expertId: EXPERT,
    nome: "Eu",
    tipo,
    affiliateIds,
    envioModo: "livre" as const,
    tetoMensal: null,
  };
}

const HOUSE_ONLY_KEYS = [
  "messageCost",
  "messageRoi",
  "activeFlows",
  "totalFlows",
  "pausedFlows",
  "smsSent",
  "smsClicks",
  "smsCtr",
  "walletBalance",
  "exempt",
];

beforeEach(() => {
  fake.rpcCalls.length = 0;
  fake.fromCalls.length = 0;
  fake.rpcResult = { data: { depositAmount: "150.5", depositCount: 3 }, error: null };
  fake.resetAt = null;
  mockRequireExpertContext.mockReset();
});

describe("mapExpertHomeRpc", () => {
  const raw = {
    depositAmount: "300",
    previousDepositAmount: "150",
    depositCount: 3,
    previousDepositCount: 2,
    depositors: 2,
    previousDepositors: 1,
    newPlayers: 10,
    previousNewPlayers: 5,
    ftd: 4,
    previousFtd: 1,
    withdrawalAmount: "80",
    previousWithdrawalAmount: "40",
    withdrawalCount: 3,
    ftdAmount: "160",
    previousFtdAmount: "50",
    ftdCohort: 4,
    ftdCohortRedeposited: 2,
    previousFtdCohort: 1,
    previousFtdCohortRedeposited: 0,
    pixUnpaidAmount: "75",
    redepositAmount: "120",
    previousRedepositAmount: "60",
    redepositCount: 2,
    redepositPlayers: 1,
    recoveredAmount: "50",
    recoveredPlayers: 1,
    recoveredNew: "10",
    recoveredReactivated: "20",
    pixGenerated: 6,
    previousPixGenerated: 3,
    reactivationQueue: 7,
    cashflowChart: [{ key: "2026-11-01", label: "01/11", deposits: "300", withdrawals: "80" }],
    liveEvents: [
      {
        id: "deposit-1",
        tone: "green" as const,
        player: "Ana",
        action: "depositou",
        amount: "100",
        at: "2026-11-01T12:00:00Z",
      },
    ],
  };

  it("maps every lead-scoped number exactly like the house mapper", () => {
    const expert = mapExpertHomeRpc(raw, 7) as Record<string, unknown>;
    const house = mapDashboardRpc(raw, 7) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expert)) {
      expect(house[key], key).toEqual(value);
    }
    expect(expert.depositAmount).toBe(300);
    expect(expert.depositGrowth).toBe(100);
    expect(expert.ticket).toBe(100);
    expect(expert.conversion).toBe(40);
    expect(expert.pixUnpaid).toBe(3);
    expect(expert.pixPayRate).toBe(50);
    expect(expert.recoveredReturning).toBe(20);
    expect(expert.ftdAmount).toBe(160);
    expect(expert.ftdTicket).toBe(40);
    expect(expert.ftdRedepositRate).toBe(50);
    expect(expert.withdrawalCount).toBe(3);
    expect(expert.withdrawalGrowth).toBe(100);
    expect(expert.netAmount).toBe(220);
    expect(expert.pixUnpaidAmount).toBe(75);
    expect(expert.cashflowChart).toEqual([
      { key: "2026-11-01", label: "01/11", deposits: 300, withdrawals: 80 },
    ]);
    expect((expert.liveEvents as Array<{ amount?: number }>)[0].amount).toBe(100);
  });

  it("has none of the house-only fields (SMS cost, ROI, journeys counts, wallet)", () => {
    const expert = mapExpertHomeRpc(raw, 7) as Record<string, unknown>;
    for (const key of HOUSE_ONLY_KEYS) expect(expert, key).not.toHaveProperty(key);
  });
});

describe("zeroExpertHomeSummary", () => {
  it("is all zeros with empty series and feed", () => {
    const zero = zeroExpertHomeSummary(7);
    expect(zero.periodDays).toBe(7);
    expect(zero.cashflowChart).toEqual([]);
    expect(zero.liveEvents).toEqual([]);
    for (const [key, value] of Object.entries(zero)) {
      if (typeof value === "number" && key !== "periodDays") expect(value, key).toBe(0);
    }
  });
});

describe("getExpertHomeSummaryFor", () => {
  it("restrito with no affiliate id: zeroed shape and no DB call at all", async () => {
    mockRequireExpertContext.mockResolvedValue(expertContext("restrito", []));
    const result = await getExpertHomeSummaryFor(CTX, RANGE);
    expect(result).toEqual(zeroExpertHomeSummary(7));
    expect(fake.rpcCalls).toEqual([]);
    expect(fake.fromCalls).toEqual([]);
  });

  it("restrito: passes only the expert's own affiliate ids and tenant (server-side)", async () => {
    mockRequireExpertContext.mockResolvedValue(expertContext("restrito", ["B2", "A1"]));
    const result = await getExpertHomeSummaryFor(CTX, RANGE);
    expect(mockRequireExpertContext).toHaveBeenCalledWith("u1", TENANT);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].name).toBe("expert_home_summary");
    expect(fake.rpcCalls[0].args).toMatchObject({
      _tenant: TENANT,
      _affiliate_ids: ["A1", "B2"],
      _reset_at: "1970-01-01T00:00:00Z",
    });
    expect(result.depositAmount).toBe(150.5);
    expect(result.ticket).toBeCloseTo(150.5 / 3);
  });

  it("total: null affiliate ids (whole house) and the same period/prev period as the house", async () => {
    mockRequireExpertContext.mockResolvedValue(expertContext("total", ["IGNORED"]));
    fake.resetAt = "2026-11-02T10:00:00Z";
    const result = await getExpertHomeSummaryFor(CTX, RANGE);
    expect(fake.fromCalls).toEqual(["dashboard_settings"]);
    expect(fake.rpcCalls[0].args).toEqual({
      _tenant: TENANT,
      _affiliate_ids: null,
      _from: "2026-10-31T03:00:00.000Z",
      _to: "2026-11-07T02:59:59.999Z",
      _prev_from: "2026-10-24T03:00:00.000Z",
      _prev_to: "2026-10-31T02:59:59.999Z",
      _reset_at: "2026-11-02T10:00:00Z",
    });
    expect(result.periodDays).toBe(7);
  });

  it("propagates the access error and never queries", async () => {
    mockRequireExpertContext.mockRejectedValue(
      new Error("Esta casa está indisponível no momento."),
    );
    await expect(getExpertHomeSummaryFor(CTX, RANGE)).rejects.toThrow("indisponível");
    expect(fake.rpcCalls).toEqual([]);
  });

  it("surfaces an RPC error", async () => {
    mockRequireExpertContext.mockResolvedValue(expertContext("total", []));
    fake.rpcResult = { data: null, error: { message: "boom" } };
    await expect(getExpertHomeSummaryFor(CTX, RANGE)).rejects.toThrow("boom");
  });

  it("rejects malformed dates before resolving the expert", async () => {
    await expect(getExpertHomeSummaryFor(CTX, { from: "ontem", to: RANGE.to })).rejects.toThrow();
    expect(mockRequireExpertContext).not.toHaveBeenCalled();
  });
});
