// Área do Expert — Fase 3, Task 7: perfil de rendimento da equipe. Os
// guards reais (`resolveOperationalTenantForRequest`, papel da equipe,
// perfil ativo, jogador da casa) rodam sobre o banco em memória; só o
// Short.io e o bloqueio de envio externo são simulados.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const mockAssertCanSend = vi.fn();
vi.mock("@/lib/tenant-access.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant-access.server")>(
    "@/lib/tenant-access.server",
  );
  return {
    ...actual,
    assertTenantCanSendExternally: (...args: unknown[]) => mockAssertCanSend(...args),
  };
});

const mockCreateLink = vi.fn();
vi.mock("@/lib/shortio.server", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/shortio.server")>("@/lib/shortio.server");
  return {
    ...actual,
    createTrackedLinkForRecipient: (...args: unknown[]) => mockCreateLink(...args),
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import { generateTeamTrackedLinkFor, getMyTeamExpertProfileFor } from "./team-expert.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000b0b0";
const GESTOR = "00000000-0000-4000-8000-0000000000a2";
const MEMBER = "00000000-0000-4000-8000-0000000000a4";
const EXPERT_USER = "00000000-0000-4000-8000-0000000000a5";
const PROFILE = "00000000-0000-4000-8000-0000000000e1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const FOREIGN_PLAYER = "00000000-0000-4000-8000-0000000000b2";
const DISPATCH = "00000000-0000-4000-8000-0000000000d1";
const URL_OK = "https://casa.bet/bonus?promo=VOLTA50";
const NO_PROFILE = "Você não tem um perfil de rendimento nesta casa.";

type Ctx = Parameters<typeof generateTeamTrackedLinkFor>[0];

function ctxFor(userId: string): Ctx {
  return {
    userId,
    supabase: {
      rpc: async (name: string) => {
        if (name === "is_super_admin") return { data: false, error: null };
        if (name === "current_tenant_id") return { data: TENANT, error: null };
        return { data: null, error: null };
      },
    },
  } as unknown as Ctx;
}

function addRole(userId: string, role: string, tenantId = TENANT) {
  fake.admin
    .rows("user_roles")
    .push({ id: `r-${userId}-${tenantId}`, user_id: userId, tenant_id: tenantId, role });
}

function addProfile(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("experts").push({
    id: PROFILE,
    tenant_id: TENANT,
    nome: "Gestor Carlos",
    tipo: "total",
    ativo: true,
    envio_modo: "livre",
    teto_mensal: null,
    assumir_prazo_dias: 3,
    user_id: GESTOR,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  fake.admin
    .rows("tenants")
    .push(
      { id: TENANT, nome: "Casa", status: "active", is_demo: false },
      { id: OTHER_TENANT, nome: "Outra", status: "active", is_demo: false },
    );
  fake.admin
    .rows("players")
    .push(
      { id: PLAYER, tenant_id: TENANT, nome: "Maria", telefone: "11999990000" },
      { id: FOREIGN_PLAYER, tenant_id: OTHER_TENANT, nome: "João", telefone: "11988880000" },
    );
  mockAssertCanSend.mockReset();
  mockAssertCanSend.mockResolvedValue(undefined);
  mockCreateLink.mockReset();
  mockCreateLink.mockResolvedValue({
    sentUrl: "https://crm.short/s1",
    dispatchId: DISPATCH,
    trackingToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    shortened: true,
  });
});

describe("team performance profile", () => {
  it("gestor with a linked active profile generates a link credited to that profile", async () => {
    addRole(GESTOR, "gestor");
    addProfile();

    await expect(getMyTeamExpertProfileFor(ctxFor(GESTOR))).resolves.toEqual({
      expertId: PROFILE,
      nome: "Gestor Carlos",
    });

    const result = await generateTeamTrackedLinkFor(ctxFor(GESTOR), {
      playerId: PLAYER,
      url: URL_OK,
      oferta: "Volta 50",
    });

    expect(mockAssertCanSend).toHaveBeenCalledWith(TENANT);
    expect(mockCreateLink).toHaveBeenCalledTimes(1);
    expect(mockCreateLink.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      originalUrl: URL_OK,
      channel: "whatsapp",
      sourceType: "expert",
      sourceId: PROFILE,
      recipientPlayerId: PLAYER,
      deliveryKey: `expert_links:${result.id}`,
    });
    expect(fake.admin.rows("expert_links")).toEqual([
      expect.objectContaining({
        id: result.id,
        tenant_id: TENANT,
        expert_id: PROFILE,
        player_id: PLAYER,
        link_dispatch_id: DISPATCH,
        oferta: "Volta 50",
      }),
    ]);
    expect(result).toEqual({ id: result.id, sentUrl: "https://crm.short/s1", shortened: true });
    // The profile only measures: the person's house access is untouched.
    expect(fake.admin.rows("user_roles")).toEqual([
      expect.objectContaining({ user_id: GESTOR, tenant_id: TENANT, role: "gestor" }),
    ]);
  });

  it("member without a profile is refused with the pt-BR message", async () => {
    addRole(MEMBER, "member");
    addProfile(); // someone else's profile

    await expect(getMyTeamExpertProfileFor(ctxFor(MEMBER))).resolves.toBeNull();
    await expect(
      generateTeamTrackedLinkFor(ctxFor(MEMBER), {
        playerId: PLAYER,
        url: URL_OK,
        oferta: "Volta 50",
      }),
    ).rejects.toThrow(NO_PROFILE);
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("expert role users cannot use the team path", async () => {
    addRole(EXPERT_USER, "expert");
    addProfile({ user_id: EXPERT_USER });

    await expect(getMyTeamExpertProfileFor(ctxFor(EXPERT_USER))).resolves.toBeNull();
    await expect(
      generateTeamTrackedLinkFor(ctxFor(EXPERT_USER), {
        playerId: PLAYER,
        url: URL_OK,
        oferta: "Volta 50",
      }),
    ).rejects.toThrow(NO_PROFILE);
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it("player of another house is 'Jogador não encontrado.'", async () => {
    addRole(GESTOR, "gestor");
    addProfile();

    await expect(
      generateTeamTrackedLinkFor(ctxFor(GESTOR), {
        playerId: FOREIGN_PLAYER,
        url: URL_OK,
        oferta: "Volta 50",
      }),
    ).rejects.toThrow("Jogador não encontrado.");
    expect(mockAssertCanSend).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("a team member of another house is refused in this house and nothing is written", async () => {
    // Gestor (with an active profile) of OTHER_TENANT; the request resolves TENANT.
    addRole(GESTOR, "gestor", OTHER_TENANT);
    addProfile({ tenant_id: OTHER_TENANT });

    await expect(getMyTeamExpertProfileFor(ctxFor(GESTOR))).resolves.toBeNull();
    await expect(
      generateTeamTrackedLinkFor(ctxFor(GESTOR), {
        playerId: PLAYER,
        url: URL_OK,
        oferta: "Volta 50",
      }),
    ).rejects.toThrow(NO_PROFILE);
    expect(mockAssertCanSend).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
    expect(fake.admin.rows("link_dispatches")).toHaveLength(0);
  });

  it("inactive profile is treated as no profile", async () => {
    addRole(GESTOR, "gestor");
    addProfile({ ativo: false });

    await expect(getMyTeamExpertProfileFor(ctxFor(GESTOR))).resolves.toBeNull();
    await expect(
      generateTeamTrackedLinkFor(ctxFor(GESTOR), {
        playerId: PLAYER,
        url: URL_OK,
        oferta: "Volta 50",
      }),
    ).rejects.toThrow(NO_PROFILE);
    expect(mockCreateLink).not.toHaveBeenCalled();
  });
});
