// Área do Expert §8 — núcleo das campanhas do expert (expert-campaigns.server):
// escopo do público, públicos próprios x da casa, prévia só com contagens,
// lista externa/ids injetados recusados, links só da casa, pré-checagem do
// teto, aprovação (pendente → aprovar/recusar, editar volta a pendente) e
// voz enfileirada só com jogadores do escopo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb({
    unique: { sms_audiences: [["expert_id", "name"]] },
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

vi.mock("@/lib/tenant-access.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant-access.server")>(
    "@/lib/tenant-access.server",
  );
  return { ...actual, assertTenantNotDemoForSend: vi.fn(async () => undefined) };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { expertCapMonth } from "@/lib/billing/expert-cap-alerts.server";
import {
  approveExpertCampaignCore,
  createExpertSelectionAudienceFor,
  deleteExpertAudienceFor,
  EXPERT_AUDIENCE_NOT_FOUND,
  EXPERT_CAMPAIGN_NOT_PENDING,
  EXPERT_CAP_BLOCKED,
  EXPERT_INACTIVE_CANNOT_APPROVE,
  EXPERT_NO_RECIPIENTS,
  getExpertCampaignUsageFor,
  listExpertAudiencesFor,
  listExpertCampaignsForAdminCore,
  listExpertCampaignsFor,
  pauseExpertCampaignCore,
  rejectExpertCampaignCore,
  resolveExpertCampaignAudienceFor,
  resumeExpertCampaignCore,
  saveExpertAudienceFor,
  saveExpertEmailCampaignFor,
  saveExpertSmsCampaignFor,
  saveExpertVoiceCampaignFor,
} from "./expert-campaigns.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EXPERT = "00000000-0000-4000-8000-0000000000e2";
const ADMIN = "00000000-0000-4000-8000-0000000000ad";
const SCRIPT = "00000000-0000-4000-8000-0000000000c5";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CTX = { userId: "u1", activeTenantId: TENANT };

type Row = Record<string, unknown>;

function expertCtx(overrides: Row = {}) {
  return {
    tenantId: TENANT,
    tenantNome: "Casa",
    expertId: ME,
    nome: "Eu",
    tipo: "restrito",
    affiliateIds: ["AFF1"],
    envioModo: "livre",
    tetoMensal: null,
    ...overrides,
  };
}

function setExpert(overrides: Row = {}) {
  const ctx = expertCtx(overrides);
  mockRequireExpertContext.mockResolvedValue(ctx);
  const experts = fake.admin.rows("experts");
  const row = experts.find((e) => e.id === ME);
  const dbRow = {
    id: ME,
    tenant_id: TENANT,
    nome: ctx.nome,
    tipo: ctx.tipo,
    ativo: overrides.ativo ?? true,
    envio_modo: ctx.envioModo,
    teto_mensal: ctx.tetoMensal,
  };
  if (row) Object.assign(row, dbRow);
  else experts.push(dbRow);
  const links = fake.admin.rows("expert_affiliates");
  links.splice(0, links.length);
  for (const a of ctx.affiliateIds as string[])
    links.push({ tenant_id: TENANT, expert_id: ME, affiliate_id: a });
}

function seedPlayers() {
  const players = fake.admin.rows("players");
  players.push(
    { id: pid(1), tenant_id: TENANT, telefone: "+5511999990001", email: "a@x.com", affiliate_id: "AFF1", updated_at: "1" },
    { id: pid(2), tenant_id: TENANT, telefone: "+5511999990002", email: "b@x.com", affiliate_id: " AFF1 ", updated_at: "1" },
    { id: pid(3), tenant_id: TENANT, telefone: "+5511999990003", email: "c@x.com", affiliate_id: "AFF2", updated_at: "1" },
    { id: pid(4), tenant_id: TENANT, telefone: "+5511999990004", email: null, affiliate_id: null, updated_at: "1" },
    { id: pid(9), tenant_id: OTHER_TENANT, telefone: "+5511999990009", email: "z@x.com", affiliate_id: "AFF1", updated_at: "1" },
  );
}

const PRICES: Record<string, number> = { sms: 0.08, email: 0.002, voice_30s: 0.09 };
const rpcCalls: Array<{ fn: string; args: Row }> = [];

function installRpcs() {
  fake.admin.onRpc("resolve_sms_audience_v2", (args) => {
    rpcCalls.push({ fn: "resolve_sms_audience_v2", args });
    const criteria = args._criteria as Row;
    const scoped = "affiliateIds" in criteria;
    const allowed = new Set(((criteria.affiliateIds as string[]) ?? []).map((a) => a.trim()));
    const matched = fake.admin
      .rows("players")
      .filter((p) => p.tenant_id === args._tenant)
      .filter((p) => !scoped || allowed.has(String(p.affiliate_id ?? "").trim()));
    const phones = matched.map((p) => String(p.telefone ?? "").replace(/\D/g, "")).filter((p) => p.length >= 10);
    const emailPlayerIds = matched.filter((p) => p.email).map((p) => p.id);
    return {
      data: {
        phones: phones.sort(),
        total: matched.length,
        recipientTotal: phones.length,
        emailPlayerIds,
        emailRecipientTotal: emailPlayerIds.length,
        affiliateScoped: scoped,
        facets: {},
        settings: {},
      },
      error: null,
    };
  });
  fake.admin.onRpc("resolve_campaign_channel_eligibility", (args) => {
    const candidates = args.p_candidates as string[];
    return {
      data: {
        candidateCount: candidates.length,
        eligibleIdentifiers: candidates,
        eligiblePlayerIds: args.p_channel === "email" ? candidates : [],
        invalidCount: 0,
        optOutCount: 0,
      },
      error: null,
    };
  });
  fake.admin.onRpc("billing_effective_price", (args) => ({
    data: { unit_price: PRICES[String(args._item)] },
    error: null,
  }));
}

beforeEach(() => {
  fake.admin.reset();
  rpcCalls.length = 0;
  mockRequireExpertContext.mockReset();
  installRpcs();
  seedPlayers();
  fake.admin.rows("tenants").push({ id: TENANT, site_url: "https://casa.bet" });
  setExpert();
});

const rulesCriteria = { level: null, timing: "any" };

describe("público do expert: escopo", () => {
  it("restrito: só os jogadores dos afiliados dele (btrim), nunca de outro afiliado ou casa", async () => {
    const r = await resolveExpertCampaignAudienceFor(CTX, { criteria: rulesCriteria, channel: "sms" });
    expect(r.total).toBe(2);
    expect(r.eligibleTotal).toBe(2);
    const call = rpcCalls.find((c) => c.fn === "resolve_sms_audience_v2")!;
    expect((call.args._criteria as Row).affiliateIds).toEqual(["AFF1"]);
  });

  it("prévia devolve só contagens: nenhum telefone, e-mail ou id", async () => {
    const r = await resolveExpertCampaignAudienceFor(CTX, { criteria: rulesCriteria, channel: "email" });
    expect(r.phones).toEqual([]);
    expect(r.emailPlayerIds).toEqual([]);
    expect(r.eligibleIdentifiers).toEqual([]);
    expect(r.eligiblePlayerIds).toEqual([]);
    expect(r.eligibleTotal).toBe(2);
    expect(r.estimatedCost).toBeCloseTo(0.004, 6);
  });

  it("restrito sem afiliado: ninguém (sem consultar o RPC)", async () => {
    setExpert({ affiliateIds: [] });
    const r = await resolveExpertCampaignAudienceFor(CTX, { criteria: rulesCriteria, channel: "sms" });
    expect(r.total).toBe(0);
    expect(rpcCalls.filter((c) => c.fn === "resolve_sms_audience_v2")).toHaveLength(0);
  });

  it("acesso total: a casa toda (sem filtro de afiliado)", async () => {
    setExpert({ tipo: "total" });
    const r = await resolveExpertCampaignAudienceFor(CTX, { criteria: rulesCriteria, channel: "sms" });
    expect(r.total).toBe(4);
    const call = rpcCalls.find((c) => c.fn === "resolve_sms_audience_v2")!;
    expect("affiliateIds" in (call.args._criteria as Row)).toBe(false);
  });

  it("affiliateIds vindo do navegador é descartado (não amplia o escopo)", async () => {
    await resolveExpertCampaignAudienceFor(CTX, {
      criteria: { ...rulesCriteria, affiliateIds: ["AFF2"] },
      channel: "sms",
    });
    const call = rpcCalls.find((c) => c.fn === "resolve_sms_audience_v2")!;
    expect((call.args._criteria as Row).affiliateIds).toEqual(["AFF1"]);
  });

  it("playerIds injetados de fora do escopo são descartados", async () => {
    const r = await resolveExpertCampaignAudienceFor(CTX, {
      criteria: rulesCriteria,
      channel: "sms",
      playerIds: [pid(1), pid(3), pid(9)],
    });
    expect(r.total).toBe(1);
  });

  it("lista de jogadores dentro do critério (forma de lista externa) é recusada", async () => {
    await expect(
      saveExpertSmsCampaignFor(CTX, {
        campaignName: "x",
        content: "oi",
        audienceCriteria: { timing: "selection", playerIds: [pid(1)] },
      }),
    ).rejects.toThrow(/pelo id/);
  });
});

describe("públicos próprios x da casa", () => {
  beforeEach(() => {
    fake.admin.rows("sms_audiences").push(
      { id: "house-1", tenant_id: TENANT, expert_id: null, name: "Casa VIP", criteria: { level: "gold" }, updated_at: "2" },
      { id: "mine-1", tenant_id: TENANT, expert_id: ME, name: "Meu", criteria: { level: "silver" }, updated_at: "3" },
      { id: "other-1", tenant_id: TENANT, expert_id: OTHER_EXPERT, name: "Dele", criteria: { level: "black" }, updated_at: "4" },
    );
  });

  it("restrito lista só os próprios", async () => {
    const list = await listExpertAudiencesFor(CTX);
    expect(list.map((a) => a.id)).toEqual(["mine-1"]);
  });

  it("acesso total lista os próprios e os da casa (só leitura), nunca de outro expert", async () => {
    setExpert({ tipo: "total" });
    const list = await listExpertAudiencesFor(CTX);
    expect(list.map((a) => [a.id, a.owner, a.readOnly])).toEqual([
      ["mine-1", "meu", false],
      ["house-1", "casa", true],
    ]);
  });

  it("não edita nem apaga público da casa ou de outro expert", async () => {
    await expect(
      saveExpertAudienceFor(CTX, { id: "house-1", name: "Hack", criteria: rulesCriteria }),
    ).rejects.toThrow(EXPERT_AUDIENCE_NOT_FOUND);
    await expect(deleteExpertAudienceFor(CTX, { id: "other-1" })).rejects.toThrow(
      EXPERT_AUDIENCE_NOT_FOUND,
    );
    await deleteExpertAudienceFor(CTX, { id: "mine-1" });
    expect(fake.admin.rows("sms_audiences").map((a) => a.id)).toEqual(["house-1", "other-1"]);
  });

  it("público novo fica com o expert como dono", async () => {
    const saved = await saveExpertAudienceFor(CTX, { name: "Prata", criteria: { level: "silver" } });
    expect(saved.owner).toBe("meu");
    const row = fake.admin.rows("sms_audiences").find((a) => a.name === "Prata")!;
    expect(row.expert_id).toBe(ME);
  });

  it("seleção guarda só jogadores do escopo", async () => {
    const created = await createExpertSelectionAudienceFor(CTX, { playerIds: [pid(1), pid(3), pid(9)] });
    expect(created).toMatchObject({ playerCount: 1, discarded: 2 });
    const row = fake.admin.rows("sms_audiences").find((a) => a.id === created.id)!;
    expect(row.expert_id).toBe(ME);
    expect((row.criteria as Row).playerIds).toEqual([pid(1)]);
  });

  it("restrito não usa público da casa numa campanha (seleção por id)", async () => {
    fake.admin.rows("sms_audiences").push({
      id: pid(500),
      tenant_id: TENANT,
      expert_id: null,
      name: "Seleção casa",
      criteria: { timing: "selection", playerIds: [pid(1), pid(3)], selectionCount: 2 },
    });
    await expect(
      resolveExpertCampaignAudienceFor(CTX, {
        criteria: { timing: "selection", audienceId: pid(500) },
        channel: "sms",
      }),
    ).rejects.toThrow();
  });

  it("acesso total usa a seleção da casa por id", async () => {
    setExpert({ tipo: "total" });
    fake.admin.rows("sms_audiences").push({
      id: pid(500),
      tenant_id: TENANT,
      expert_id: null,
      name: "Seleção casa",
      criteria: { timing: "selection", playerIds: [pid(1), pid(3)], selectionCount: 2 },
    });
    const r = await resolveExpertCampaignAudienceFor(CTX, {
      criteria: { timing: "selection", audienceId: pid(500) },
      channel: "sms",
    });
    expect(r.total).toBe(2);
  });
});

describe("campanha de SMS do expert", () => {
  it("modo livre: grava agendada (fila do worker), dona do expert, sem lista de telefones", async () => {
    const r = await saveExpertSmsCampaignFor(CTX, {
      campaignName: "Promo",
      content: "Oi {nome} https://casa.bet/promo",
      audienceCriteria: rulesCriteria,
    });
    expect(r).toMatchObject({ channel: "sms", status: "agendada", approvalStatus: null, queued: true, totalCount: 2 });
    const row = fake.admin.rows("sms_campaigns")[0];
    expect(row).toMatchObject({ expert_id: ME, tenant_id: TENANT, recipients: [], short_domain_id: null, track_links: true });
    expect((row.audience_criteria as Row).affiliateIds).toBeUndefined();
  });

  it("modo aprovação: fica pendente", async () => {
    setExpert({ envioModo: "aprovacao" });
    const r = await saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
    expect(r).toMatchObject({ status: "aguardando_aprovacao", approvalStatus: "pendente" });
  });

  it("link fora da casa é recusado", async () => {
    await expect(
      saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "veja https://evil.com/x", audienceCriteria: rulesCriteria }),
    ).rejects.toThrow(/Link não permitido: evil.com/);
    expect(fake.admin.rows("sms_campaigns")).toHaveLength(0);
  });

  it("sem destinatário no escopo: recusa", async () => {
    setExpert({ affiliateIds: ["NINGUEM"] });
    await expect(
      saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria }),
    ).rejects.toThrow(EXPERT_NO_RECIPIENTS);
  });

  it("editar campanha aprovada a devolve para pendente", async () => {
    setExpert({ envioModo: "aprovacao" });
    const r = await saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
    await approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({ status: "agendada", approval_status: "aprovada" });
    const edited = await saveExpertSmsCampaignFor(CTX, {
      id: r.id,
      campaignName: "P2",
      content: "oi de novo",
      audienceCriteria: rulesCriteria,
    });
    expect(edited).toMatchObject({ status: "aguardando_aprovacao", approvalStatus: "pendente" });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({ approved_by: null, approved_at: null });
  });

  it("não edita campanha que já começou a enviar", async () => {
    const r = await saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
    Object.assign(fake.admin.rows("sms_campaigns")[0], { status: "enviando", sent_cursor: 1 });
    await expect(
      saveExpertSmsCampaignFor(CTX, { id: r.id, campaignName: "P", content: "x", audienceCriteria: rulesCriteria }),
    ).rejects.toThrow(/não pode mais ser editada/);
  });
});

describe("teto mensal: pré-checagem", () => {
  it("teto 0 bloqueia com mensagem clara", async () => {
    setExpert({ tetoMensal: 0 });
    await expect(
      saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria }),
    ).rejects.toThrow(EXPERT_CAP_BLOCKED);
  });

  it("estimativa acima do que resta do teto é recusada", async () => {
    setExpert({ tetoMensal: 1 });
    fake.admin.rows("expert_monthly_usage").push({ expert_id: ME, month: expertCapMonth(), amount: 0.9 });
    // 2 destinatários × 1 segmento × 0,08 = 0,16 > 0,10
    await expect(
      saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria }),
    ).rejects.toThrow(/restam R\$ 0,10 do seu teto mensal de R\$ 1,00/);
  });

  it("sem teto (null) não bloqueia", async () => {
    await expect(
      saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria }),
    ).resolves.toMatchObject({ estimatedCost: 0.16 });
  });

  it("uso: teto, usado, restante, pendentes e mês", async () => {
    setExpert({ tetoMensal: 10, envioModo: "aprovacao" });
    fake.admin.rows("expert_monthly_usage").push({ expert_id: ME, month: expertCapMonth(), amount: 2.5 });
    await saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
    const usage = await getExpertCampaignUsageFor(CTX);
    expect(usage).toMatchObject({ teto: 10, usado: 2.5, restante: 7.5, pendentes: 1, pendentesEstimado: 0.16 });
    expect(usage.mes).toBe(expertCapMonth().slice(0, 7));
  });
});

describe("aprovação pelo admin", () => {
  async function pendingSms() {
    setExpert({ envioModo: "aprovacao" });
    return saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
  }

  it("aprovar re-valida e libera para o worker (agendada)", async () => {
    const r = await pendingSms();
    const approved = await approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id });
    expect(approved).toMatchObject({ ok: true, status: "agendada", totalCount: 2 });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({
      status: "agendada",
      approval_status: "aprovada",
      approved_by: ADMIN,
    });
  });

  it("aprovar re-checa o teto (aumentou o uso desde a criação)", async () => {
    const r = await pendingSms();
    setExpert({ envioModo: "aprovacao", tetoMensal: 0.1 });
    await expect(approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      /teto mensal/,
    );
    expect(fake.admin.rows("sms_campaigns")[0].approval_status).toBe("pendente");
  });

  it("aprovar re-checa o escopo: afiliado desvinculado → sem destinatários", async () => {
    const r = await pendingSms();
    setExpert({ envioModo: "aprovacao", affiliateIds: [] });
    await expect(approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      EXPERT_NO_RECIPIENTS,
    );
  });

  it("expert desativado não tem campanha aprovada", async () => {
    const r = await pendingSms();
    fake.admin.rows("experts")[0].ativo = false;
    await expect(approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      EXPERT_INACTIVE_CANNOT_APPROVE,
    );
  });

  it("recusar guarda o motivo; não aprova de novo", async () => {
    const r = await pendingSms();
    await rejectExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id, reason: "Texto agressivo" });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({
      status: "recusada",
      approval_status: "recusada",
      rejection_reason: "Texto agressivo",
    });
    await expect(approveExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      EXPERT_CAMPAIGN_NOT_PENDING,
    );
    const mine = await listExpertCampaignsFor(CTX);
    expect(mine.items[0]).toMatchObject({ approvalStatus: "recusada", rejectionReason: "Texto agressivo" });
  });

  it("campanha de outra casa não é encontrada", async () => {
    const r = await pendingSms();
    await expect(approveExpertCampaignCore(OTHER_TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      "Campanha não encontrada.",
    );
  });

  it("pausar e retomar; retomar recusa no teto", async () => {
    const r = await saveExpertSmsCampaignFor(CTX, { campaignName: "P", content: "oi", audienceCriteria: rulesCriteria });
    await pauseExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({ status: "pausada", last_error: "Pausada pelo admin" });
    setExpert({ tetoMensal: 1 });
    fake.admin.rows("expert_monthly_usage").push({ expert_id: ME, month: expertCapMonth(), amount: 1 });
    await expect(resumeExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id })).rejects.toThrow(
      /continua no teto/,
    );
    fake.admin.rows("expert_monthly_usage")[0].amount = 0.2;
    await resumeExpertCampaignCore(TENANT, ADMIN, { channel: "sms", id: r.id });
    expect(fake.admin.rows("sms_campaigns")[0]).toMatchObject({ status: "enviando", last_error: null });
  });

  it("lista do admin traz o nome do expert", async () => {
    await pendingSms();
    const { items } = await listExpertCampaignsForAdminCore(TENANT, {});
    expect(items[0]).toMatchObject({ expertId: ME, expertNome: "Eu", approvalStatus: "pendente" });
  });
});

describe("campanha de e-mail do expert", () => {
  it("conteúdo livre vira snapshot; remetente/encurtador da casa; público só no servidor", async () => {
    const r = await saveExpertEmailCampaignFor(CTX, {
      nome: "News",
      assunto: "Oi",
      html: '<a href="https://casa.bet/x">x</a>',
      audienceCriteria: rulesCriteria,
      status: "agendada",
    });
    expect(r).toMatchObject({ status: "agendada", totalCount: 2 });
    const row = fake.admin.rows("email_campaigns")[0];
    expect(row).toMatchObject({ expert_id: ME, sender_id: null, short_domain_id: null, template_id: null });
    expect((row.audience_filter as Row).extra_emails).toEqual([]);
    expect((row.template_snapshot as Row).body_html).toContain("casa.bet");
  });

  it("link externo no HTML é recusado", async () => {
    await expect(
      saveExpertEmailCampaignFor(CTX, {
        nome: "News",
        assunto: "Oi",
        html: '<a href="https://evil.com">x</a>',
        audienceCriteria: rulesCriteria,
        status: "agendada",
      }),
    ).rejects.toThrow(/Link não permitido/);
  });
});

describe("campanha de voz do expert", () => {
  beforeEach(() => {
    fake.admin.rows("call_scripts").push({ id: SCRIPT, tenant_id: TENANT, status: "active" });
  });

  it("modo livre: enfileira só jogadores do escopo, com expert_id e campanha", async () => {
    const r = await saveExpertVoiceCampaignFor(CTX, {
      campaign_name: "Voz",
      script_id: SCRIPT,
      audienceCriteria: rulesCriteria,
    });
    expect(r).toMatchObject({ channel: "voice", status: "enfileirada", totalCount: 2 });
    const items = fake.admin.rows("call_queue");
    expect(items.map((i) => i.lead_id).sort()).toEqual([pid(1), pid(2)]);
    for (const i of items) expect(i).toMatchObject({ tenant_id: TENANT, expert_id: ME, expert_voice_campaign_id: r.id, status: "audio_ready" });
  });

  it("modo aprovação: nada na fila até aprovar", async () => {
    setExpert({ envioModo: "aprovacao" });
    const r = await saveExpertVoiceCampaignFor(CTX, { campaign_name: "Voz", script_id: SCRIPT, audienceCriteria: rulesCriteria });
    expect(r.status).toBe("aguardando_aprovacao");
    expect(fake.admin.rows("call_queue")).toHaveLength(0);
    const approved = await approveExpertCampaignCore(TENANT, ADMIN, { channel: "voice", id: r.id });
    expect(approved.status).toBe("enfileirada");
    expect(fake.admin.rows("call_queue")).toHaveLength(2);
  });
});
