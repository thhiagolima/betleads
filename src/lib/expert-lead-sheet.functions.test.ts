import { beforeEach, describe, expect, it, vi } from "vitest";

type Filter = { table: string; method: string; column: string; value: unknown };

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  filters: [] as Filter[],
  tables: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      from(table: string) {
        fake.tables.push(table);
        const builder = fake.admin.client.from(table);
        for (const method of ["eq", "in", "is"] as const) {
          const original = builder[method];
          builder[method] = (column: string, value: unknown) => {
            fake.filters.push({ table, method, column, value });
            return original(column, value);
          };
        }
        return builder;
      },
    },
  };
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
import { playerSituation } from "./player-situation";
import { getExpertLeadSheetFor } from "./expert-lead-sheet.functions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";

const CTX = { userId: "u1", activeTenantId: TENANT };
const EXPERT = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: ME,
  nome: "Eu",
  tipo: "total" as const,
  affiliateIds: ["AFF1"],
};

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function seedPlayer(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("players").push({
    id: PLAYER,
    tenant_id: TENANT,
    nome: "Maria",
    telefone: "11999990000",
    affiliate_id: " AFF1 ",
    total_depositado: 0,
    total_sacado: 0,
    ultimo_deposito: null,
    ftd_em: null,
    created_at: "2026-10-01T00:00:00Z",
    risco: "baixo",
    vip: false,
    saldo_bonus: 0,
    last_cashback_amount: null,
    last_cashback_paid_at: null,
    total_cashback_paid: 0,
    ...overrides,
  });
}

function seedExpert(id: string, nome: string, overrides: Record<string, unknown> = {}) {
  fake.admin
    .rows("experts")
    .push({ id, tenant_id: TENANT, nome, tipo: "total", ativo: true, ...overrides });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  fake.filters.length = 0;
  fake.tables.length = 0;
  mockRequireExpertContext.mockReset();
  mockRequireExpertContext.mockResolvedValue(EXPERT);
});

describe("getExpertLeadSheetFor", () => {
  it("lead without deposits: depositos 0, ticketMedio null, ultimoDeposito null, situacao from playerSituation", async () => {
    seedPlayer();
    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });

    expect(mockRequireExpertContext).toHaveBeenCalledWith("u1", TENANT);
    expect(sheet.lead).toMatchObject({
      id: PLAYER,
      nome: "Maria",
      depositos: 0,
      ticketMedio: null,
      ultimoDeposito: null,
      diasSemDepositar: null,
      nivel: "novice",
      situacao: playerSituation({ total_depositado: 0, ftd_em: null, ultimo_deposito: null }),
      situacaoLabel: "Sem depósito",
      origemAfiliadoDoExpert: true,
    });
    expect(sheet.timeline).toEqual([]);
    expect(sheet.beneficios).toEqual([]);
    expect(sheet.claim).toBeNull();
    expect(sheet.retornosPendentes).toEqual([]);
    expect(sheet.podeAssumir).toBe(true);
  });

  it("ticketMedio = totalDepositado / depositos", async () => {
    seedPlayer({
      total_depositado: 300,
      ftd_em: iso(-10),
      ultimo_deposito: iso(-3),
      saldo_bonus: 15,
    });
    const deposits = fake.admin.rows("deposits");
    deposits.push(
      {
        id: "d1",
        tenant_id: TENANT,
        player_id: PLAYER,
        valor: 100,
        status: "aprovado",
        created_at: iso(-10),
      },
      {
        id: "d2",
        tenant_id: TENANT,
        player_id: PLAYER,
        valor: 120,
        status: "aprovado",
        created_at: iso(-3),
      },
      {
        id: "d3",
        tenant_id: TENANT,
        player_id: PLAYER,
        valor: 999,
        status: "pendente",
        created_at: iso(-1),
      },
    );
    fake.admin.rows("cashback_payments").push({
      id: "c1",
      tenant_id: TENANT,
      player_id: PLAYER,
      cashback_amount: 7,
      paid_at: iso(-2),
      created_at: iso(-2),
    });

    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.lead.depositos).toBe(2);
    expect(sheet.lead.ticketMedio).toBe(150);
    expect(sheet.lead.ultimoDeposito).toEqual({ valor: 120, at: deposits[1].created_at });
    expect(sheet.lead.diasSemDepositar).toBe(3);
    expect(sheet.lead.situacao).toBe("cooling");
    expect(sheet.lead.situacaoLabel).toBe("Esfriando");
    expect(sheet.beneficios).toEqual([
      { tipo: "cashback", valor: 7, at: fake.admin.rows("cashback_payments")[0].paid_at },
      { tipo: "bonus", valor: 15, at: null },
    ]);
    expect(sheet.timeline.map((i) => i.id)).toEqual(["cashback:c1", "deposito:d2", "deposito:d1"]);
  });

  it("depositos matches the player detail: imported count wins over missing deposit rows", async () => {
    seedPlayer({ total_depositado: 500, ftd_em: iso(-30), ultimo_deposito: iso(-1) });
    fake.admin
      .rows("player_attributions")
      .push(
        {
          id: "a-old",
          tenant_id: TENANT,
          player_id: PLAYER,
          captured_at: iso(-60),
          raw_payload: { normalized: { depositos: 1 } },
        },
        {
          id: "a-new",
          tenant_id: TENANT,
          player_id: PLAYER,
          captured_at: iso(-30),
          raw_payload: { normalized: { depositos: 5 } },
        },
        {
          id: "a-x",
          tenant_id: "other",
          player_id: PLAYER,
          captured_at: iso(-1),
          raw_payload: { normalized: { depositos: 99 } },
        },
      );

    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.lead.depositos).toBe(5);
    expect(sheet.lead.ticketMedio).toBe(100);
    expect(sheet.lead.ultimoDeposito).toBeNull();
  });

  it("deposits with null status count as approved, like the player detail", async () => {
    seedPlayer({ total_depositado: 90, ftd_em: iso(-5) });
    fake.admin
      .rows("deposits")
      .push(
        {
          id: "d1",
          tenant_id: TENANT,
          player_id: PLAYER,
          valor: 30,
          status: "aprovado",
          created_at: iso(-5),
        },
        {
          id: "d2",
          tenant_id: TENANT,
          player_id: PLAYER,
          valor: 30,
          status: null,
          created_at: iso(-4),
        },
        {
          id: "d3",
          tenant_id: TENANT,
          player_id: PLAYER,
          valor: 30,
          status: "recusado",
          created_at: iso(-3),
        },
      );
    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.lead.depositos).toBe(2);
    expect(sheet.lead.ticketMedio).toBe(45);
  });

  it("an old pending return is listed even behind 50 newer followups", async () => {
    seedPlayer();
    const followups = fake.admin.rows("expert_lead_followups");
    followups.push({
      id: "old",
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      due_date: "2026-09-01",
      nota: "antigo",
      done_at: null,
      created_at: iso(-90),
    });
    for (let i = 0; i < 55; i++) {
      followups.push({
        id: `done-${i}`,
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-10-01",
        nota: null,
        done_at: iso(-1),
        created_at: iso(-10 + i / 100),
      });
    }
    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.retornosPendentes).toEqual([{ id: "old", dueDate: "2026-09-01", nota: "antigo" }]);
    expect(fake.filters).toContainEqual({
      table: "expert_lead_followups",
      method: "is",
      column: "done_at",
      value: null,
    });
  });

  it("only the caller's contacts and followups are read", async () => {
    seedPlayer();
    fake.admin.rows("expert_lead_contacts").push(
      {
        id: "k1",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        resultado: "chamei",
        nota: "minha",
        created_at: iso(-1),
      },
      {
        id: "k2",
        tenant_id: TENANT,
        expert_id: OTHER,
        player_id: PLAYER,
        resultado: "respondeu",
        nota: "dele",
        created_at: iso(-1),
      },
    );
    fake.admin.rows("expert_lead_followups").push(
      {
        id: "f1",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-11-02",
        nota: "eu",
        done_at: null,
        created_at: iso(-2),
      },
      {
        id: "f2",
        tenant_id: TENANT,
        expert_id: OTHER,
        player_id: PLAYER,
        due_date: "2026-11-01",
        nota: "outro",
        done_at: null,
        created_at: iso(-2),
      },
      {
        id: "f3",
        tenant_id: TENANT,
        expert_id: ME,
        player_id: PLAYER,
        due_date: "2026-10-20",
        nota: "feito",
        done_at: iso(-1),
        created_at: iso(-5),
      },
    );

    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });

    for (const table of ["expert_lead_contacts", "expert_lead_followups"]) {
      expect(fake.filters).toContainEqual({ table, method: "eq", column: "expert_id", value: ME });
    }
    expect(sheet.timeline.map((i) => i.id).sort()).toEqual([
      "contato:k1",
      "retorno:f1",
      "retorno:f3",
    ]);
    expect(sheet.retornosPendentes).toEqual([{ id: "f1", dueDate: "2026-11-02", nota: "eu" }]);
    expect(JSON.stringify(sheet)).not.toMatch(/dele|outro/);
  });

  it("claim of another expert shows name and minha=false; expired claim is null", async () => {
    seedPlayer();
    seedExpert(OTHER, "Outro Expert");
    const claims = fake.admin.rows("expert_lead_claims");
    claims.push({ tenant_id: TENANT, player_id: PLAYER, expert_id: OTHER, expires_at: iso(2) });

    let sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.claim).toEqual({
      expertNome: "Outro Expert",
      expiresAt: claims[0].expires_at,
      minha: false,
    });

    claims[0].expires_at = iso(-1);
    sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.claim).toBeNull();

    // A holder that is no longer an active tipo='total' expert does not block.
    claims[0].expires_at = iso(2);
    const holder = fake.admin.rows("experts")[0];
    holder.ativo = false;
    expect((await getExpertLeadSheetFor(CTX, { playerId: PLAYER })).claim).toBeNull();
    holder.ativo = true;
    holder.tipo = "restrito";
    expect((await getExpertLeadSheetFor(CTX, { playerId: PLAYER })).claim).toBeNull();

    seedExpert(ME, "Eu");
    claims[0].expert_id = ME;
    sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.claim).toMatchObject({ expertNome: "Eu", minha: true });
  });

  it("every query is scoped by tenant_id and player_id", async () => {
    seedPlayer();
    seedExpert(OTHER, "Outro Expert");
    fake.admin
      .rows("expert_lead_claims")
      .push({ tenant_id: TENANT, player_id: PLAYER, expert_id: OTHER, expires_at: iso(2) });
    fake.admin.rows("link_dispatches").push({
      id: "ld1",
      tenant_id: TENANT,
      first_party_first_clicked_at: iso(-1),
      first_party_click_count: 1,
    });
    fake.admin.rows("expert_links").push({
      id: "l1",
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      link_dispatch_id: "ld1",
      oferta: "Giros",
      created_at: iso(-2),
    });
    fake.admin.rows("sms_send_logs").push(
      {
        id: "s1",
        tenant_id: TENANT,
        player_id: PLAYER,
        status: "sent",
        content: "oi",
        created_at: iso(-4),
      },
      {
        id: "s2",
        tenant_id: TENANT,
        player_id: PLAYER,
        status: "failed",
        content: "x",
        created_at: iso(-4),
      },
    );
    fake.admin.rows("email_send_logs").push({
      id: "m1",
      tenant_id: TENANT,
      player_id: PLAYER,
      status: "sent",
      subject: "Olá",
      created_at: iso(-5),
    });

    const sheet = await getExpertLeadSheetFor(CTX, { playerId: PLAYER });
    expect(sheet.timeline.map((i) => i.id)).toEqual([
      "clique:l1",
      "link_expert:l1",
      "sms_casa:s1",
      "email_casa:m1",
    ]);

    const has = (table: string, column: string, value: unknown) =>
      fake.filters.some(
        (f) => f.table === table && f.column === column && f.method === "eq" && f.value === value,
      );

    const leadTables = [
      "players",
      "deposits",
      "withdrawals",
      "cashback_payments",
      "sms_send_logs",
      "email_send_logs",
      "expert_links",
      "expert_lead_contacts",
      "expert_lead_followups",
      "expert_lead_claims",
      "player_attributions",
    ];
    for (const table of leadTables) {
      expect(fake.tables).toContain(table);
      expect(has(table, "tenant_id", TENANT)).toBe(true);
      expect(has(table, table === "players" ? "id" : "player_id", PLAYER)).toBe(true);
    }
    // Lookups that are not per-lead (settings, claim holder, link dispatches)
    // are still pinned to the house.
    for (const table of new Set(fake.tables)) {
      expect(has(table, "tenant_id", TENANT)).toBe(true);
    }
    // link_dispatches is read only for the ids of this lead's expert_links.
    expect(fake.filters).toContainEqual({
      table: "link_dispatches",
      method: "in",
      column: "id",
      value: ["ld1"],
    });
  });
});
