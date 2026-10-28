// Área do Expert — Fase 3, Task 3: server functions de painel e ranking.
// Os guards reais de `tenant-access.server` rodam sobre o banco em memória
// (`createFakeDb`); só `requireExpertContext` é mockado (ele próprio é
// testado em `expert-access.server.test.ts`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const mockRequireExpertContext = vi.fn();
vi.mock("@/lib/expert-access.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/expert-access.server")>(
    "@/lib/expert-access.server",
  );
  return {
    ...actual,
    requireExpertContext: (...args: unknown[]) => mockRequireExpertContext(...args),
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import {
  exportExpertCreditsCsvFor,
  getExpertDashboardFor,
  getExpertDetailFor,
  listExpertCreditsFor,
  listExpertsRankingFor,
  saveExpertSettingsFor,
  type ExpertMetrics,
} from "./expert-metrics.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000a0a9";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const GESTOR = "00000000-0000-4000-8000-0000000000a2";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EXPERT = "00000000-0000-4000-8000-0000000000e2";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";

type Ctx = Parameters<typeof listExpertsRankingFor>[0];

/** The caller's own (JWT) client: active tenant + per-tenant admin check. */
function ctxFor(userId: string, opts: { admin?: boolean } = {}): Ctx {
  return {
    userId,
    activeTenantId: TENANT,
    supabase: {
      rpc: async (name: string) => {
        if (name === "is_super_admin") return { data: false, error: null };
        if (name === "current_tenant_id") return { data: TENANT, error: null };
        if (name === "is_tenant_admin") return { data: opts.admin ?? true, error: null };
        return { data: null, error: null };
      },
    },
  } as unknown as Ctx;
}

const EXPERT_CTX = {
  userId: "u1",
  activeTenantId: TENANT,
  supabase: { rpc: async () => ({ data: null, error: null }) },
};

const EXPERT_CONTEXT = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: ME,
  nome: "Eu",
  tipo: "total" as const,
  affiliateIds: ["AFF1"],
};

function addExpert(id: string, overrides: Record<string, unknown> = {}) {
  fake.admin.rows("experts").push({
    id,
    tenant_id: TENANT,
    nome: "Queiroz",
    tipo: "restrito",
    ativo: true,
    envio_modo: "livre",
    teto_mensal: null,
    assumir_prazo_dias: 3,
    user_id: null,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  });
}

function addCredit(id: string, expertId: string, overrides: Record<string, unknown> = {}) {
  fake.admin.rows("expert_deposit_credits").push({
    deposit_id: id,
    tenant_id: TENANT,
    player_id: PLAYER,
    expert_id: expertId,
    via: "clique",
    valor: 10,
    deposit_at: "2026-10-23T00:00:00Z",
    link_dispatch_id: null,
    click_at: null,
    is_ftd: false,
    is_reativacao: false,
    click_window_hours: 72,
    rule_version: 1,
    computed_at: "2026-10-23T00:00:00Z",
    ...overrides,
  });
}

function metricsRow(expertId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    expert_id: expertId,
    depositado: 0,
    depositado_clique: 0,
    depositado_afiliado: 0,
    depositos: 0,
    depositantes: 0,
    reativacoes: 0,
    ftds: 0,
    links: 0,
    cliques: 0,
    contatos: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  mockRequireExpertContext.mockReset();
  mockRequireExpertContext.mockResolvedValue(EXPERT_CONTEXT);
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa", status: "active", is_demo: false });
  fake.admin.onRpc("expert_metrics", () => ({ data: [], error: null }));
  fake.admin.onRpc("expert_metrics_daily", () => ({ data: [], error: null }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getExpertDashboardFor", () => {
  it("expert dashboard returns only the caller's row", async () => {
    fake.admin.onRpc("expert_metrics", () => ({
      data: [metricsRow(ME, { depositado: 100 }), metricsRow(OTHER_EXPERT, { depositado: 500 })],
      error: null,
    }));
    fake.admin.onRpc("expert_metrics_daily", (args) => {
      expect(args._expert_id).toBe(ME);
      return {
        data: [
          {
            dia: "2026-10-24",
            depositado: 100,
            depositado_clique: 0,
            depositado_afiliado: 0,
            cliques: 3,
          },
        ],
        error: null,
      };
    });

    const result = await getExpertDashboardFor(EXPERT_CTX, {});

    expect(result.metrics.expertId).toBe(ME);
    expect(result.metrics.depositado).toBe(100);
    expect(result.serie).toEqual([{ dia: "2026-10-24", depositado: 100, cliques: 3 }]);
    expect(result.janelaHoras).toBe(72);
  });

  it("uses the house's configured click window", async () => {
    fake.admin.rows("expert_settings").push({ tenant_id: TENANT, click_window_hours: 48 });

    const result = await getExpertDashboardFor(EXPERT_CTX, {});

    expect(result.janelaHoras).toBe(48);
  });
});

describe("listExpertsRankingFor", () => {
  it("refuses non-admin", async () => {
    await expect(listExpertsRankingFor(ctxFor(GESTOR, { admin: false }), {})).rejects.toThrow(
      "Apenas o admin da casa gerencia experts.",
    );
  });

  it("is sorted by depositado desc and maps snake_case to camelCase", async () => {
    addExpert(ME, { nome: "Ana", tipo: "total", ativo: true });
    addExpert(OTHER_EXPERT, { nome: "Bruno", tipo: "restrito", ativo: false });
    fake.admin.onRpc("expert_metrics", () => ({
      data: [
        metricsRow(ME, {
          depositado: 100,
          depositado_clique: 60,
          depositado_afiliado: 40,
          depositos: 2,
          depositantes: 2,
          reativacoes: 1,
          ftds: 1,
          links: 3,
          cliques: 5,
          contatos: 4,
        }),
        metricsRow(OTHER_EXPERT, { depositado: 500 }),
      ],
      error: null,
    }));

    const result = await listExpertsRankingFor(ctxFor(ADMIN), {});

    expect(result.rows.map((r) => r.nome)).toEqual(["Bruno", "Ana"]);
    const ana = result.rows.find((r) => r.nome === "Ana") as ExpertMetrics & {
      nome: string;
      tipo: string;
      ativo: boolean;
    };
    expect(ana).toMatchObject({
      expertId: ME,
      tipo: "total",
      ativo: true,
      depositado: 100,
      depositadoClique: 60,
      depositadoAfiliado: 40,
      depositos: 2,
      depositantes: 2,
      reativacoes: 1,
      ftds: 1,
      links: 3,
      cliques: 5,
      contatos: 4,
    });
  });

  it("zero-fills an expert with no activity in the period", async () => {
    addExpert(ME, { nome: "Ana" });
    const result = await listExpertsRankingFor(ctxFor(ADMIN), {});
    expect(result.rows).toEqual([
      expect.objectContaining({ expertId: ME, depositado: 0, cliques: 0, contatos: 0 }),
    ]);
  });
});

describe("getExpertDetailFor", () => {
  function seedCommon() {
    addExpert(ME, { nome: "Ana", tipo: "total" });
    addExpert(OTHER_EXPERT, { nome: "Bruno", tipo: "total" });
    fake.admin.rows("players").push({ id: PLAYER, tenant_id: TENANT, nome: "Jogador 1" });
  }

  it("detail of an expert from another house is 'Expert não encontrado.'", async () => {
    fake.admin.rows("tenants").push({
      id: OTHER_TENANT,
      nome: "Outra",
      status: "active",
      is_demo: false,
    });
    fake.admin.rows("experts").push({
      id: OTHER_EXPERT,
      tenant_id: OTHER_TENANT,
      nome: "De outra casa",
      tipo: "total",
      ativo: true,
      envio_modo: "livre",
      teto_mensal: null,
      assumir_prazo_dias: 3,
      user_id: null,
      created_at: "2026-10-01T00:00:00Z",
    });

    await expect(getExpertDetailFor(ctxFor(ADMIN), { expertId: OTHER_EXPERT })).rejects.toThrow(
      "Expert não encontrado.",
    );
  });

  it("lists only that expert's links, contacts and active claims", async () => {
    seedCommon();
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));

    fake.admin.rows("expert_links").push(
      {
        id: "link-mine",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        link_dispatch_id: "disp-1",
        oferta: "Oferta A",
        original_url: "https://x",
        sent_url: "https://x",
        shortened: true,
        created_at: "2026-10-23T00:00:00Z",
      },
      {
        id: "link-other",
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        player_id: PLAYER,
        link_dispatch_id: null,
        oferta: "Oferta B",
        original_url: "https://y",
        sent_url: "https://y",
        shortened: true,
        created_at: "2026-10-23T00:00:00Z",
      },
    );
    fake.admin.rows("link_dispatches").push({
      id: "disp-1",
      first_party_first_clicked_at: "2026-10-23T01:00:00Z",
    });
    fake.admin.rows("expert_lead_contacts").push(
      {
        id: "c-mine",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        resultado: "chamei",
        created_at: "2026-10-23T00:00:00Z",
      },
      {
        id: "c-other",
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        player_id: PLAYER,
        resultado: "respondeu",
        created_at: "2026-10-23T00:00:00Z",
      },
    );
    fake.admin.rows("expert_lead_claims").push(
      { tenant_id: TENANT, expert_id: ME, player_id: PLAYER, expires_at: "2026-10-26T00:00:00Z" },
      {
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        player_id: PLAYER,
        expires_at: "2026-10-26T00:00:00Z",
      },
      // Expired claim of mine: must not show up.
      { tenant_id: TENANT, expert_id: ME, player_id: PLAYER, expires_at: "2026-10-20T00:00:00Z" },
    );

    const result = await getExpertDetailFor(ctxFor(ADMIN), { expertId: ME });

    expect(result.expert).toMatchObject({ id: ME, nome: "Ana" });
    expect(result.links).toEqual([
      {
        id: "link-mine",
        oferta: "Oferta A",
        leadNome: "Jogador 1",
        createdAt: "2026-10-23T00:00:00Z",
        clicado: true,
      },
    ]);
    expect(result.contatos).toEqual([
      { leadNome: "Jogador 1", resultado: "chamei", createdAt: "2026-10-23T00:00:00Z" },
    ]);
    expect(result.assumidos).toEqual([
      { leadNome: "Jogador 1", expiresAt: "2026-10-26T00:00:00Z" },
    ]);
  });
});

describe("saveExpertSettingsFor", () => {
  it("validates 1..720 and refreshes the last 8 days", async () => {
    await expect(saveExpertSettingsFor(ctxFor(ADMIN), { clickWindowHours: 0 })).rejects.toThrow();
    await expect(saveExpertSettingsFor(ctxFor(ADMIN), { clickWindowHours: 721 })).rejects.toThrow();

    const refresh = vi.fn((_args: Record<string, unknown>) => ({ data: 0, error: null }));
    fake.admin.onRpc("refresh_expert_credits", refresh);

    const result = await saveExpertSettingsFor(ctxFor(ADMIN), { clickWindowHours: 48 });

    expect(result).toEqual({ clickWindowHours: 48 });
    expect(fake.admin.rows("expert_settings")).toEqual([
      expect.objectContaining({ tenant_id: TENANT, click_window_hours: 48 }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    const args = refresh.mock.calls[0][0] as { _tenant: string; _from: string; _to: string };
    expect(args._tenant).toBe(TENANT);
    expect(new Date(args._to).getTime() - new Date(args._from).getTime()).toBeGreaterThanOrEqual(
      8 * 24 * 60 * 60 * 1000,
    );
  });

  it("refuses on a demo house", async () => {
    fake.admin.rows("tenants")[0].is_demo = true;
    __resetDemoTenantCacheForTests();

    await expect(saveExpertSettingsFor(ctxFor(ADMIN), { clickWindowHours: 48 })).rejects.toThrow();
  });
});

describe("listExpertCreditsFor / exportExpertCreditsCsvFor (Task 8)", () => {
  beforeEach(() => {
    addExpert(ME, { nome: "Ana" });
    addExpert(OTHER_EXPERT, { nome: "Bruno" });
    fake.admin.rows("players").push({ id: PLAYER, tenant_id: TENANT, nome: "Jogador 1" });
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  });

  it("credits list is scoped to the expert and period, paginated by 100, with somaValor of the whole period", async () => {
    for (let i = 0; i < 150; i++) {
      addCredit(`d-${i}`, ME, { deposit_at: "2026-10-23T00:00:00Z", valor: 10 });
    }
    // Outro expert, mesma casa: não deve entrar na lista nem na soma.
    addCredit("d-other-expert", OTHER_EXPERT, { valor: 999 });
    // Fora do período (90+ dias atrás): não deve entrar.
    addCredit("d-old", ME, { deposit_at: "2025-01-01T00:00:00Z", valor: 999 });

    const page0 = await listExpertCreditsFor(ctxFor(ADMIN), { expertId: ME, period: "30" });
    expect(page0.rows).toHaveLength(100);
    expect(page0.total).toBe(150);
    expect(page0.somaValor).toBe(1500);
    expect(page0.rows.every((r) => r.leadNome === "Jogador 1")).toBe(true);

    const page1 = await listExpertCreditsFor(ctxFor(ADMIN), {
      expertId: ME,
      period: "30",
      page: 1,
    });
    expect(page1.rows).toHaveLength(50);
    expect(page1.total).toBe(150);
    expect(page1.somaValor).toBe(1500);
  });

  it("maps oferta from expert_links by link_dispatch_id, same tenant", async () => {
    addCredit("d-1", ME, {
      link_dispatch_id: "disp-1",
      click_at: "2026-10-22T23:00:00Z",
      is_ftd: true,
      is_reativacao: false,
      via: "clique",
      valor: 50,
    });
    fake.admin.rows("expert_links").push({
      id: "link-1",
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      link_dispatch_id: "disp-1",
      oferta: "Oferta A",
      original_url: "https://x",
      sent_url: "https://x",
      shortened: true,
      created_at: "2026-10-22T00:00:00Z",
    });

    const result = await listExpertCreditsFor(ctxFor(ADMIN), { expertId: ME, period: "30" });

    expect(result.rows).toEqual([
      {
        depositId: "d-1",
        depositAt: "2026-10-23T00:00:00Z",
        leadNome: "Jogador 1",
        valor: 50,
        via: "clique",
        oferta: "Oferta A",
        clickAt: "2026-10-22T23:00:00Z",
        isFtd: true,
        isReativacao: false,
      },
    ]);
  });

  it("csv has the exact header, ';' separator, BOM, comma decimals, São Paulo dates and a Total line", async () => {
    addCredit("d-1", ME, {
      deposit_at: "2026-10-23T15:30:00Z", // 12:30 em São Paulo
      click_at: "2026-10-23T14:00:00Z", // 11:00 em São Paulo
      valor: 1234.5,
      via: "afiliado",
      is_ftd: true,
      is_reativacao: true,
    });

    const result = await exportExpertCreditsCsvFor(ctxFor(ADMIN), { expertId: ME, period: "30" });

    expect(result.csv.startsWith("﻿")).toBe(true);
    const lines = result.csv.slice(1).split("\n");
    expect(lines[0]).toBe("Data;Lead;Valor;Origem;Oferta;Clique em;Primeiro depósito;Reativação");
    expect(lines[1]).toBe("23/10/2026 12:30;Jogador 1;1234,50;Afiliado;;23/10/2026 11:00;Sim;Sim");
    expect(lines[2]).toBe("Total;;1234,50;;;;;");
    expect(result.filename).toBe("extrato-ana-2026-09-25-a-2026-10-24.csv");
  });

  it("statement and csv follow the calendar month periods", async () => {
    addCredit("d-sep", ME, { deposit_at: "2026-09-30T23:00:00Z", valor: 10 }); // 30/09 20:00 SP
    addCredit("d-oct-start", ME, { deposit_at: "2026-10-01T03:00:00Z", valor: 20 }); // 01/10 00:00 SP
    addCredit("d-oct", ME, { deposit_at: "2026-10-23T15:30:00Z", valor: 30 });

    const lastMonth = await exportExpertCreditsCsvFor(ctxFor(ADMIN), {
      expertId: ME,
      period: "mes_anterior",
    });
    expect(lastMonth.filename).toBe("extrato-ana-2026-09-01-a-2026-09-30.csv");
    expect(lastMonth.csv.slice(1).split("\n").at(-1)).toBe("Total;;10,00;;;;;");

    const thisMonth = await listExpertCreditsFor(ctxFor(ADMIN), {
      expertId: ME,
      period: "mes_atual",
    });
    expect(thisMonth.rows.map((r) => r.depositAt).sort()).toEqual([
      "2026-10-01T03:00:00Z",
      "2026-10-23T15:30:00Z",
    ]);
  });

  it("csv escapes lead names containing ';' or quotes", async () => {
    fake.admin.rows("players")[0].nome = 'Lead "Esperto"; Silva';
    addCredit("d-1", ME, { deposit_at: "2026-10-23T03:00:00Z", valor: 10 }); // 00:00 em São Paulo

    const result = await exportExpertCreditsCsvFor(ctxFor(ADMIN), { expertId: ME, period: "30" });
    const lines = result.csv.slice(1).split("\n");

    expect(lines[1]).toBe('23/10/2026 00:00;"Lead ""Esperto""; Silva";10,00;Clique;;;Não;Não');
  });

  it("listExpertCredits without expertId serves the caller's own statement; with expertId requires admin", async () => {
    addCredit("d-mine", ME, { valor: 10 });
    addCredit("d-other", OTHER_EXPERT, { valor: 999 });

    // Expert (requireExpertContext → ME): o próprio extrato, sem expertId.
    const own = await listExpertCreditsFor(EXPERT_CTX, { period: "30" });
    expect(own.rows.map((r) => r.depositId)).toEqual(["d-mine"]);
    expect(own.somaValor).toBe(10);
    const ownCsv = await exportExpertCreditsCsvFor(EXPERT_CTX, { period: "30" });
    expect(ownCsv.filename).toBe("extrato-eu-2026-09-25-a-2026-10-24.csv");
    expect(ownCsv.csv.slice(1).split("\n").at(-1)).toBe("Total;;10,00;;;;;");

    // Com expertId, mesmo o próprio, o expert cai na recusa de admin (a
    // recusa confere o acesso real de expert: `resolveExpertContext`).
    fake.admin.rows("user_roles").push({ user_id: "u1", tenant_id: TENANT, role: "expert" });
    fake.admin.rows("experts").find((e) => e.id === ME)!.user_id = "u1";
    await expect(listExpertCreditsFor(EXPERT_CTX, { expertId: ME })).rejects.toThrow(
      "Apenas o admin da casa gerencia experts.",
    );
    await expect(exportExpertCreditsCsvFor(EXPERT_CTX, { expertId: OTHER_EXPERT })).rejects.toThrow(
      "Apenas o admin da casa gerencia experts.",
    );

    // Admin com expertId: o extrato do perfil pedido.
    const asAdmin = await listExpertCreditsFor(ctxFor(ADMIN), {
      expertId: OTHER_EXPERT,
      period: "30",
    });
    expect(asAdmin.rows.map((r) => r.depositId)).toEqual(["d-other"]);
  });

  it("credits endpoints refuse non-admin and experts of another house", async () => {
    await expect(
      listExpertCreditsFor(ctxFor(GESTOR, { admin: false }), { expertId: ME }),
    ).rejects.toThrow("Apenas o admin da casa gerencia experts.");
    await expect(
      exportExpertCreditsCsvFor(ctxFor(GESTOR, { admin: false }), { expertId: ME }),
    ).rejects.toThrow("Apenas o admin da casa gerencia experts.");

    fake.admin.rows("tenants").push({
      id: OTHER_TENANT,
      nome: "Outra",
      status: "active",
      is_demo: false,
    });
    const EXPERT_OF_OTHER_HOUSE = "00000000-0000-4000-8000-0000000000e9";
    fake.admin.rows("experts").push({
      id: EXPERT_OF_OTHER_HOUSE,
      tenant_id: OTHER_TENANT,
      nome: "De outra casa",
      tipo: "total",
      ativo: true,
      envio_modo: "livre",
      teto_mensal: null,
      assumir_prazo_dias: 3,
      user_id: null,
      created_at: "2026-10-01T00:00:00Z",
    });
    await expect(
      listExpertCreditsFor(ctxFor(ADMIN), { expertId: EXPERT_OF_OTHER_HOUSE }),
    ).rejects.toThrow("Expert não encontrado.");
    await expect(
      exportExpertCreditsCsvFor(ctxFor(ADMIN), { expertId: EXPERT_OF_OTHER_HOUSE }),
    ).rejects.toThrow("Expert não encontrado.");
  });
});
