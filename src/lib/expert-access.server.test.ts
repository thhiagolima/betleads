import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/tenant-access.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant-access.server")>(
    "@/lib/tenant-access.server",
  );
  return { ...actual, assertTenantCanOperate: vi.fn(actual.assertTenantCanOperate) };
});

import { TenantBillingLockedError } from "@/lib/billing/billing-locked-error";
import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { assertTenantCanOperate } from "@/lib/tenant-access.server";
import { ExpertAccessError, requireExpertContext, resolveExpertContext } from "./expert-access.server";

const USER = "00000000-0000-4000-8000-000000000001";
const TENANT_1 = "00000000-0000-4000-8000-0000000000a1";
const TENANT_2 = "00000000-0000-4000-8000-0000000000a2";

beforeEach(async () => {
  // expert-access.server.ts only touches `client.server` inside its function
  // bodies, so force the mocked factory to run before each test resets it.
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
});

function seedExpertHouse(tenantId: string, opts: { nome: string; tipo?: "restrito" | "total"; ativo?: boolean; affiliateIds?: string[] } = { nome: "Fulano" }) {
  fake.admin.rows("user_roles").push({ user_id: USER, tenant_id: tenantId, role: "expert" });
  const expertId = `expert-${tenantId}`;
  fake.admin.rows("experts").push({
    id: expertId,
    tenant_id: tenantId,
    user_id: USER,
    nome: opts.nome,
    tipo: opts.tipo ?? "restrito",
    ativo: opts.ativo ?? true,
  });
  fake.admin.rows("tenants").push({ id: tenantId, nome: `Casa ${tenantId}` });
  for (const affiliateId of opts.affiliateIds ?? []) {
    fake.admin.rows("expert_affiliates").push({ tenant_id: tenantId, expert_id: expertId, affiliate_id: affiliateId });
  }
  return expertId;
}

describe("resolveExpertContext", () => {
  it("returns null for a user without expert role", async () => {
    const result = await resolveExpertContext(USER);
    expect(result).toBeNull();
  });

  it("ignores inactive experts", async () => {
    seedExpertHouse(TENANT_1, { nome: "Fulano", ativo: false });

    const result = await resolveExpertContext(USER);
    expect(result).toBeNull();
  });

  it("picks the requested house when the user is expert there", async () => {
    seedExpertHouse(TENANT_1, { nome: "Fulano", affiliateIds: ["AFF1"] });
    seedExpertHouse(TENANT_2, { nome: "Fulano", tipo: "total", affiliateIds: [] });

    const result = await resolveExpertContext(USER, TENANT_2);

    expect(result).toEqual({
      tenantId: TENANT_2,
      tenantNome: `Casa ${TENANT_2}`,
      expertId: `expert-${TENANT_2}`,
      nome: "Fulano",
      tipo: "total",
      affiliateIds: [],
      envioModo: "livre",
      tetoMensal: null,
    });
  });

  it("returns null when the requested house is not one of the expert's", async () => {
    seedExpertHouse(TENANT_1, { nome: "Fulano" });

    const result = await resolveExpertContext(USER, TENANT_2);
    expect(result).toBeNull();
  });
});

describe("requireExpertContext", () => {
  it("throws ExpertAccessError with pt-BR message", async () => {
    await expect(requireExpertContext(USER)).rejects.toThrow(ExpertAccessError);
    await expect(requireExpertContext(USER)).rejects.toThrow(
      "Acesso de expert não encontrado ou desativado.",
    );

    seedExpertHouse(TENANT_1, { nome: "Fulano" });
    fake.admin.rows("tenants")[0].status = "suspended";

    await expect(requireExpertContext(USER)).rejects.toThrow(ExpertAccessError);
    await expect(requireExpertContext(USER)).rejects.toThrow(
      "Esta casa está indisponível no momento.",
    );
  });
});

describe("requireExpertContext: which tenant errors mean 'unavailable'", () => {
  it("maps a billing lock to the unavailable message", async () => {
    seedExpertHouse(TENANT_1, { nome: "Fulano" });
    vi.mocked(assertTenantCanOperate).mockRejectedValueOnce(new TenantBillingLockedError());
    await expect(requireExpertContext(USER)).rejects.toThrow(
      new ExpertAccessError("Esta casa está indisponível no momento."),
    );
  });

  it("rethrows (and logs) a DB/network failure instead of masking it", async () => {
    seedExpertHouse(TENANT_1, { nome: "Fulano" });
    const failure = new Error("connection reset by peer");
    vi.mocked(assertTenantCanOperate).mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await requireExpertContext(USER).catch((e: unknown) => e);
      expect(err).toBe(failure);
      expect(err).not.toBeInstanceOf(ExpertAccessError);
      expect(log).toHaveBeenCalledWith(
        "[expert-access] tenant status check failed",
        expect.objectContaining({ tenantId: TENANT_1, cause: failure }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
