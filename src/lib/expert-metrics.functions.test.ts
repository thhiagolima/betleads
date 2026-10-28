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
  getExpertDashboardFor,
  getExpertDetailFor,
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
      return { data: [{ dia: "2026-10-24", depositado: 100, depositado_clique: 0, depositado_afiliado: 0, cliques: 3 }], error: null };
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

    await expect(
      getExpertDetailFor(ctxFor(ADMIN), { expertId: OTHER_EXPERT }),
    ).rejects.toThrow("Expert não encontrado.");
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
      { id: "link-mine", oferta: "Oferta A", leadNome: "Jogador 1", createdAt: "2026-10-23T00:00:00Z", clicado: true },
    ]);
    expect(result.contatos).toEqual([
      { leadNome: "Jogador 1", resultado: "chamei", createdAt: "2026-10-23T00:00:00Z" },
    ]);
    expect(result.assumidos).toEqual([{ leadNome: "Jogador 1", expiresAt: "2026-10-26T00:00:00Z" }]);
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

    await expect(
      saveExpertSettingsFor(ctxFor(ADMIN), { clickWindowHours: 48 }),
    ).rejects.toThrow();
  });
});
