// MB4-04: filtro por contas de anúncio no getMarketingOverview. O compilador do
// TanStack Start troca o handler por um stub fora do servidor, então o teste chama
// o `getMarketingOverviewFor` e o parser da entrada.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/tenant-access.server", () => ({
  resolveCurrentTenantId: vi.fn(async () => "t1"),
}));

import { getMarketingOverviewFor, parseMarketingOverviewInput } from "./marketing.functions";

const rawOverview = (filter?: unknown) => ({
  period: { from: "2026-10-01", to: "2026-10-07" },
  totals: { spend: "10", spendOther: [] },
  attributionHealth: { total: 0, matchRate: null },
  creatives: [],
  creativesOthers: { count: 0, spend: 0 },
  campaigns: [],
  campaignsOthers: { count: 0, spend: 0 },
  audiences: [],
  audiencesOthers: { count: 0, spend: 0 },
  orphanAttributions: [],
  daily: [],
  ...(filter === undefined ? {} : { filter }),
});

const rpc = vi.fn();
const supabase = {
  rpc,
  from: () => ({
    select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
  }),
};

beforeEach(() => {
  rpc.mockReset();
});

describe("parseMarketingOverviewInput", () => {
  it("sem contas, o filtro é vazio", () => {
    expect(parseMarketingOverviewInput({ from: "2026-10-01", to: "2026-10-07" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
      adAccountIds: [],
    });
  });

  it("aceita act_<número>, sem repetição", () => {
    const parsed = parseMarketingOverviewInput({
      from: "2026-10-01",
      to: "2026-10-07",
      adAccountIds: ["act_1", "act_22", "act_1"],
    });
    expect(parsed.adAccountIds).toEqual(["act_1", "act_22"]);
  });

  it("recusa id fora do formato e mais de 200 contas", () => {
    const base = { from: "2026-10-01", to: "2026-10-07" };
    expect(() => parseMarketingOverviewInput({ ...base, adAccountIds: ["123"] })).toThrow();
    expect(() => parseMarketingOverviewInput({ ...base, adAccountIds: ["act_1;drop"] })).toThrow();
    const many = Array.from({ length: 201 }, (_, i) => `act_${i}`);
    expect(() => parseMarketingOverviewInput({ ...base, adAccountIds: many })).toThrow();
  });
});

describe("getMarketingOverviewFor", () => {
  it("sem filtro, chama a RPC só com os 3 argumentos e devolve filter null", async () => {
    rpc.mockResolvedValue({ data: rawOverview(), error: null });
    const result = await getMarketingOverviewFor(
      { supabase },
      { from: "2026-10-01", to: "2026-10-07", adAccountIds: [] },
    );
    expect(rpc).toHaveBeenCalledWith("marketing_overview", {
      _tenant: "t1",
      _from: "2026-10-01",
      _to: "2026-10-07",
    });
    expect(result.filter).toBeNull();
    expect(result.tenantId).toBe("t1");
  });

  it("com filtro, passa _ad_account_ids e expõe o filter da resposta", async () => {
    const filter = { ad_account_ids: ["act_1"], players_scope: "matched_only" };
    rpc.mockResolvedValue({ data: rawOverview(filter), error: null });
    const result = await getMarketingOverviewFor(
      { supabase },
      { from: "2026-10-01", to: "2026-10-07", adAccountIds: ["act_1"] },
    );
    expect(rpc).toHaveBeenCalledWith("marketing_overview", {
      _tenant: "t1",
      _from: "2026-10-01",
      _to: "2026-10-07",
      _ad_account_ids: ["act_1"],
    });
    expect(result.filter).toEqual(filter);
  });

  it("erro da RPC vira exceção", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      getMarketingOverviewFor(
        { supabase },
        { from: "2026-10-01", to: "2026-10-07", adAccountIds: [] },
      ),
    ).rejects.toThrow("boom");
  });
});
