// Área do Expert — Fase 1, Task 6: server functions do admin para experts.
// Os guards reais de `tenant-access.server` rodam sobre um banco em memória
// (`createFakeDb`); só o Supabase Auth é simulado à parte.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  authUsers: [] as Array<{ id: string; email: string; last_sign_in_at?: string | null }>,
  invited: [] as Array<{ email: string; options: unknown }>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      auth: {
        admin: {
          listUsers: async () => ({ data: { users: fake.authUsers }, error: null }),
          getUserById: async (id: string) => {
            const user = fake.authUsers.find((u) => u.id === id) ?? null;
            return user
              ? { data: { user }, error: null }
              : { data: { user: null }, error: { message: "User not found" } };
          },
          inviteUserByEmail: async (email: string, options: unknown) => {
            fake.invited.push({ email, options });
            const user = { id: `invited-${fake.invited.length}`, email, last_sign_in_at: null };
            fake.authUsers.push(user);
            return { data: { user }, error: null };
          },
        },
      },
    },
  };
});

import { createFakeDb } from "./sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import {
  deleteExpertFor,
  inviteExpertFor,
  listExpertsFor,
  saveExpertFor,
  setExpertActiveFor,
} from "./experts-admin.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const GESTOR = "00000000-0000-4000-8000-0000000000a2";
const SUPER = "00000000-0000-4000-8000-0000000000a3";
const EXPERT_ID = "00000000-0000-4000-8000-0000000000e1";

type Ctx = Parameters<typeof saveExpertFor>[0];

/** The caller's own (JWT) client: active tenant + per-tenant admin check. */
function ctxFor(userId: string, opts: { admin?: boolean } = {}): Ctx {
  return {
    userId,
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

function addExpert(overrides: Record<string, unknown> = {}) {
  const row = {
    id: EXPERT_ID,
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
  };
  fake.admin.rows("experts").push(row);
  return row;
}

const saveInput = {
  nome: "Queiroz",
  tipo: "restrito" as const,
  affiliateIds: ["abc123"],
  envioModo: "livre" as const,
  tetoMensal: null,
  assumirPrazoDias: 3,
};

beforeEach(() => {
  fake.admin.reset();
  fake.authUsers.length = 0;
  fake.invited.length = 0;
  __resetDemoTenantCacheForTests();
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa", status: "active", is_demo: false });
  fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER, error: null }));
  fake.admin.onRpc("save_expert", () => ({ data: EXPERT_ID, error: null }));
});

describe("experts admin server functions", () => {
  it("refuses non-admin callers", async () => {
    await expect(listExpertsFor(ctxFor(GESTOR, { admin: false }))).rejects.toThrow(
      "Apenas o admin da casa gerencia experts.",
    );
    await expect(saveExpertFor(ctxFor(GESTOR, { admin: false }), saveInput)).rejects.toThrow(
      "Apenas o admin da casa gerencia experts.",
    );
  });

  it("maps affiliate_taken to the pt-BR message", async () => {
    fake.admin.onRpc("save_expert", () => ({
      data: null,
      error: { message: "affiliate_taken:abc123", code: "P0001" } as never,
    }));
    await expect(saveExpertFor(ctxFor(ADMIN), saveInput)).rejects.toThrow(
      "O ID de afiliado abc123 já pertence a outro expert desta casa.",
    );
  });

  it("maps a concurrent expert_affiliates unique violation to affiliate_taken", async () => {
    fake.admin.onRpc("save_expert", () => ({
      data: null,
      error: {
        message:
          'duplicate key value violates unique constraint "expert_affiliates_tenant_id_affiliate_id_key"',
        code: "23505",
        details: `Key (tenant_id, affiliate_id)=(${TENANT}, ff00aa) already exists.`,
      } as never,
    }));
    await expect(saveExpertFor(ctxFor(ADMIN), saveInput)).rejects.toThrow(
      "O ID de afiliado ff00aa já pertence a outro expert desta casa.",
    );
  });

  it("maps duplicate name to the pt-BR message", async () => {
    fake.admin.onRpc("save_expert", () => ({
      data: null,
      error: {
        message: 'duplicate key value violates unique constraint "experts_tenant_nome_uniq"',
        code: "23505",
      } as never,
    }));
    await expect(saveExpertFor(ctxFor(ADMIN), saveInput)).rejects.toThrow(
      "Já existe um expert com esse nome nesta casa.",
    );
  });

  it("saves through save_expert and audits expert.saved", async () => {
    let args: Record<string, unknown> = {};
    fake.admin.onRpc("save_expert", (a) => {
      args = a;
      return { data: EXPERT_ID, error: null };
    });
    await expect(
      saveExpertFor(ctxFor(ADMIN), { ...saveInput, affiliateIds: [" abc123 "] }),
    ).resolves.toEqual({ id: EXPERT_ID });
    expect(args).toMatchObject({
      _tenant: TENANT,
      _expert_id: null,
      _nome: "Queiroz",
      _affiliate_ids: ["abc123"],
      _assumir_prazo_dias: 3,
    });
    expect(fake.admin.rows("tenant_audit_logs").map((r) => r.action)).toEqual(["expert.saved"]);
  });

  it("invite refuses an email that already has a role in the house", async () => {
    addExpert();
    fake.authUsers.push({ id: GESTOR, email: "gestor@casa.com" });
    fake.admin.rows("user_roles").push({ id: "r1", user_id: GESTOR, tenant_id: TENANT, role: "gestor" });
    await expect(
      inviteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID, email: "Gestor@Casa.com" }),
    ).rejects.toThrow(
      "Este e-mail já tem acesso a esta casa como Gestor. Uma pessoa não pode ter dois papéis na mesma casa.",
    );
    expect(fake.admin.rows("experts")[0].user_id).toBeNull();
  });

  it("invite refuses a super admin email", async () => {
    addExpert();
    fake.authUsers.push({ id: SUPER, email: "root@betleads.com" });
    await expect(
      inviteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID, email: "root@betleads.com" }),
    ).rejects.toThrow("Este e-mail é de um super admin.");
  });

  it("invite refuses an expert that already has access", async () => {
    addExpert({ user_id: GESTOR });
    await expect(
      inviteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID, email: "novo@casa.com" }),
    ).rejects.toThrow(
      "Este expert já tem acesso. Remova o acesso antes de convidar outra pessoa.",
    );
  });

  it("invite inserts expert role and links user_id", async () => {
    addExpert();
    await inviteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID, email: "Expert@Casa.com" });

    expect(fake.invited).toEqual([
      {
        email: "expert@casa.com",
        options: { data: { invited_by: ADMIN, tenant_id: TENANT } },
      },
    ]);
    const userId = fake.authUsers[0].id;
    expect(fake.admin.rows("user_roles")).toEqual([
      expect.objectContaining({ user_id: userId, tenant_id: TENANT, role: "expert" }),
    ]);
    expect(fake.admin.rows("experts")[0].user_id).toBe(userId);
    expect(fake.admin.rows("tenant_audit_logs").map((r) => r.action)).toEqual(["expert.invited"]);
  });

  it("acesso is convite_pendente before first sign-in and inativo when deactivated", async () => {
    addExpert({ user_id: "u-expert" });
    fake.authUsers.push({ id: "u-expert", email: "e@casa.com", last_sign_in_at: null });
    fake.admin.rows("expert_affiliates").push({
      id: "ea1",
      tenant_id: TENANT,
      expert_id: EXPERT_ID,
      affiliate_id: "abc123",
    });
    fake.admin.rows("players").push(
      { id: "p1", tenant_id: TENANT, affiliate_id: "abc123" },
      { id: "p2", tenant_id: TENANT, affiliate_id: "other" },
    );

    const [row] = await listExpertsFor(ctxFor(ADMIN));
    expect(row).toMatchObject({
      id: EXPERT_ID,
      acesso: "convite_pendente",
      email: "e@casa.com",
      affiliateIds: ["abc123"],
      leads: 1,
    });

    await setExpertActiveFor(ctxFor(ADMIN), { expertId: EXPERT_ID, ativo: false });
    const [after] = await listExpertsFor(ctxFor(ADMIN));
    expect(after.acesso).toBe("inativo");

    fake.admin.rows("experts")[0].ativo = true;
    fake.authUsers[0].last_sign_in_at = "2026-10-20T00:00:00Z";
    const [signedIn] = await listExpertsFor(ctxFor(ADMIN));
    expect(signedIn.acesso).toBe("ativo");
  });

  it("delete refuses expert with user", async () => {
    addExpert({ user_id: "u-expert" });
    fake.admin.onRpc("delete_expert", () => ({
      data: null,
      error: { message: "expert_has_user", code: "P0001" } as never,
    }));
    await expect(deleteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID })).rejects.toThrow(
      "Remova o acesso do expert antes de excluir.",
    );
  });

  it("writes refuse demo houses", async () => {
    fake.admin.rows("tenants")[0].is_demo = true;
    addExpert();
    await expect(saveExpertFor(ctxFor(ADMIN), saveInput)).rejects.toThrow(/demonstra/i);
    await expect(
      inviteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID, email: "e@casa.com" }),
    ).rejects.toThrow(/demonstra/i);
    await expect(
      setExpertActiveFor(ctxFor(ADMIN), { expertId: EXPERT_ID, ativo: false }),
    ).rejects.toThrow(/demonstra/i);
    await expect(deleteExpertFor(ctxFor(ADMIN), { expertId: EXPERT_ID })).rejects.toThrow(
      /demonstra/i,
    );
    expect(fake.admin.rows("experts")[0].ativo).toBe(true);
  });
});
