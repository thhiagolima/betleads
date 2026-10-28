// Relatório de rendimento (Task 4): `has_team_profile` de cada casa do
// seletor de casas (`getTenantSwitcherFor`) — verdadeiro só quando o usuário
// tem papel de equipe (HOUSE_MEMBER_ROLES) ali E um perfil `experts` ativo
// com `user_id` = ele, na mesma casa. Uma consulta só para todas as casas.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "./sms-bulk.test-support";
import { getTenantSwitcherFor } from "./tenants.functions";

const TENANT_A = "00000000-0000-4000-8000-00000000a0a0";
const TENANT_B = "00000000-0000-4000-8000-00000000b0b0";
const ADMIN = "00000000-0000-4000-8000-0000000000a1"; // admin of A, has a linked active profile there
const GESTOR_NO_PROFILE = "00000000-0000-4000-8000-0000000000a2"; // gestor of A, no profile
const GESTOR_INACTIVE_PROFILE = "00000000-0000-4000-8000-0000000000a3"; // gestor of A, but profile is inactive
const EXPERT_ONLY = "00000000-0000-4000-8000-0000000000a4"; // expert role (not HOUSE_MEMBER_ROLES) with an active profile
const MEMBER_BOTH = "00000000-0000-4000-8000-0000000000a5"; // member of A and of B, active profile only in A

type Ctx = Parameters<typeof getTenantSwitcherFor>[0];

function ctxFor(userId: string): Ctx {
  return { userId, supabase: {} } as unknown as Ctx;
}

function tenantRow(id: string, nome: string) {
  return {
    id,
    nome,
    slug: nome.toLowerCase(),
    status: "active",
    plano: "pro",
    crm_model: "CRM_PLATAFORMA",
    limits: {},
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    is_demo: false,
  };
}

function expertRow(id: string, userId: string, tenantId: string, ativo: boolean) {
  return {
    id,
    tenant_id: tenantId,
    nome: `Perfil ${id}`,
    tipo: "total",
    ativo,
    envio_modo: "livre",
    teto_mensal: null,
    assumir_prazo_dias: 3,
    user_id: userId,
    ja_vinculado: true,
    created_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", () => ({ data: false, error: null }));
  fake.admin.rows("tenants").push(tenantRow(TENANT_A, "Casa A"), tenantRow(TENANT_B, "Casa B"));
  fake.admin.rows("user_roles").push(
    { id: "r-1", user_id: ADMIN, tenant_id: TENANT_A, role: "admin" },
    { id: "r-2", user_id: GESTOR_NO_PROFILE, tenant_id: TENANT_A, role: "gestor" },
    { id: "r-3", user_id: GESTOR_INACTIVE_PROFILE, tenant_id: TENANT_A, role: "gestor" },
    { id: "r-4", user_id: EXPERT_ONLY, tenant_id: TENANT_A, role: "expert" },
    { id: "r-5", user_id: MEMBER_BOTH, tenant_id: TENANT_A, role: "member" },
    { id: "r-6", user_id: MEMBER_BOTH, tenant_id: TENANT_B, role: "member" },
  );
  fake.admin
    .rows("experts")
    .push(
      expertRow("p-admin", ADMIN, TENANT_A, true),
      expertRow("p-gestor-inactive", GESTOR_INACTIVE_PROFILE, TENANT_A, false),
      expertRow("p-expert-only", EXPERT_ONLY, TENANT_A, true),
      expertRow("p-member", MEMBER_BOTH, TENANT_A, true),
    );
});

describe("getTenantSwitcherFor has_team_profile", () => {
  it("true only with a house role here AND an active linked profile here", async () => {
    const result = await getTenantSwitcherFor(ctxFor(ADMIN));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "admin", has_team_profile: true }),
    ]);
  });

  it("false for a house role with no profile at all", async () => {
    const result = await getTenantSwitcherFor(ctxFor(GESTOR_NO_PROFILE));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "gestor", has_team_profile: false }),
    ]);
  });

  it("false for a house role whose linked profile is inactive", async () => {
    const result = await getTenantSwitcherFor(ctxFor(GESTOR_INACTIVE_PROFILE));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "gestor", has_team_profile: false }),
    ]);
  });

  it("false for an expert role even with an active linked profile (expert is not a house role)", async () => {
    const result = await getTenantSwitcherFor(ctxFor(EXPERT_ONLY));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "expert", has_team_profile: false }),
    ]);
  });

  it("flags only the house where both conditions hold, for someone who belongs to two houses", async () => {
    const result = await getTenantSwitcherFor(ctxFor(MEMBER_BOTH));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "member", has_team_profile: true }),
      expect.objectContaining({ id: TENANT_B, role: "member", has_team_profile: false }),
    ]);
  });

  it("a super admin's displayed role is forced, but has_team_profile still looks at their real membership", async () => {
    // Super admin sees every house (getAccessibleTenants), but `role` is
    // always "super_admin" in the switcher. `has_team_profile` is NOT based
    // on that display role: it reads the real `user_roles` row, same as any
    // other caller — true in A (ADMIN really is admin there, with a
    // profile), false in B (no real membership there at all).
    fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === ADMIN, error: null }));
    const result = await getTenantSwitcherFor(ctxFor(ADMIN));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, role: "super_admin", has_team_profile: true }),
      expect.objectContaining({ id: TENANT_B, role: "super_admin", has_team_profile: false }),
    ]);
  });
});
