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
  listExpertClickedNoDepositFor,
  listExpertFollowupsDueFor,
  listExpertLeadsEnteredRiskFor,
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

function seedRiskPlayer(
  id: string,
  opts: {
    affiliateId?: string | null;
    totalDepositado?: number;
    ultimoDeposito?: string | null;
    ftdEm?: string | null;
  } = {},
) {
  fake.admin.rows("players").push({
    id,
    tenant_id: TENANT,
    nome: `Jogador ${id.slice(-1)}`,
    affiliate_id: opts.affiliateId === undefined ? "AFF1" : opts.affiliateId,
    total_depositado: opts.totalDepositado ?? 0,
    ultimo_deposito: opts.ultimoDeposito ?? null,
    ftd_em: opts.ftdEm ?? null,
    created_at: "2026-10-01T00:00:00Z",
  });
}

describe("listExpertLeadsEnteredRiskFor", () => {
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("entered-risk lists only leads that became dormant in the last 7 days, max 20, by total depositado", async () => {
    // Dentro da janela [now-14d, now-7d] (sleeping_after_days=7, default).
    seedRiskPlayer(PLAYER, { ultimoDeposito: daysAgo(8), totalDepositado: 100 });
    seedRiskPlayer(PLAYER_2, { ultimoDeposito: daysAgo(10), totalDepositado: 500 });
    // Fora da janela: ainda ativo/esfriando (não virou "Dormindo").
    seedRiskPlayer(PLAYER_3, { ultimoDeposito: daysAgo(3), totalDepositado: 999 });
    // Fora da janela: já estava dormindo há mais de 7 dias extras (não é "entrou" agora).
    seedRiskPlayer(PLAYER_4, { ultimoDeposito: daysAgo(20), totalDepositado: 999 });
    // Nunca houve ultimo_deposito seguinte: usa ftd_em, também dentro da janela.
    const PLAYER_5 = "00000000-0000-4000-8000-0000000000b5";
    seedRiskPlayer(PLAYER_5, { ftdEm: daysAgo(9), totalDepositado: 50 });

    const result = await listExpertLeadsEnteredRiskFor(CTX);

    expect(result).toEqual([
      { playerId: PLAYER_2, nome: "Jogador 2", diasSemDepositar: 10, totalDepositado: 500 },
      { playerId: PLAYER, nome: "Jogador 1", diasSemDepositar: 8, totalDepositado: 100 },
      { playerId: PLAYER_5, nome: "Jogador 5", diasSemDepositar: 9, totalDepositado: 50 },
    ]);
  });

  it("caps at 20, keeping the highest total depositado", async () => {
    for (let i = 0; i < 25; i++) {
      seedRiskPlayer(`00000000-0000-4000-8000-00000000${String(1000 + i).padStart(4, "0")}`, {
        ultimoDeposito: daysAgo(8),
        totalDepositado: i,
      });
    }

    const result = await listExpertLeadsEnteredRiskFor(CTX);
    expect(result).toHaveLength(20);
    expect(result[0].totalDepositado).toBe(24);
    expect(result.at(-1)?.totalDepositado).toBe(5);
  });

  it("entered-risk for restricted expert only includes own affiliate leads", async () => {
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });
    seedRiskPlayer(PLAYER, {
      affiliateId: "AFF1",
      ultimoDeposito: daysAgo(8),
      totalDepositado: 100,
    });
    seedRiskPlayer(PLAYER_2, {
      affiliateId: "OUTRO",
      ultimoDeposito: daysAgo(8),
      totalDepositado: 200,
    });
    seedRiskPlayer(PLAYER_3, {
      affiliateId: null,
      ultimoDeposito: daysAgo(8),
      totalDepositado: 300,
    });

    const result = await listExpertLeadsEnteredRiskFor(CTX);

    expect(result.map((r) => r.playerId)).toEqual([PLAYER]);
  });

  it("restricted expert with no affiliate ids returns empty without querying", async () => {
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito", affiliateIds: [] });
    seedRiskPlayer(PLAYER, { ultimoDeposito: daysAgo(8), totalDepositado: 100 });

    expect(await listExpertLeadsEnteredRiskFor(CTX)).toEqual([]);
  });
});

function seedClickScenario(opts: {
  dispatchId: string;
  playerId: string;
  sourceType?: string;
  sourceId?: string;
  isHuman?: boolean;
  occurredAt: string;
  sentAt?: string;
  sendStatus?: string;
  oferta?: string;
}) {
  fake.admin.rows("link_dispatches").push({
    id: opts.dispatchId,
    tenant_id: TENANT,
    recipient_player_id: opts.playerId,
    source_type: opts.sourceType ?? "expert",
    source_id: opts.sourceId ?? ME,
    send_status: opts.sendStatus ?? "sent",
    sent_at: opts.sentAt ?? opts.occurredAt,
    created_at: "2026-10-01T00:00:00Z",
  });
  fake.admin.rows("click_events").push({
    id: `click-${opts.dispatchId}`,
    tenant_id: TENANT,
    link_dispatch_id: opts.dispatchId,
    is_human: opts.isHuman ?? true,
    occurred_at: opts.occurredAt,
  });
  if (opts.oferta) {
    fake.admin.rows("expert_links").push({
      id: `link-${opts.dispatchId}`,
      tenant_id: TENANT,
      expert_id: ME,
      link_dispatch_id: opts.dispatchId,
      oferta: opts.oferta,
    });
  }
}

describe("listExpertClickedNoDepositFor", () => {
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clicked-no-deposit excludes leads that deposited after the click and bot clicks", async () => {
    seedPlayer(PLAYER);
    seedPlayer(PLAYER_2);
    seedPlayer(PLAYER_3);

    seedClickScenario({
      dispatchId: "d1",
      playerId: PLAYER,
      occurredAt: hoursAgo(1),
      oferta: "Bônus 100%",
    });
    seedClickScenario({ dispatchId: "d2", playerId: PLAYER_2, occurredAt: hoursAgo(2) });
    fake.admin.rows("deposits").push({
      id: "dep1",
      tenant_id: TENANT,
      player_id: PLAYER_2,
      status: "aprovado",
      created_at: hoursAgo(1), // depois do clique (há 2h) -> exclui
    });
    // Clique de bot: nunca entra.
    seedClickScenario({
      dispatchId: "d3",
      playerId: PLAYER_3,
      isHuman: false,
      occurredAt: hoursAgo(1),
    });

    const result = await listExpertClickedNoDepositFor(CTX);

    expect(result).toEqual([
      { playerId: PLAYER, nome: "Jogador 1", clicadoEm: hoursAgo(1), oferta: "Bônus 100%" },
    ]);
  });

  it("clicked-no-deposit only uses the caller's dispatches", async () => {
    seedPlayer(PLAYER);
    seedPlayer(PLAYER_2);

    seedClickScenario({ dispatchId: "d1", playerId: PLAYER, occurredAt: hoursAgo(1) });
    // Dispatch de outro expert: mesmo source_type, source_id diferente -> fora.
    seedClickScenario({
      dispatchId: "d2",
      playerId: PLAYER_2,
      sourceId: OTHER_EXPERT,
      occurredAt: hoursAgo(1),
    });
    // Dispatch de outra origem (campanha), nunca do expert -> fora.
    seedClickScenario({
      dispatchId: "d3",
      playerId: PLAYER_2,
      sourceType: "campaign",
      sourceId: "any",
      occurredAt: hoursAgo(1),
    });

    const result = await listExpertClickedNoDepositFor(CTX);

    expect(result.map((r) => r.playerId)).toEqual([PLAYER]);
  });

  it("ignores clicks older than 24h and re-checks restrito visibility", async () => {
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });
    seedPlayer(PLAYER, "AFF1");
    seedPlayer(PLAYER_2, "OUTRO"); // não é mais afiliado do expert

    seedClickScenario({ dispatchId: "d1", playerId: PLAYER, occurredAt: hoursAgo(1) });
    seedClickScenario({ dispatchId: "d2", playerId: PLAYER_2, occurredAt: hoursAgo(1) });
    seedClickScenario({ dispatchId: "d3", playerId: PLAYER, occurredAt: hoursAgo(25) }); // fora da janela

    const result = await listExpertClickedNoDepositFor(CTX);
    expect(result.map((r) => r.playerId)).toEqual([PLAYER]);
  });

  it("a house with more than 500 non-expert clicks in 24h still returns the expert's leads", async () => {
    seedPlayer(PLAYER);
    seedPlayer(PLAYER_2);
    // The expert's clicks are the oldest of the day.
    seedClickScenario({ dispatchId: "mine-1", playerId: PLAYER, occurredAt: hoursAgo(23) });
    seedClickScenario({
      dispatchId: "mine-2",
      playerId: PLAYER_2,
      occurredAt: hoursAgo(22),
      sentAt: hoursAgo(24 * 20), // sent 20 days ago, clicked today
    });
    for (let i = 0; i < 600; i++) {
      seedClickScenario({
        dispatchId: `camp-${i}`,
        playerId: PLAYER_3,
        sourceType: "campaign",
        sourceId: "camp",
        occurredAt: hoursAgo(1 + (i % 20) / 100),
      });
    }
    // An old approved deposit (before the click) does not exclude the lead.
    fake.admin.rows("deposits").push({
      id: "dep-old",
      tenant_id: TENANT,
      player_id: PLAYER,
      status: "aprovado",
      created_at: hoursAgo(48),
    });

    const result = await listExpertClickedNoDepositFor(CTX);

    expect(result.map((r) => r.playerId)).toEqual([PLAYER_2, PLAYER]);
  });

  it("ignores links sent more than 30 days ago and failed sends", async () => {
    seedPlayer(PLAYER);
    seedPlayer(PLAYER_2);
    seedClickScenario({
      dispatchId: "old",
      playerId: PLAYER,
      occurredAt: hoursAgo(1),
      sentAt: hoursAgo(24 * 31),
    });
    seedClickScenario({
      dispatchId: "failed",
      playerId: PLAYER_2,
      occurredAt: hoursAgo(1),
      sendStatus: "failed",
    });

    expect(await listExpertClickedNoDepositFor(CTX)).toEqual([]);
  });

  it("keeps .in() lists to at most 100 ids and caps the result at 20, newest first", async () => {
    const players: string[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`;
      players.push(id);
      seedPlayer(id);
      seedClickScenario({ dispatchId: `d-${i}`, playerId: id, occurredAt: hoursAgo(20 - i / 10) });
    }
    const inSizes: number[] = [];
    const client = fake.admin.client as unknown as { from: (t: string) => unknown };
    const originalFrom = client.from.bind(client);
    const spy = vi.spyOn(client, "from").mockImplementation((table: string) => {
      const builder = originalFrom(table) as { in: (c: string, v: unknown[]) => unknown };
      const originalIn = builder.in.bind(builder);
      builder.in = (col: string, values: unknown[]) => {
        inSizes.push(values.length);
        return originalIn(col, values);
      };
      return builder;
    });

    try {
      const result = await listExpertClickedNoDepositFor(CTX);
      expect(result).toHaveLength(20);
      expect(result[0].playerId).toBe(players[149]);
      expect(result.map((r) => r.clicadoEm)).toEqual(
        [...result.map((r) => r.clicadoEm)].sort().reverse(),
      );
    } finally {
      spy.mockRestore();
    }
    expect(inSizes.length).toBeGreaterThan(0);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(100);
  });
});
