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
import {
  claimExpertLeadFor,
  completeExpertFollowupFor,
  listExpertFollowupsDueFor,
  logExpertContactFor,
  releaseExpertLeadFor,
  scheduleExpertFollowupFor,
} from "./expert-lead-actions.functions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const PLAYER_2 = "00000000-0000-4000-8000-0000000000b2";
const PLAYER_3 = "00000000-0000-4000-8000-0000000000b3";
const PLAYER_4 = "00000000-0000-4000-8000-0000000000b4";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EXPERT = "00000000-0000-4000-8000-0000000000e2";
const CTX = { userId: "u1", activeTenantId: TENANT };

const EXPERT = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: ME,
  nome: "Eu",
  tipo: "total" as const,
  affiliateIds: ["AFF1"],
};

function seedPlayer(id: string, affiliateId: string | null = "AFF1") {
  fake.admin.rows("players").push({
    id,
    tenant_id: TENANT,
    nome: `Jogador ${id.slice(-1)}`,
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
});

describe("logExpertContactFor", () => {
  it("logs a contact for a visible lead and rejects an out-of-reach lead", async () => {
    seedPlayer(PLAYER);

    const result = await logExpertContactFor(CTX, {
      playerId: PLAYER,
      resultado: "chamei",
      nota: "Disse que ia ver",
    });

    expect(result.id).toBeTruthy();
    const rows = fake.admin.rows("expert_lead_contacts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.id,
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      resultado: "chamei",
      nota: "Disse que ia ver",
    });

    seedPlayer(PLAYER_2, "OUTRO");
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });

    await expect(
      logExpertContactFor(CTX, { playerId: PLAYER_2, resultado: "chamei" }),
    ).rejects.toThrow("Lead não encontrado.");
    expect(fake.admin.rows("expert_lead_contacts")).toHaveLength(1);
  });

  it("rejects resultado outside the set and nota over 1000 chars", async () => {
    seedPlayer(PLAYER);

    await expect(
      logExpertContactFor(CTX, { playerId: PLAYER, resultado: "invalido" as never }),
    ).rejects.toThrow();
    await expect(
      logExpertContactFor(CTX, { playerId: PLAYER, resultado: "chamei", nota: "a".repeat(1001) }),
    ).rejects.toThrow();
    expect(fake.admin.rows("expert_lead_contacts")).toHaveLength(0);
  });
});

describe("scheduleExpertFollowupFor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("followup in the past (São Paulo date) is refused", async () => {
    seedPlayer(PLAYER);
    vi.setSystemTime(new Date("2026-10-24T02:00:00Z")); // dia 23 em São Paulo

    await expect(
      scheduleExpertFollowupFor(CTX, { playerId: PLAYER, dueDate: "2026-10-22" }),
    ).rejects.toThrow("Escolha hoje ou uma data futura.");
    expect(fake.admin.rows("expert_lead_followups")).toHaveLength(0);

    const result = await scheduleExpertFollowupFor(CTX, {
      playerId: PLAYER,
      dueDate: "2026-10-23",
      nota: "Ligar de novo",
    });
    expect(result.id).toBeTruthy();
    expect(fake.admin.rows("expert_lead_followups")).toHaveLength(1);
  });

  it("refuses an impossible calendar date", async () => {
    seedPlayer(PLAYER);
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));

    for (const dueDate of ["2026-02-31", "2026-13-01", "2026-04-31"]) {
      await expect(scheduleExpertFollowupFor(CTX, { playerId: PLAYER, dueDate })).rejects.toThrow(
        "Data inválida.",
      );
    }
    expect(fake.admin.rows("expert_lead_followups")).toHaveLength(0);

    await expect(
      scheduleExpertFollowupFor(CTX, { playerId: PLAYER, dueDate: "2026-02-28" }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("refuses an out-of-reach lead and writes nothing", async () => {
    seedPlayer(PLAYER, "OUTRO");
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });

    await expect(
      scheduleExpertFollowupFor(CTX, { playerId: PLAYER, dueDate: "2999-01-01" }),
    ).rejects.toThrow("Lead não encontrado.");
    expect(fake.admin.rows("expert_lead_followups")).toHaveLength(0);
  });
});

describe("listExpertFollowupsDueFor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("due list shows today and overdue, flags atrasado, hides leads no longer visible", async () => {
    vi.setSystemTime(new Date("2026-10-24T02:00:00Z")); // dia 23 em São Paulo
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });

    seedPlayer(PLAYER, "AFF1"); // ainda visível, vence hoje
    seedPlayer(PLAYER_2, "AFF1"); // ainda visível, atrasado
    seedPlayer(PLAYER_3, "AFF1"); // ainda visível, mas no futuro -> não entra
    seedPlayer(PLAYER_4, "OUTRO"); // não mais visível (affiliate mudou)

    fake.admin.rows("expert_lead_followups").push(
      {
        id: "f1",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-10-23",
        nota: "hoje",
        done_at: null,
      },
      {
        id: "f2",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER_2,
        due_date: "2026-10-20",
        nota: "atrasado",
        done_at: null,
      },
      {
        id: "f3",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER_3,
        due_date: "2026-10-30",
        nota: "futuro",
        done_at: null,
      },
      {
        id: "f4",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER_4,
        due_date: "2026-10-20",
        nota: "nao mais visivel",
        done_at: null,
      },
      {
        id: "f5",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-10-20",
        nota: "ja concluido",
        done_at: "2026-10-21T12:00:00Z",
      },
      {
        id: "f6",
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        player_id: PLAYER,
        due_date: "2026-10-20",
        nota: "de outro expert",
        done_at: null,
      },
    );

    const result = await listExpertFollowupsDueFor(CTX);

    expect(result).toEqual([
      {
        id: "f2",
        playerId: PLAYER_2,
        nome: `Jogador ${PLAYER_2.slice(-1)}`,
        dueDate: "2026-10-20",
        nota: "atrasado",
        atrasado: true,
      },
      {
        id: "f1",
        playerId: PLAYER,
        nome: `Jogador ${PLAYER.slice(-1)}`,
        dueDate: "2026-10-23",
        nota: "hoje",
        atrasado: false,
      },
    ]);
  });
});

describe("listExpertFollowupsDueFor limit", () => {
  it("reads at most 200 due followups", async () => {
    seedPlayer(PLAYER);
    const rows = fake.admin.rows("expert_lead_followups");
    for (let i = 0; i < 205; i++) {
      rows.push({
        id: `f${i}`,
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-01-01",
        nota: null,
        done_at: null,
      });
    }

    expect(await listExpertFollowupsDueFor(CTX)).toHaveLength(200);
  });
});

describe("completeExpertFollowupFor", () => {
  it("complete only affects the caller's own followup", async () => {
    const OWN_FOLLOWUP = "00000000-0000-4000-8000-0000000000c1";
    const OTHER_FOLLOWUP = "00000000-0000-4000-8000-0000000000c2";
    fake.admin.rows("expert_lead_followups").push(
      {
        id: OWN_FOLLOWUP,
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-10-20",
        done_at: null,
      },
      {
        id: OTHER_FOLLOWUP,
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        player_id: PLAYER,
        due_date: "2026-10-20",
        done_at: null,
      },
    );

    await expect(completeExpertFollowupFor(CTX, { id: OTHER_FOLLOWUP })).rejects.toThrow(
      "Retorno não encontrado.",
    );
    const other = fake.admin.rows("expert_lead_followups").find((r) => r.id === OTHER_FOLLOWUP);
    expect(other?.done_at).toBeNull();

    await expect(completeExpertFollowupFor(CTX, { id: OWN_FOLLOWUP })).resolves.toEqual({
      ok: true,
    });
    const own = fake.admin.rows("expert_lead_followups").find((r) => r.id === OWN_FOLLOWUP);
    expect(own?.done_at).toBeTruthy();
  });
});

describe("claimExpertLeadFor", () => {
  it("claim conflict maps to 'Lead já assumido por Ana até 26/10.'", async () => {
    seedPlayer(PLAYER);
    fake.admin.onRpc("claim_expert_lead", () => ({
      data: [
        {
          expert_id: OTHER_EXPERT,
          expert_nome: "Ana",
          expires_at: "2026-10-26T12:00:00Z",
          claimed: false,
        },
      ],
      error: null,
    }));

    await expect(claimExpertLeadFor(CTX, { playerId: PLAYER })).rejects.toThrow(
      "Lead já assumido por Ana até 26/10.",
    );
  });

  it("refuses an out-of-reach lead without calling the rpc", async () => {
    fake.admin.rows("players").push({
      id: PLAYER,
      tenant_id: "00000000-0000-4000-8000-0000000000a9",
      nome: "De outra casa",
      affiliate_id: "AFF1",
      created_at: "2026-10-01T00:00:00Z",
    });
    const rpc = vi.fn();
    fake.admin.onRpc("claim_expert_lead", rpc);

    await expect(claimExpertLeadFor(CTX, { playerId: PLAYER })).rejects.toThrow(
      "Lead não encontrado.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("restricted expert cannot claim", async () => {
    seedPlayer(PLAYER);
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });
    const rpc = vi.fn();
    fake.admin.onRpc("claim_expert_lead", rpc);

    await expect(claimExpertLeadFor(CTX, { playerId: PLAYER })).rejects.toThrow(
      "Só experts com acesso total podem assumir leads.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("successful claim returns claimed=true with the expert's own name and expiry", async () => {
    seedPlayer(PLAYER);
    fake.admin.onRpc("claim_expert_lead", () => ({
      data: [
        { expert_id: ME, expert_nome: "Eu", expires_at: "2026-10-27T12:00:00Z", claimed: true },
      ],
      error: null,
    }));

    const result = await claimExpertLeadFor(CTX, { playerId: PLAYER });
    expect(result).toEqual({ claimed: true, expertNome: "Eu", expiresAt: "2026-10-27T12:00:00Z" });
  });
});

describe("releaseExpertLeadFor", () => {
  it("refuses an out-of-reach lead without calling the rpc", async () => {
    seedPlayer(PLAYER, "OUTRO");
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });
    const rpc = vi.fn();
    fake.admin.onRpc("release_expert_lead", rpc);

    await expect(releaseExpertLeadFor(CTX, { playerId: PLAYER })).rejects.toThrow(
      "Lead não encontrado.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("releases the caller's own claim", async () => {
    seedPlayer(PLAYER);
    const rpc = vi.fn(() => ({ data: null, error: null }));
    fake.admin.onRpc("release_expert_lead", rpc);

    await expect(releaseExpertLeadFor(CTX, { playerId: PLAYER })).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith({
      _tenant: TENANT,
      _expert_id: ME,
      _player_id: PLAYER,
    });
  });
});
