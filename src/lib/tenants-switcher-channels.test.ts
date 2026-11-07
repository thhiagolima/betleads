// `getTenantSwitcherFor` carries each house's `enabled_channels` (Task 9):
// design docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md
// §4. Source: tenant-channels.server's getTenantChannels (same whole-table
// snapshot the server already caches).
import { beforeEach, describe, expect, it } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";
import { getTenantSwitcherFor } from "./tenants.functions";
import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";

const TENANT_A = "00000000-0000-4000-8000-00000000a0a0";
const TENANT_B = "00000000-0000-4000-8000-00000000b0b0";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000a2";

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

beforeEach(() => {
  fake.admin.reset();
  __resetTenantChannelsCacheForTests();
  fake.admin.rows("tenants").push(tenantRow(TENANT_A, "Casa A"), tenantRow(TENANT_B, "Casa B"));
  fake.admin.rows("user_roles").push(
    { id: "r-1", user_id: ADMIN, tenant_id: TENANT_A, role: "admin" },
    { id: "r-2", user_id: SUPER_ADMIN, tenant_id: TENANT_A, role: "admin" },
  );
});

describe("getTenantSwitcherFor enabled_channels", () => {
  it("casa sem linhas em tenant_channels: sms/email/voice ligados, webpush desligado", async () => {
    fake.admin.onRpc("is_super_admin", () => ({ data: false, error: null }));
    const result = await getTenantSwitcherFor(ctxFor(ADMIN));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, enabled_channels: ["sms", "email", "voice"] }),
    ]);
  });

  it("reflete uma linha desligada da casa", async () => {
    fake.admin.onRpc("is_super_admin", () => ({ data: false, error: null }));
    fake.admin.rows("tenant_channels").push({
      tenant_id: TENANT_A,
      channel: "sms",
      enabled: false,
      disabled_at: "2026-11-06T00:00:00Z",
    });
    const result = await getTenantSwitcherFor(ctxFor(ADMIN));
    expect(result.tenants).toEqual([
      expect.objectContaining({ id: TENANT_A, enabled_channels: ["email", "voice"] }),
    ]);
  });

  it("super admin recebe os canais reais da casa, não todos os quatro", async () => {
    fake.admin.onRpc("is_super_admin", () => ({ data: true, error: null }));
    fake.admin.rows("tenant_groups");
    fake.admin.rows("tenant_channels").push({
      tenant_id: TENANT_A,
      channel: "voice",
      enabled: false,
      disabled_at: "2026-11-06T00:00:00Z",
    });
    const result = await getTenantSwitcherFor(ctxFor(SUPER_ADMIN));
    const houseA = result.tenants.find((tenant) => tenant.id === TENANT_A);
    expect(houseA).toMatchObject({ role: "super_admin", enabled_channels: ["sms", "email"] });
  });
});
