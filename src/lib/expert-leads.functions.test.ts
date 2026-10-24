import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireExpertContext = vi.fn();

vi.mock("@/lib/expert-access.server", () => ({
  requireExpertContext: (...args: unknown[]) => mockRequireExpertContext(...args),
}));

import { getExpertHomeFor, listExpertLeadsFor } from "./expert-leads.functions";

type Call = [string, ...unknown[]];

/** Minimal builder recording every call, mirroring the real PostgREST chain. */
function makeSupabaseStub(result: { data?: unknown[]; count?: number } = {}) {
  const calls: Call[] = [];
  const resolved = { data: result.data ?? [], count: result.count ?? 0, error: null };
  const builder = {
    select(columns: string, options?: unknown) {
      calls.push(["select", columns, options]);
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push(["eq", column, value]);
      return builder;
    },
    in(column: string, values: unknown[]) {
      calls.push(["in", column, values]);
      return builder;
    },
    or(filters: string) {
      calls.push(["or", filters]);
      return builder;
    },
    order(column: string, options?: unknown) {
      calls.push(["order", column, options]);
      return builder;
    },
    range(from: number, to: number) {
      calls.push(["range", from, to]);
      return Promise.resolve(resolved);
    },
    then(resolve: (v: typeof resolved) => unknown) {
      // getExpertHomeFor awaits the query directly (head select, no .range()).
      calls.push(["await"]);
      return Promise.resolve(resolved).then(resolve);
    },
  };
  const supabase = {
    from(table: string) {
      calls.push(["from", table]);
      return builder;
    },
  };
  return { supabase, calls };
}

const RESTRICTED_CTX = {
  tenantId: "t1",
  tenantNome: "Casa 1",
  expertId: "e1",
  nome: "Fulano",
  tipo: "restrito" as const,
  affiliateIds: ["AFF1", "AFF2"],
};

const TOTAL_CTX = {
  tenantId: "t1",
  tenantNome: "Casa 1",
  expertId: "e1",
  nome: "Fulano",
  tipo: "total" as const,
  affiliateIds: [] as string[],
};

beforeEach(() => {
  mockRequireExpertContext.mockReset();
});

describe("listExpertLeadsFor", () => {
  it("restricted expert query filters by tenant and affiliate ids", async () => {
    mockRequireExpertContext.mockResolvedValue(RESTRICTED_CTX);
    const { supabase, calls } = makeSupabaseStub({ data: [], count: 0 });

    const result = await listExpertLeadsFor(
      { userId: "u1", supabase, activeTenantId: null } as any,
      { search: "", page: 0 },
    );

    expect(calls).toContainEqual(["from", "players"]);
    expect(calls).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(calls).toContainEqual(["in", "affiliate_id", ["AFF1", "AFF2"]]);
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it("restricted expert without ids returns empty without querying", async () => {
    mockRequireExpertContext.mockResolvedValue({ ...RESTRICTED_CTX, affiliateIds: [] });
    const { supabase, calls } = makeSupabaseStub();

    const result = await listExpertLeadsFor(
      { userId: "u1", supabase, activeTenantId: null } as any,
      { search: "", page: 0 },
    );

    expect(result).toEqual({ rows: [], total: 0 });
    expect(calls.some((c) => c[0] === "from")).toBe(false);
  });

  it("total expert query filters only by tenant", async () => {
    mockRequireExpertContext.mockResolvedValue(TOTAL_CTX);
    const { supabase, calls } = makeSupabaseStub({ data: [], count: 0 });

    await listExpertLeadsFor({ userId: "u1", supabase, activeTenantId: null } as any, {
      search: "",
      page: 0,
    });

    expect(calls).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(calls.some((c) => c[0] === "in")).toBe(false);
  });

  it("never selects cpf, email or balances", async () => {
    mockRequireExpertContext.mockResolvedValue(TOTAL_CTX);
    const { supabase, calls } = makeSupabaseStub({ data: [], count: 0 });

    await listExpertLeadsFor({ userId: "u1", supabase, activeTenantId: null } as any, {
      search: "",
      page: 0,
    });

    const selectCall = calls.find((c) => c[0] === "select");
    expect(selectCall?.[1]).toBe("id,nome,telefone,total_depositado,ultimo_deposito,risco,vip");
  });

  it("searches telefone only when the search has digits", async () => {
    mockRequireExpertContext.mockResolvedValue(TOTAL_CTX);
    const { supabase: supabaseText, calls: callsText } = makeSupabaseStub({ data: [], count: 0 });
    await listExpertLeadsFor({ userId: "u1", supabase: supabaseText, activeTenantId: null } as any, {
      search: "maria",
      page: 0,
    });
    expect(callsText).toContainEqual(["or", "nome.ilike.%maria%"]);

    const { supabase: supabaseDigits, calls: callsDigits } = makeSupabaseStub({
      data: [],
      count: 0,
    });
    await listExpertLeadsFor(
      { userId: "u1", supabase: supabaseDigits, activeTenantId: null } as any,
      { search: "11999", page: 0 },
    );
    expect(callsDigits).toContainEqual(["or", "nome.ilike.%11999%,telefone.ilike.%11999%"]);
  });

  it("maps rows to ExpertLeadRow, including diasSemDepositar", async () => {
    mockRequireExpertContext.mockResolvedValue(TOTAL_CTX);
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
    const { supabase } = makeSupabaseStub({
      data: [
        {
          id: "p1",
          nome: "Jogador 1",
          telefone: "11999999999",
          total_depositado: 150.5,
          ultimo_deposito: twoDaysAgo,
          risco: "baixo",
          vip: true,
        },
      ],
      count: 1,
    });

    const result = await listExpertLeadsFor(
      { userId: "u1", supabase, activeTenantId: null } as any,
      { search: "", page: 0 },
    );

    expect(result.total).toBe(1);
    expect(result.rows).toEqual([
      {
        id: "p1",
        nome: "Jogador 1",
        telefone: "11999999999",
        totalDepositado: 150.5,
        ultimoDeposito: twoDaysAgo,
        diasSemDepositar: 2,
        risco: "baixo",
        vip: true,
      },
    ]);
  });
});

describe("getExpertHomeFor", () => {
  it("returns the expert's name, tipo, house and total leads", async () => {
    mockRequireExpertContext.mockResolvedValue(TOTAL_CTX);
    const { supabase } = makeSupabaseStub({ count: 7 });

    const result = await getExpertHomeFor({
      userId: "u1",
      supabase,
      activeTenantId: null,
    } as any);

    expect(result).toEqual({
      nome: "Fulano",
      tipo: "total",
      tenantNome: "Casa 1",
      totalLeads: 7,
    });
  });

  it("returns totalLeads 0 for a restricted expert without affiliate ids", async () => {
    mockRequireExpertContext.mockResolvedValue({ ...RESTRICTED_CTX, affiliateIds: [] });
    const { supabase, calls } = makeSupabaseStub();

    const result = await getExpertHomeFor({ userId: "u1", supabase, activeTenantId: null } as any);

    expect(result.totalLeads).toBe(0);
    expect(calls.some((c) => c[0] === "from")).toBe(false);
  });
});
