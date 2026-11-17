// MCP do grupo, §5.4-§5.6 e §8: ranking_experts, detalhe_expert e afiliados.
// Mesmo createFakeDb dos outros testes de mcp; resolverEscopoOps roda de
// verdade (as RPCs de permissão são emuladas), então "só as casas do escopo
// são consultadas" é conferido pelos argumentos que as RPCs recebem.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import type { McpIdentity } from "../access.server";
import { createFakeDb } from "../../sms-bulk.test-support";
import { assertSemDadosPessoais } from "./runner.server";
import { SEM_ACESSO_CASA } from "./scope.server";
import {
  EXPERTS_TOOLS,
  EXPERT_NAO_ENCONTRADO,
  afiliados,
  detalheExpert,
  rankingExperts,
} from "./tools-experts.server";

const ADMIN_AB = "00000000-0000-4000-8000-0000000000aa";
const ADMIN_C = "00000000-0000-4000-8000-0000000000cc";

const HOUSE_A = "00000000-0000-4000-8000-000000000101"; // BRL
const HOUSE_B = "00000000-0000-4000-8000-000000000102"; // ARS
const HOUSE_C = "00000000-0000-4000-8000-000000000103"; // BRL, fora do escopo de ADMIN_AB

const EXP_A1 = "00000000-0000-4000-8000-00000000e0a1";
const EXP_A2 = "00000000-0000-4000-8000-00000000e0a2";
const EXP_A3 = "00000000-0000-4000-8000-00000000e0a3"; // inativo, sem atividade
const EXP_B1 = "00000000-0000-4000-8000-00000000e0b1";
const EXP_C1 = "00000000-0000-4000-8000-00000000e0c1";

const NOW = new Date("2026-11-17T15:00:00Z");
const PERIODO = { inicio: "2026-11-01", fim: "2026-11-16" };

const identity = (userId: string): McpIdentity => ({
  userId,
  connectionId: "conn",
  clientId: "client",
  level: "read",
  areas: ["operacao"],
});

type Row = Record<string, unknown>;
const rows = (table: string) => fake.admin.rows(table);

const userHouses: Record<string, string[]> = {
  [ADMIN_AB]: [HOUSE_A, HOUSE_B],
  [ADMIN_C]: [HOUSE_C],
};

/** Casas que cada RPC por casa recebeu. */
let rpcTenants: Record<string, string[]>;
let affiliateCalls: Row[];
let failingHouse: string | null;

const metrics = (expert_id: string, extra: Row = {}): Row => ({
  expert_id,
  depositado: "0",
  depositado_clique: "0",
  depositado_afiliado: "0",
  depositos: 0,
  depositantes: 0,
  reativacoes: 0,
  ftds: 0,
  links: 0,
  cliques: 0,
  contatos: 0,
  ...extra,
});

const METRICS: Record<string, Row[]> = {
  [HOUSE_A]: [
    metrics(EXP_A1, {
      depositado: "300.50",
      depositado_clique: "200.5",
      depositado_afiliado: "100",
      depositos: 3,
      depositantes: 2,
      ftds: 1,
      cliques: 10,
      contatos: 4,
    }),
    metrics(EXP_A2, { depositado: "700", depositos: 5, depositantes: 5, ftds: 3, cliques: 2 }),
    metrics(EXP_A3),
  ],
  [HOUSE_B]: [
    metrics(EXP_B1, { depositado: "5000", depositos: 2, depositantes: 2, ftds: 2, cliques: 50 }),
  ],
  [HOUSE_C]: [metrics(EXP_C1, { depositado: "9999", ftds: 9 })],
};
const HOUSE_TOTALS: Record<string, Row> = {
  [HOUSE_A]: { depositado: "2000", ftds: 10 },
  [HOUSE_B]: { depositado: "10000", ftds: 4 },
  [HOUSE_C]: { depositado: "9999", ftds: 9 },
};

const AFFILIATE_ROWS: Row[] = [
  {
    tenant_id: HOUSE_A,
    affiliate_id: "4512",
    jogadores_base: 40,
    cadastros: 5,
    ftds: 2,
    depositos: 6,
    depositado: "1200.00",
    depositantes: 3,
    primeiro_cadastro: "2026-01-01T00:00:00Z",
    ultimo_cadastro: "2026-11-10T00:00:00Z",
    expert_id: null,
    expert_nome: null,
  },
  {
    tenant_id: HOUSE_B,
    affiliate_id: "4512",
    jogadores_base: 10,
    cadastros: 1,
    ftds: 1,
    depositos: 1,
    depositado: "50000",
    depositantes: 1,
    primeiro_cadastro: null,
    ultimo_cadastro: null,
    expert_id: null,
    expert_nome: null,
  },
  {
    tenant_id: HOUSE_A,
    affiliate_id: "777",
    jogadores_base: 90,
    cadastros: 20,
    ftds: 8,
    depositos: 12,
    depositado: "800",
    depositantes: 8,
    primeiro_cadastro: null,
    ultimo_cadastro: null,
    expert_id: EXP_A1,
    expert_nome: "Ana",
  },
  {
    tenant_id: HOUSE_C,
    affiliate_id: "4512",
    jogadores_base: 1,
    cadastros: 1,
    ftds: 1,
    depositos: 1,
    depositado: "1",
    depositantes: 1,
    primeiro_cadastro: null,
    ultimo_cadastro: null,
    expert_id: null,
    expert_nome: null,
  },
];

const record = (fn: string, tenant: unknown) => {
  (rpcTenants[fn] ??= []).push(String(tenant));
};

beforeEach(() => {
  fake.admin.reset();
  rpcTenants = {};
  affiliateCalls = [];
  failingHouse = null;

  fake.admin.onRpc("mcp_ops_tenant_ids", (args) => ({
    data: userHouses[args._user as string] ?? [],
    error: null,
  }));
  fake.admin.onRpc("mcp_ops_can_view", (args) => ({
    data: (userHouses[args._user as string] ?? []).includes(args._tenant as string),
    error: null,
  }));
  fake.admin.onRpc("expert_metrics", (args) => {
    record("expert_metrics", args._tenant);
    if (args._tenant === failingHouse) return { data: null, error: { message: "timeout na casa" } };
    return { data: METRICS[args._tenant as string] ?? [], error: null };
  });
  fake.admin.onRpc("house_deposit_totals", (args) => {
    record("house_deposit_totals", args._tenant);
    return { data: [HOUSE_TOTALS[args._tenant as string]], error: null };
  });
  fake.admin.onRpc("mcp_affiliate_metrics", (args) => {
    affiliateCalls.push(args);
    const tenants = args._tenants as string[];
    return {
      data: AFFILIATE_ROWS.filter(
        (row) =>
          tenants.includes(row.tenant_id as string) &&
          (args._affiliate == null || row.affiliate_id === args._affiliate),
      ),
      error: null,
    };
  });

  rows("tenants").push(
    { id: HOUSE_A, nome: "Casa A", moeda: "BRL", status: "active", is_demo: false },
    { id: HOUSE_B, nome: "Casa B", moeda: "ARS", status: "active", is_demo: false },
    { id: HOUSE_C, nome: "Casa C", moeda: "BRL", status: "active", is_demo: false },
  );
  const expert = (id: string, tenant_id: string, nome: string, extra: Row = {}) => ({
    id,
    tenant_id,
    nome,
    tipo: "total",
    ativo: true,
    user_id: null,
    teto_mensal: null,
    ...extra,
  });
  rows("experts").push(
    expert(EXP_A1, HOUSE_A, "Ana", { teto_mensal: "500" }),
    expert(EXP_A2, HOUSE_A, "Bruno", { tipo: "restrito" }),
    expert(EXP_A3, HOUSE_A, "Caio", { ativo: false }),
    expert(EXP_B1, HOUSE_B, "Diego"),
    expert(EXP_C1, HOUSE_C, "Eva"),
  );
  rows("expert_monthly_usage").push(
    { tenant_id: HOUSE_A, expert_id: EXP_A1, month: "2026-11-01", amount: "123.4567" },
    { tenant_id: HOUSE_A, expert_id: EXP_A1, month: "2026-10-01", amount: "999" },
  );
  rows("expert_affiliates").push(
    { tenant_id: HOUSE_A, expert_id: EXP_A1, affiliate_id: "777" },
    { tenant_id: HOUSE_A, expert_id: EXP_A1, affiliate_id: "123" },
  );
  rows("expert_cap_alerts").push(
    { tenant_id: HOUSE_A, expert_id: EXP_A1, month: "2026-11-01", sent_at: "2026-11-15T10:00:00Z" },
    { tenant_id: HOUSE_A, expert_id: EXP_A1, month: "2026-10-01", sent_at: "2026-10-20T10:00:00Z" },
  );
  rows("sms_campaigns").push(
    {
      id: "s1",
      tenant_id: HOUSE_A,
      expert_id: EXP_A1,
      name: "SMS nov",
      status: "enviado",
      created_at: "2026-11-05T12:00:00Z",
      scheduled_at: "2026-11-05T13:00:00Z",
      total_count: 100,
      sent_count: 95,
      failed_count: 5,
      approval_status: "aprovada",
    },
    {
      id: "s2",
      tenant_id: HOUSE_A,
      expert_id: EXP_A1,
      name: "SMS out",
      status: "enviado",
      created_at: "2026-10-05T12:00:00Z",
      scheduled_at: "2026-10-05T13:00:00Z",
      total_count: 1,
      sent_count: 1,
      failed_count: 0,
    },
    {
      id: "s3",
      tenant_id: HOUSE_A,
      expert_id: EXP_A2,
      name: "Outro expert",
      status: "enviado",
      created_at: "2026-11-05T12:00:00Z",
      scheduled_at: null,
      total_count: 1,
      sent_count: 1,
      failed_count: 0,
    },
  );
  rows("email_campaigns").push({
    id: "m1",
    tenant_id: HOUSE_A,
    expert_id: EXP_A1,
    name: "Email",
    status: "aguardando_aprovacao",
    approval_status: "pendente",
    expert_estimated_cost: "12.5",
    created_at: "2026-10-30T12:00:00Z",
    scheduled_at: "2026-11-10T12:00:00Z",
    stats: { total: 50, enviados: 0, falhas: 0 },
  });
  rows("expert_voice_campaigns").push({
    id: "v1",
    tenant_id: HOUSE_A,
    expert_id: EXP_A1,
    name: "Voz",
    status: "enfileirada",
    created_at: "2026-11-12T12:00:00Z",
    scheduled_at: null,
    total_count: 30,
    queued_count: 30,
  });
});

const todas = { tipo: "todas" } as const;

describe("ranking_experts", () => {
  it("queries only the houses resolverEscopoOps returns", async () => {
    await rankingExperts(identity(ADMIN_AB), { escopo: todas, periodo: PERIODO }, NOW);
    expect(rpcTenants.expert_metrics.sort()).toEqual([HOUSE_A, HOUSE_B]);
    expect(rpcTenants.house_deposit_totals.sort()).toEqual([HOUSE_A, HOUSE_B]);
  });

  it("ranks per currency, never mixing them, with the house share and the month usage", async () => {
    const result = await rankingExperts(
      identity(ADMIN_AB),
      { escopo: todas, periodo: PERIODO },
      NOW,
    );
    assertSemDadosPessoais(result);
    expect(result.ranking_por_moeda.map((g) => g.moeda)).toEqual(["ARS", "BRL"]);
    const brl = result.ranking_por_moeda.find((g) => g.moeda === "BRL")!;
    // Caio: inativo e sem atividade, fica fora.
    expect(brl.experts.map((e) => e.nome)).toEqual(["Bruno", "Ana"]);
    const ana = brl.experts[1];
    expect(ana).toMatchObject({
      casa: { id: HOUSE_A, moeda: "BRL" },
      tipo: "Expert total",
      depositado: 300.5,
      depositado_clique: 200.5,
      fatia_casa_pct: 15,
      teto_mensal: 500,
      usado_mes: 123.46,
    });
    expect(brl.experts[0]).toMatchObject({ tipo: "Expert restrito", fatia_casa_pct: 35 });

    expect(result.totais_por_moeda).toHaveLength(2);
    const totBrl = result.totais_por_moeda.find((t) => t.moeda === "BRL")!;
    expect(totBrl.totais).toMatchObject({ depositado: 1000.5, depositado_casa: 2000, ftds: 4 });
    const totArs = result.totais_por_moeda.find((t) => t.moeda === "ARS")!;
    expect(totArs.totais).toMatchObject({
      depositado: 5000,
      depositado_casa: 10000,
      fatia_casa_pct: 50,
    });
    expect(result.mes_uso).toBe("2026-11");
    expect(result.casas_com_erro).toEqual([]);
  });

  it("orders by ftds or cliques and truncates per currency", async () => {
    const byCliques = await rankingExperts(
      identity(ADMIN_AB),
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO, ordenar: "cliques", limite: 1 },
      NOW,
    );
    expect(byCliques.ranking_por_moeda).toEqual([
      expect.objectContaining({ moeda: "BRL", truncado: true }),
    ]);
    expect(byCliques.ranking_por_moeda[0].experts.map((e) => e.nome)).toEqual(["Ana"]);
  });

  it("a failing house goes to casas_com_erro and the rest comes back", async () => {
    failingHouse = HOUSE_B;
    const result = await rankingExperts(
      identity(ADMIN_AB),
      { escopo: todas, periodo: PERIODO },
      NOW,
    );
    expect(result.casas_com_erro).toEqual([
      { id: HOUSE_B, nome: "Casa B", erro: "timeout na casa" },
    ]);
    expect(result.casas.map((c) => c.id)).toEqual([HOUSE_A]);
    expect(result.ranking_por_moeda.map((g) => g.moeda)).toEqual(["BRL"]);
  });

  it("refuses a house outside the user's scope", async () => {
    await expect(
      rankingExperts(
        identity(ADMIN_AB),
        { escopo: { tipo: "casa", id: HOUSE_C }, periodo: PERIODO },
        NOW,
      ),
    ).rejects.toThrow(SEM_ACESSO_CASA);
    expect(rpcTenants.expert_metrics).toBeUndefined();
  });
});

describe("detalhe_expert", () => {
  it("returns metrics, affiliates, period campaigns, usage and the month's cap alert", async () => {
    const result = await detalheExpert(
      identity(ADMIN_AB),
      { casa: HOUSE_A, expert: EXP_A1, periodo: PERIODO },
      NOW,
    );
    assertSemDadosPessoais(result);
    expect(rpcTenants.expert_metrics).toEqual([HOUSE_A]);
    expect(result.expert).toEqual({ id: EXP_A1, nome: "Ana", tipo: "Expert total", ativo: true });
    expect(result.metricas).toMatchObject({
      depositado: 300.5,
      fatia_casa_pct: 15,
      depositado_casa: 2000,
    });
    expect(result.afiliados).toEqual(["123", "777"]);
    expect(result.campanhas.map((c) => `${c.canal}:${c.id}`)).toEqual([
      "voz:v1",
      "email:m1",
      "sms:s1",
    ]);
    expect(result.campanhas.find((c) => c.id === "s1")).toMatchObject({
      total: 100,
      enviados: 95,
      falhas: 5,
    });
    expect(result.campanhas.find((c) => c.id === "v1")).toMatchObject({
      enviados: 30,
      falhas: null,
    });
    expect(result.campanhas.find((c) => c.id === "m1")).toMatchObject({ total: 50, enviados: 0 });
    expect(result.uso_teto).toEqual({
      mes: "2026-11",
      teto_mensal: 500,
      usado_mes: 123.46,
      pendentes: 1,
      pendentes_estimado: 12.5,
    });
    expect(result.alertas_teto_abertos).toEqual([
      { mes: "2026-11", enviado_em: "2026-11-15T10:00:00Z" },
    ]);
  });

  it("rejects an expert of another house", async () => {
    await expect(
      detalheExpert(identity(ADMIN_AB), { casa: HOUSE_A, expert: EXP_B1, periodo: PERIODO }, NOW),
    ).rejects.toThrow(EXPERT_NAO_ENCONTRADO);
  });

  it("rejects a house outside the scope before any query", async () => {
    await expect(
      detalheExpert(identity(ADMIN_AB), { casa: HOUSE_C, expert: EXP_C1, periodo: PERIODO }, NOW),
    ).rejects.toThrow(SEM_ACESSO_CASA);
    expect(rpcTenants.expert_metrics).toBeUndefined();
  });
});

describe("afiliados", () => {
  it("calls the RPC once with exactly the scope's houses", async () => {
    await afiliados(identity(ADMIN_AB), { escopo: todas, periodo: PERIODO }, NOW);
    expect(affiliateCalls).toHaveLength(1);
    expect((affiliateCalls[0]._tenants as string[]).sort()).toEqual([HOUSE_A, HOUSE_B]);
    expect(affiliateCalls[0]).toMatchObject({
      _from: "2026-11-01T03:00:00.000Z",
      _to: "2026-11-17T03:00:00.000Z",
      _affiliate: null,
    });
  });

  it("an affiliate without expert returns its numbers per house with expert null, totals per currency", async () => {
    const result = await afiliados(
      identity(ADMIN_AB),
      { escopo: todas, periodo: PERIODO, affiliate_id: "4512" },
      NOW,
    );
    assertSemDadosPessoais(result);
    expect(result.encontrado).toBe(true);
    expect(result.affiliate_id).toBe("4512");
    expect(result.casas.map((c) => c.id).sort()).toEqual([HOUSE_A, HOUSE_B]);
    const all = result.afiliados_por_moeda.flatMap((g) => g.afiliados);
    expect(all).toHaveLength(2);
    expect(all.every((row) => row.expert === null)).toBe(true);
    expect(result.totais_por_moeda).toEqual([
      expect.objectContaining({
        moeda: "ARS",
        linhas: 1,
        totais: expect.objectContaining({ depositado: 50000 }),
      }),
      expect.objectContaining({
        moeda: "BRL",
        linhas: 1,
        totais: expect.objectContaining({ depositado: 1200, cadastros: 5 }),
      }),
    ]);
  });

  it("an unknown id is encontrado:false, not an error", async () => {
    const result = await afiliados(
      identity(ADMIN_AB),
      { escopo: todas, periodo: PERIODO, affiliate_id: "nao-existe" },
      NOW,
    );
    expect(result).toMatchObject({
      encontrado: false,
      casas: [],
      afiliados_por_moeda: [],
      totais_por_moeda: [],
    });
  });

  it("so_sem_expert lists only unlinked ids; linked ones carry the expert", async () => {
    const all = await afiliados(
      identity(ADMIN_AB),
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO },
      NOW,
    );
    const linked = all.afiliados_por_moeda[0].afiliados.find((row) => row.affiliate_id === "777");
    expect(linked?.expert).toEqual({ id: EXP_A1, nome: "Ana" });

    const semExpert = await afiliados(
      identity(ADMIN_AB),
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO, so_sem_expert: true },
      NOW,
    );
    expect(semExpert.afiliados_por_moeda[0].afiliados.map((row) => row.affiliate_id)).toEqual([
      "4512",
    ]);
  });

  it("orders by cadastros and truncates", async () => {
    const result = await afiliados(
      identity(ADMIN_AB),
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO, ordenar: "cadastros", limite: 1 },
      NOW,
    );
    expect(result.afiliados_por_moeda[0]).toMatchObject({ truncado: true });
    expect(result.afiliados_por_moeda[0].afiliados.map((row) => row.affiliate_id)).toEqual(["777"]);
  });
});

describe("EXPERTS_TOOLS", () => {
  it("registers the three tools with their names", () => {
    expect(EXPERTS_TOOLS.map((tool) => tool.name)).toEqual([
      "ranking_experts",
      "detalhe_expert",
      "afiliados",
    ]);
    expect(EXPERTS_TOOLS[1].scopeOf?.({ casa: HOUSE_A })).toEqual({ tipo: "casa", id: HOUSE_A });
  });
});
