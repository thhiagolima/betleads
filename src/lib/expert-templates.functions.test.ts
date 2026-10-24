import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb({
    unique: { expert_message_templates: [["expert_id", "nome"]] },
  });
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

const mockLoadHouseLinks = vi.fn();
vi.mock("@/lib/house-links.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/house-links.server")>(
    "@/lib/house-links.server",
  );
  return {
    ...actual,
    loadHouseLinks: (...args: unknown[]) => mockLoadHouseLinks(...args),
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  copyHouseTemplateFor,
  deleteExpertTemplateFor,
  listExpertTemplatesFor,
  renderExpertMessageFor,
  saveExpertTemplateFor,
} from "./expert-templates.functions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EXPERT = "00000000-0000-4000-8000-0000000000e2";
const T1 = "00000000-0000-4000-8000-0000000000f1";
const T2 = "00000000-0000-4000-8000-0000000000f2";
const S1 = "00000000-0000-4000-8000-0000000000c1";
const S2 = "00000000-0000-4000-8000-0000000000c2";
const L1 = "00000000-0000-4000-8000-0000000000d1";
const MISSING_ID = "00000000-0000-4000-8000-0000000000ff";
const CTX = { userId: "u1", activeTenantId: TENANT };

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
    nome: "Maria Silva",
    telefone: "11999990000",
    affiliate_id: affiliateId,
    total_depositado: 100,
    total_sacado: 20,
    ultimo_deposito: "2026-10-01T00:00:00Z",
    ftd_em: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    risco: "regular",
    vip: false,
    saldo_bonus: 0,
    last_cashback_amount: null,
    last_cashback_paid_at: null,
    total_cashback_paid: 0,
  });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  mockRequireExpertContext.mockReset();
  mockRequireExpertContext.mockResolvedValue(EXPERT);
  mockLoadHouseLinks.mockReset();
  mockLoadHouseLinks.mockResolvedValue({ siteUrl: null, quickLinks: {} });
});

describe("listExpertTemplatesFor", () => {
  it("lists own templates and the house's active sms templates as read-only", async () => {
    fake.admin.rows("expert_message_templates").push(
      {
        id: T1,
        tenant_id: TENANT,
        expert_id: ME,
        nome: "Meu modelo",
        conteudo: "Oi {primeiro_nome}",
        updated_at: "2026-10-02T00:00:00Z",
      },
      {
        id: T2,
        tenant_id: TENANT,
        expert_id: OTHER_EXPERT,
        nome: "De outro expert",
        conteudo: "Não deve aparecer",
        updated_at: "2026-10-02T00:00:00Z",
      },
    );
    fake.admin.rows("sms_templates").push(
      {
        id: S1,
        tenant_id: TENANT,
        name: "Modelo da casa",
        content: "Oi {nome}",
        is_active: true,
        updated_at: "2026-10-02T00:00:00Z",
      },
      {
        id: S2,
        tenant_id: TENANT,
        name: "Inativo",
        content: "x",
        is_active: false,
        updated_at: "2026-10-02T00:00:00Z",
      },
    );

    const result = await listExpertTemplatesFor(CTX);

    expect(result.meus).toEqual([
      { id: T1, nome: "Meu modelo", conteudo: "Oi {primeiro_nome}", origem: "meu" },
    ]);
    expect(result.casa).toEqual([
      { id: S1, nome: "Modelo da casa", conteudo: "Oi {nome}", origem: "casa" },
    ]);
  });
});

describe("saveExpertTemplateFor", () => {
  it("save refuses editing another expert's template", async () => {
    fake.admin.rows("expert_message_templates").push({
      id: T1,
      tenant_id: TENANT,
      expert_id: OTHER_EXPERT,
      nome: "De outro",
      conteudo: "x",
      updated_at: "2026-10-02T00:00:00Z",
    });

    await expect(
      saveExpertTemplateFor(CTX, { id: T1, nome: "Novo nome", conteudo: "Novo conteúdo" }),
    ).rejects.toThrow("Modelo não encontrado.");
  });

  it("refuses editing a nonexistent template", async () => {
    await expect(
      saveExpertTemplateFor(CTX, { id: MISSING_ID, nome: "Novo nome", conteudo: "x" }),
    ).rejects.toThrow("Modelo não encontrado.");
  });

  it("duplicate name maps to the pt-BR message", async () => {
    fake.admin.rows("expert_message_templates").push({
      id: T1,
      tenant_id: TENANT,
      expert_id: ME,
      nome: "Boas vindas",
      conteudo: "Oi",
      updated_at: "2026-10-02T00:00:00Z",
    });

    await expect(
      saveExpertTemplateFor(CTX, { nome: "Boas vindas", conteudo: "Outro conteúdo" }),
    ).rejects.toThrow("Você já tem um modelo com esse nome.");
  });

  it("creates a new template for the expert", async () => {
    const result = await saveExpertTemplateFor(CTX, {
      nome: "Novo modelo",
      conteudo: "Oi {primeiro_nome}",
    });

    const rows = fake.admin.rows("expert_message_templates");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.id,
      tenant_id: TENANT,
      expert_id: ME,
      nome: "Novo modelo",
      conteudo: "Oi {primeiro_nome}",
    });
  });

  it("updates an owned template in place", async () => {
    fake.admin.rows("expert_message_templates").push({
      id: T1,
      tenant_id: TENANT,
      expert_id: ME,
      nome: "Antigo",
      conteudo: "Velho",
      updated_at: "2026-10-02T00:00:00Z",
    });

    const result = await saveExpertTemplateFor(CTX, { id: T1, nome: "Atualizado", conteudo: "Novo" });

    expect(result).toEqual({ id: T1 });
    const rows = fake.admin.rows("expert_message_templates");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nome: "Atualizado", conteudo: "Novo" });
  });
});

describe("deleteExpertTemplateFor", () => {
  it("refuses deleting another expert's template", async () => {
    fake.admin.rows("expert_message_templates").push({
      id: T1,
      tenant_id: TENANT,
      expert_id: OTHER_EXPERT,
      nome: "De outro",
      conteudo: "x",
    });

    await expect(deleteExpertTemplateFor(CTX, { id: T1 })).rejects.toThrow("Modelo não encontrado.");
    expect(fake.admin.rows("expert_message_templates")).toHaveLength(1);
  });

  it("deletes an owned template", async () => {
    fake.admin.rows("expert_message_templates").push({
      id: T1,
      tenant_id: TENANT,
      expert_id: ME,
      nome: "Meu",
      conteudo: "x",
    });

    await expect(deleteExpertTemplateFor(CTX, { id: T1 })).resolves.toEqual({ ok: true });
    expect(fake.admin.rows("expert_message_templates")).toHaveLength(0);
  });
});

describe("copyHouseTemplateFor", () => {
  it("copy creates '{nome} (cópia)' capped at 60 chars", async () => {
    const longName = "A".repeat(58); // + " (cópia)" would exceed 60
    fake.admin.rows("sms_templates").push({
      id: S1,
      tenant_id: TENANT,
      name: longName,
      content: "Oi {nome}",
      is_active: true,
    });

    const result = await copyHouseTemplateFor(CTX, { smsTemplateId: S1 });

    const rows = fake.admin.rows("expert_message_templates");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect((rows[0].nome as string).length).toBeLessThanOrEqual(60);
    expect(rows[0].nome).toBe(`${longName} (cópia)`.slice(0, 60));
    expect(rows[0].conteudo).toBe("Oi {nome}");
    expect(rows[0].expert_id).toBe(ME);
  });

  it("refuses copying an inactive or missing house template", async () => {
    fake.admin.rows("sms_templates").push({
      id: S1,
      tenant_id: TENANT,
      name: "Inativo",
      content: "x",
      is_active: false,
    });

    await expect(copyHouseTemplateFor(CTX, { smsTemplateId: S1 })).rejects.toThrow(
      "Modelo não encontrado.",
    );
    await expect(copyHouseTemplateFor(CTX, { smsTemplateId: MISSING_ID })).rejects.toThrow(
      "Modelo não encontrado.",
    );
  });
});

describe("renderExpertMessageFor", () => {
  it("render fills {nome}, {primeiro_nome}, {dias_sem_depositar} and {link}", async () => {
    seedPlayer();
    fake.admin.rows("expert_links").push({
      id: L1,
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      sent_url: "https://crm.short/s1",
    });

    const result = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo: "Oi {primeiro_nome} ({nome}), faz {dias_sem_depositar} dias. Link: {link}",
      link: "https://crm.short/s1",
    });

    expect(result.faltaLink).toBe(false);
    expect(result.texto).toContain("Oi Maria (Maria Silva)");
    expect(result.texto).toContain("dias. Link: https://crm.short/s1");
    expect(result.texto).not.toContain("{link}");
  });

  it("render with {link} and no link returns faltaLink=true", async () => {
    seedPlayer();

    const result = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo: "Confere: {link}",
    });

    expect(result.faltaLink).toBe(true);
    expect(result.texto).toBe("Confere: {link}");
  });

  it("render refuses a link that is not one of the expert's links for this lead", async () => {
    seedPlayer();
    fake.admin.rows("expert_links").push({
      id: L1,
      tenant_id: TENANT,
      expert_id: ME,
      player_id: PLAYER,
      sent_url: "https://crm.short/other",
    });

    await expect(
      renderExpertMessageFor(CTX, {
        playerId: PLAYER,
        conteudo: "Confere: {link}",
        link: "https://alguma.coisa/colada",
      }),
    ).rejects.toThrow("Gere o link da oferta antes de usar {link}.");
  });

  it("render fills {expert}/{nome_expert} with the expert's name", async () => {
    seedPlayer();

    const result = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo: "Aqui é {expert} ({nome_expert})",
    });

    expect(result.texto).toBe("Aqui é Eu (Eu)");
    expect(result.texto).not.toContain("Equipe BETLEADS");
    expect(result.variaveisNaoSuportadas).toEqual([]);
  });

  it("render leaves unsupported variables literal and lists them", async () => {
    seedPlayer();

    const result = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo:
        "Oi {nome}, saldo {saldo} / {saldo_atual}, e-mail {email}, status {status_lead}, " +
        "login {ultimo_login} ({dias_sem_login}), jogo {ultimo_jogo} ({dias_sem_jogar}), " +
        "push {id_push} {platform_user_id} {saldo} {inexistente}",
    });

    expect(result.texto).toContain("Oi Maria Silva");
    expect(result.texto).not.toContain("R$ 0,00");
    expect(result.texto).not.toContain("ativo");
    expect(result.texto).not.toContain("há algum tempo");
    expect(result.texto).toContain("{saldo}");
    expect(result.texto).toContain("{email}");
    expect(result.variaveisNaoSuportadas).toEqual([
      "{saldo}",
      "{saldo_atual}",
      "{email}",
      "{status_lead}",
      "{ultimo_login}",
      "{dias_sem_login}",
      "{ultimo_jogo}",
      "{dias_sem_jogar}",
      "{id_push}",
      "{platform_user_id}",
      "{inexistente}",
    ]);
  });

  it("render treats house links as unsupported when the house has no site URL", async () => {
    seedPlayer();

    const semSite = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo: "Entre: {link_login}",
    });
    expect(semSite.texto).toBe("Entre: {link_login}");
    expect(semSite.variaveisNaoSuportadas).toEqual(["{link_login}"]);

    mockLoadHouseLinks.mockResolvedValue({
      siteUrl: "https://casa.example",
      quickLinks: { login: "https://casa.example/login" },
    });
    const comSite = await renderExpertMessageFor(CTX, {
      playerId: PLAYER,
      conteudo: "Entre: {link_login}",
    });
    expect(comSite.texto).toBe("Entre: https://casa.example/login");
    expect(comSite.variaveisNaoSuportadas).toEqual([]);
  });

  it("render refuses a lead outside reach", async () => {
    seedPlayer("OUTRO");
    mockRequireExpertContext.mockResolvedValue({ ...EXPERT, tipo: "restrito" });

    await expect(
      renderExpertMessageFor(CTX, { playerId: PLAYER, conteudo: "Oi {nome}" }),
    ).rejects.toThrow("Lead não encontrado.");
  });
});
