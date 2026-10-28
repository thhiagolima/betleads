// Relatório de rendimento — de quem é o relatório (spec §6). Os guards reais
// (`requireExpertContext`, perfil da equipe, admin da casa, `loadExpert`)
// rodam sobre o banco em memória.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import { resolveReportSubject, type ServerContext } from "./expert-report-subject.server";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000a0a9";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const GESTOR = "00000000-0000-4000-8000-0000000000a2";
const MEMBER = "00000000-0000-4000-8000-0000000000a3";
const EXPERT_USER = "00000000-0000-4000-8000-0000000000a5";
const EXPERT_PROFILE = "00000000-0000-4000-8000-0000000000e1";
const TEAM_PROFILE = "00000000-0000-4000-8000-0000000000e2";
const FOREIGN_PROFILE = "00000000-0000-4000-8000-0000000000e9";

const NOT_ADMIN = "Apenas o admin da casa gerencia experts.";
const NO_PROFILE = "Você não tem um perfil de rendimento nesta casa.";

function ctxFor(userId: string, opts: { admin?: boolean } = {}): ServerContext {
  return {
    userId,
    activeTenantId: TENANT,
    supabase: {
      rpc: async (name: string) => {
        if (name === "is_super_admin") return { data: false, error: null };
        if (name === "current_tenant_id") return { data: TENANT, error: null };
        if (name === "is_tenant_admin") return { data: opts.admin ?? false, error: null };
        return { data: null, error: null };
      },
    },
  };
}

function addRole(userId: string, role: string, tenantId = TENANT) {
  fake.admin
    .rows("user_roles")
    .push({ id: `r-${userId}-${tenantId}`, user_id: userId, tenant_id: tenantId, role });
}

function addProfile(id: string, overrides: Record<string, unknown> = {}) {
  fake.admin.rows("experts").push({
    id,
    tenant_id: TENANT,
    nome: "Perfil",
    tipo: "total",
    ativo: true,
    envio_modo: "livre",
    teto_mensal: null,
    assumir_prazo_dias: 3,
    user_id: null,
    ja_vinculado: false,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa", status: "active", is_demo: false });
  addRole(ADMIN, "admin");
  addRole(GESTOR, "gestor");
  addRole(MEMBER, "member");
  addRole(EXPERT_USER, "expert");
  addProfile(EXPERT_PROFILE, { nome: "Ana", tipo: "restrito", user_id: EXPERT_USER });
  addProfile(TEAM_PROFILE, { nome: "Carlos", tipo: "total", user_id: GESTOR });
});

describe("resolveReportSubject", () => {
  it("self subject for an expert, for a team member with an active profile, refused without profile", async () => {
    await expect(resolveReportSubject(ctxFor(EXPERT_USER))).resolves.toEqual({
      tenantId: TENANT,
      expertId: EXPERT_PROFILE,
      nome: "Ana",
      tipoLabel: "Expert restrito",
      viewer: "self",
    });

    await expect(resolveReportSubject(ctxFor(GESTOR), null)).resolves.toEqual({
      tenantId: TENANT,
      expertId: TEAM_PROFILE,
      nome: "Carlos",
      tipoLabel: "Equipe (Gestor)",
      viewer: "self",
    });

    // Membro da equipe sem perfil vinculado.
    await expect(resolveReportSubject(ctxFor(MEMBER))).rejects.toThrow(NO_PROFILE);

    // Perfil da equipe desativado: sem perfil ativo.
    fake.admin.rows("experts").find((e) => e.id === TEAM_PROFILE)!.ativo = false;
    await expect(resolveReportSubject(ctxFor(GESTOR))).rejects.toThrow(NO_PROFILE);
  });

  it("expertId as expert or team member is refused with the admin message", async () => {
    // Nem com o próprio id.
    await expect(resolveReportSubject(ctxFor(EXPERT_USER), EXPERT_PROFILE)).rejects.toThrow(
      NOT_ADMIN,
    );
    await expect(resolveReportSubject(ctxFor(GESTOR), TEAM_PROFILE)).rejects.toThrow(NOT_ADMIN);
    await expect(resolveReportSubject(ctxFor(MEMBER), EXPERT_PROFILE)).rejects.toThrow(NOT_ADMIN);
  });

  it("admin subject of another house is 'Expert não encontrado.'", async () => {
    fake.admin
      .rows("tenants")
      .push({ id: OTHER_TENANT, nome: "Outra", status: "active", is_demo: false });
    addProfile(FOREIGN_PROFILE, { tenant_id: OTHER_TENANT, nome: "De outra casa" });

    await expect(
      resolveReportSubject(ctxFor(ADMIN, { admin: true }), FOREIGN_PROFILE),
    ).rejects.toThrow("Expert não encontrado.");

    // Da própria casa: expert e equipe, inclusive inativos, com o tipo certo.
    fake.admin.rows("experts").find((e) => e.id === EXPERT_PROFILE)!.ativo = false;
    await expect(
      resolveReportSubject(ctxFor(ADMIN, { admin: true }), EXPERT_PROFILE),
    ).resolves.toEqual({
      tenantId: TENANT,
      expertId: EXPERT_PROFILE,
      nome: "Ana",
      tipoLabel: "Expert restrito",
      viewer: "admin",
    });
    await expect(
      resolveReportSubject(ctxFor(ADMIN, { admin: true }), TEAM_PROFILE),
    ).resolves.toMatchObject({
      expertId: TEAM_PROFILE,
      tipoLabel: "Equipe (Gestor)",
      viewer: "admin",
    });
  });
});
