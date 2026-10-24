import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  selects: [] as Array<{ table: string; columns: string }>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      from(table: string) {
        const builder = fake.admin.client.from(table);
        const select = builder.select;
        builder.select = (columns: string, options?: unknown) => {
          fake.selects.push({ table, columns });
          return select(columns, options);
        };
        return builder;
      },
    },
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import type { ExpertContext } from "./expert-access.server";
import { loadVisibleLead } from "./expert-lead-access.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";

const RESTRICTED: ExpertContext = {
  tenantId: TENANT,
  tenantNome: "Casa",
  expertId: "e1",
  nome: "Fulano",
  tipo: "restrito",
  affiliateIds: ["AFF1"],
};
const TOTAL: ExpertContext = { ...RESTRICTED, tipo: "total", affiliateIds: [] };

function seedPlayer(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("players").push({
    id: PLAYER,
    tenant_id: TENANT,
    nome: "Maria",
    telefone: "11999990000",
    cpf: "12345678900",
    email: "maria@x.com",
    saldo_carteira: 50,
    affiliate_id: "AFF1",
    total_depositado: 100,
    total_sacado: 10,
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

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  fake.selects.length = 0;
});

describe("loadVisibleLead", () => {
  it("restricted expert loads a lead of own affiliate id", async () => {
    seedPlayer({ affiliate_id: "  AFF1 " });
    const lead = await loadVisibleLead(RESTRICTED, PLAYER);
    expect(lead.id).toBe(PLAYER);
    expect(lead.nome).toBe("Maria");
  });

  it("restricted expert gets 'Lead não encontrado.' for another affiliate", async () => {
    seedPlayer({ affiliate_id: "AFF2" });
    await expect(loadVisibleLead(RESTRICTED, PLAYER)).rejects.toMatchObject({
      name: "ExpertAccessError",
      message: "Lead não encontrado.",
    });
    seedPlayer({ id: "p-none", affiliate_id: null });
    await expect(loadVisibleLead(RESTRICTED, "p-none")).rejects.toThrow("Lead não encontrado.");
  });

  it("total expert loads any lead of the house", async () => {
    seedPlayer({ affiliate_id: null });
    const lead = await loadVisibleLead(TOTAL, PLAYER);
    expect(lead.id).toBe(PLAYER);
  });

  it("lead of another house is not found even for total expert", async () => {
    seedPlayer({ tenant_id: OTHER_TENANT });
    await expect(loadVisibleLead(TOTAL, PLAYER)).rejects.toThrow("Lead não encontrado.");
    await expect(loadVisibleLead(TOTAL, "missing")).rejects.toThrow("Lead não encontrado.");
  });

  it("selects no cpf, email or wallet balances", async () => {
    seedPlayer();
    const lead = await loadVisibleLead(TOTAL, PLAYER);
    const select = fake.selects.find((s) => s.table === "players");
    expect(select?.columns).toBe(
      "id,tenant_id,nome,telefone,affiliate_id,total_depositado,total_sacado,ultimo_deposito,ftd_em,created_at,risco,vip,saldo_bonus,last_cashback_amount,last_cashback_paid_at,total_cashback_paid",
    );
    expect(select?.columns).not.toMatch(/cpf|email|saldo_carteira/);
    for (const key of ["cpf", "email", "saldo_carteira"]) expect(lead).not.toHaveProperty(key);
  });
});
