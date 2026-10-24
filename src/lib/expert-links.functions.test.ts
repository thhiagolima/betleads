import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { DemoTenantBlockedError } from "@/lib/demo-tenant";
import { ShortenerUnavailableError } from "@/lib/shortio.server";
import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { generateExpertLinkFor } from "./expert-links.functions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const ME = "00000000-0000-4000-8000-0000000000e1";
const DISPATCH = "00000000-0000-4000-8000-0000000000d1";
const CTX = { userId: "u1", activeTenantId: TENANT };
const URL_OK = "https://casa.bet/bonus?promo=VOLTA50";

const EXPERT = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: ME,
  nome: "Eu",
  tipo: "total" as const,
  affiliateIds: ["AFF1"],
};

function seedPlayer(affiliateId: string | null = "AFF1") {
  fake.admin.rows("players").push({
    id: PLAYER,
    tenant_id: TENANT,
    nome: "Maria",
    telefone: "11999990000",
    affiliate_id: affiliateId,
    created_at: "2026-10-01T00:00:00Z",
  });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  mockRequireExpertContext.mockReset();
  mockRequireExpertContext.mockResolvedValue(EXPERT);
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

describe("generateExpertLinkFor", () => {
  it("rejects javascript:, relative and >2048-char urls before any provider call", async () => {
    seedPlayer();
    const bad = [
      "javascript:alert(1)",
      "/bonus?promo=1",
      "casa.bet/bonus",
      "ftp://casa.bet/bonus",
      `https://casa.bet/${"a".repeat(2048)}`,
    ];
    for (const url of bad) {
      await expect(
        generateExpertLinkFor(CTX, { playerId: PLAYER, url, oferta: "Volta 50" }),
      ).rejects.toThrow("Cole um link válido começando com http:// ou https://.");
    }
    for (const oferta of ["", " x ", "a".repeat(61)]) {
      await expect(
        generateExpertLinkFor(CTX, { playerId: PLAYER, url: URL_OK, oferta }),
      ).rejects.toThrow("Dê um nome à oferta (2 a 60 caracteres).");
    }
    expect(mockAssertCanSend).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("rejects a lead outside the restricted expert's reach and writes nothing", async () => {
    seedPlayer("OUTRO");
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });

    await expect(
      generateExpertLinkFor(CTX, { playerId: PLAYER, url: URL_OK, oferta: "Volta 50" }),
    ).rejects.toThrow("Lead não encontrado.");
    expect(mockRequireExpertContext).toHaveBeenCalledWith("u1", TENANT);
    expect(mockAssertCanSend).not.toHaveBeenCalled();
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("demo house is refused by assertTenantCanSendExternally", async () => {
    seedPlayer();
    mockAssertCanSend.mockRejectedValue(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"));

    await expect(
      generateExpertLinkFor(CTX, { playerId: PLAYER, url: URL_OK, oferta: "Volta 50" }),
    ).rejects.toBeInstanceOf(DemoTenantBlockedError);
    expect(mockAssertCanSend).toHaveBeenCalledWith(TENANT);
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("records expert_links with oferta trimmed and returns sentUrl", async () => {
    seedPlayer();
    const result = await generateExpertLinkFor(CTX, {
      playerId: PLAYER,
      url: `  ${URL_OK} `,
      oferta: "  Volta 50  ",
    });

    expect(mockCreateLink).toHaveBeenCalledTimes(1);
    const input = mockCreateLink.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      tenantId: TENANT,
      originalUrl: URL_OK,
      channel: "whatsapp",
      sourceType: "expert",
      sourceId: ME,
      recipientPlayerId: PLAYER,
    });
    expect(String(input.deliveryKey)).toMatch(
      /^expert_links:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const rows = fake.admin.rows("expert_links");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.id,
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      link_dispatch_id: DISPATCH,
      oferta: "Volta 50",
      original_url: URL_OK,
      sent_url: "https://crm.short/s1",
      shortened: true,
    });
    // The row id is the uuid of the delivery key, tying both records together.
    expect(input.deliveryKey).toBe(`expert_links:${result.id}`);
    expect(result).toEqual({ id: result.id, sentUrl: "https://crm.short/s1", shortened: true });
  });

  it("removes the dispatch when the expert_links insert fails", async () => {
    seedPlayer();
    fake.admin.rows("link_dispatches").push({ id: DISPATCH, tenant_id: TENANT });
    fake.admin.failNext("expert_links", "insert", "insert failed");

    await expect(
      generateExpertLinkFor(CTX, { playerId: PLAYER, url: URL_OK, oferta: "Volta 50" }),
    ).rejects.toThrow("insert failed");
    expect(fake.admin.rows("link_dispatches")).toHaveLength(0);
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });

  it("maps ShortenerUnavailableError to the pt-BR message", async () => {
    seedPlayer();
    mockCreateLink.mockRejectedValue(new ShortenerUnavailableError());

    await expect(
      generateExpertLinkFor(CTX, { playerId: PLAYER, url: URL_OK, oferta: "Volta 50" }),
    ).rejects.toThrow("Não foi possível encurtar o link agora. Tente de novo.");
    expect(fake.admin.rows("expert_links")).toHaveLength(0);
  });
});
