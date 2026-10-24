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

import { DemoTenantBlockedError } from "@/lib/demo-tenant";
import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { suggestExpertApproachFor } from "./expert-ai.functions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const ME = "00000000-0000-4000-8000-0000000000e1";
const CTX = { userId: "u1", activeTenantId: TENANT };

const EXPERT = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: ME,
  nome: "Eu",
  tipo: "total" as const,
  affiliateIds: ["AFF1"],
};

function seedPlayer(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("players").push({
    id: PLAYER,
    tenant_id: TENANT,
    nome: "Maria Silva",
    telefone: "11999990000",
    affiliate_id: "AFF1",
    total_depositado: 0,
    total_sacado: 0,
    ultimo_deposito: null,
    ftd_em: null,
    created_at: "2026-10-01T00:00:00Z",
    risco: "baixo",
    vip: false,
    saldo_bonus: 0,
    ...overrides,
  });
}

function okGenerate(text: string) {
  return vi.fn().mockResolvedValue({ text });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  mockRequireExpertContext.mockReset();
  mockRequireExpertContext.mockResolvedValue(EXPERT);
  mockAssertCanSend.mockReset();
  mockAssertCanSend.mockResolvedValue(undefined);
});

describe("suggestExpertApproachFor", () => {
  it("prompt contains the lead summary and never the phone or full name", async () => {
    seedPlayer({
      total_depositado: 300,
      ftd_em: "2026-10-01T00:00:00Z",
      ultimo_deposito: "2026-10-10T00:00:00Z",
    });
    fake.admin.rows("expert_lead_contacts").push({
      id: "k1",
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      resultado: "sem_interesse",
      nota: null,
      created_at: "2026-10-11T00:00:00Z",
    });
    const generate = okGenerate('{"oferta":"Volta 50","mensagem":"Oi {link}"}');

    await suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate });

    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0][0] as { system: string; prompt: string };
    const combined = `${call.system}\n${call.prompt}`;
    expect(combined).toContain("Maria");
    expect(combined).not.toContain("Silva");
    expect(combined).not.toContain("11999990000");
    expect(combined).toContain("Sem interesse");
  });

  it("parses {oferta, mensagem} and truncates mensagem to 400", async () => {
    seedPlayer();
    const longMsg = "a".repeat(450);
    const generate = okGenerate(JSON.stringify({ oferta: "Giros", mensagem: longMsg }));

    const result = await suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate });

    expect(result.oferta).toBe("Giros");
    expect(result.mensagem).toHaveLength(400);
    expect(result.mensagem).toBe(longMsg.slice(0, 400));
  });

  it("parses JSON wrapped in ```json fences", async () => {
    seedPlayer();
    const generate = okGenerate('```json\n{"oferta":"Bônus","mensagem":"Olá!"}\n```');

    const result = await suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate });

    expect(result).toEqual({ oferta: "Bônus", mensagem: "Olá!" });
  });

  it("invalid model output maps to the pt-BR retry message", async () => {
    seedPlayer();
    const generate = okGenerate("isto não é json");

    await expect(
      suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate }),
    ).rejects.toThrow("A IA não conseguiu sugerir agora. Tente de novo.");
  });

  it("model output missing oferta/mensagem maps to the pt-BR retry message", async () => {
    seedPlayer();
    const generate = okGenerate(JSON.stringify({ oferta: "Giros" }));

    await expect(
      suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate }),
    ).rejects.toThrow("A IA não conseguiu sugerir agora. Tente de novo.");
  });

  it("demo house is refused before calling the model", async () => {
    seedPlayer();
    mockAssertCanSend.mockRejectedValue(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"));
    const generate = okGenerate('{"oferta":"x","mensagem":"y"}');

    await expect(
      suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate }),
    ).rejects.toBeInstanceOf(DemoTenantBlockedError);
    expect(mockAssertCanSend).toHaveBeenCalledWith(TENANT);
    expect(generate).not.toHaveBeenCalled();
  });

  it("lead outside reach is refused before calling the model", async () => {
    seedPlayer({ affiliate_id: "OUTRO" });
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });
    const generate = okGenerate('{"oferta":"x","mensagem":"y"}');

    await expect(
      suggestExpertApproachFor(CTX, { playerId: PLAYER }, { generate }),
    ).rejects.toThrow("Lead não encontrado.");
    expect(generate).not.toHaveBeenCalled();
  });
});
