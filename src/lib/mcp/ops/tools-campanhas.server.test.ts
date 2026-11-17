// MCP do grupo §5.7–§5.9: campanhas, jornadas and alertas over an in-memory
// database. resolverEscopoOps (the only permission gate, tested in
// scope.server.test.ts) is mocked to return houses A and B; house C exists
// in the database too and must never be read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./ops-fake-db.test-support").createOpsFakeDb>,
  enforcement: false,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createOpsFakeDb } = await import("./ops-fake-db.test-support");
  fake.db = createOpsFakeDb();
  return { supabaseAdmin: fake.db.client };
});

vi.mock("@/lib/billing/billing-state.server", () => ({
  isBillingEnforcementEnabled: () => fake.enforcement,
}));

vi.mock("./scope.server", () => ({
  resolverEscopoOps: vi.fn(),
}));

import type { McpIdentity } from "../access.server";
import { alertas } from "./alertas.server";
import { campanhas } from "./campanhas.server";
import { jornadas } from "./jornadas.server";
import { CAMPANHAS_TOOLS } from "./tools-campanhas.server";
import { assertSemDadosPessoais } from "./runner.server";
import { resolverEscopoOps, type CasaOps } from "./scope.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const casa = (
  id: string,
  nome: string,
  moeda: CasaOps["moeda"] = "BRL",
  status = "active",
): CasaOps => ({
  id,
  nome,
  moeda,
  status,
  isDemo: false,
  grupo: { id: "g1", nome: "Grupo 1" },
});

const identity: McpIdentity = {
  userId: "user-1",
  connectionId: "conn",
  clientId: "client",
  level: "read",
  areas: ["operacao"],
};

// 2026-11-17 12:00 in Brasília.
const NOW = new Date("2026-11-17T15:00:00Z");
const escopo = { tipo: "grupo" as const, id: "00000000-0000-4000-8000-000000000001" };
const periodo7d = { preset: "7d" as const };

const mockedResolver = vi.mocked(resolverEscopoOps);

function tenantIdsRead() {
  return new Set(fake.db.queries.flatMap((q) => q.tenantIds ?? []));
}

function seedCampaigns() {
  const db = fake.db;
  db.rows("sms_campaigns").push(
    {
      id: "sms-a1",
      tenant_id: A,
      name: "Promo SMS",
      status: "enviado",
      created_at: "2026-11-15T12:00:00.000Z",
      scheduled_at: "2026-11-15T13:00:00.000Z",
      total_count: 100,
      sent_count: 95,
      failed_count: 5,
      expert_id: "exp-1",
    },
    // Created before the period, scheduled inside it: in.
    {
      id: "sms-a2",
      tenant_id: A,
      name: "Agendada",
      status: "agendada",
      created_at: "2026-10-01T12:00:00.000Z",
      scheduled_at: "2026-11-16T13:00:00.000Z",
      total_count: 10,
      sent_count: 0,
      failed_count: 0,
      expert_id: null,
    },
    // Outside the period: out.
    {
      id: "sms-a-old",
      tenant_id: A,
      name: "Velha",
      status: "enviado",
      created_at: "2026-10-01T12:00:00.000Z",
      scheduled_at: "2026-10-01T13:00:00.000Z",
      total_count: 1,
      sent_count: 1,
      failed_count: 0,
      expert_id: null,
    },
    {
      id: "sms-c1",
      tenant_id: C,
      name: "Outra casa",
      status: "enviado",
      created_at: "2026-11-15T12:00:00.000Z",
      scheduled_at: "2026-11-15T12:00:00.000Z",
      total_count: 1,
      sent_count: 1,
      failed_count: 0,
      expert_id: null,
    },
  );
  db.rows("email_campaigns").push({
    id: "email-b1",
    tenant_id: B,
    name: "Newsletter",
    status: "enviado",
    created_at: "2026-11-16T12:00:00.000Z",
    scheduled_at: null,
    stats: { total: 50, enviados: 40, falhas: 11 },
    expert_id: null,
  });
  db.rows("voice_campaigns").push({
    id: "voice-a1",
    tenant_id: A,
    name: "Ligação",
    status: "sending",
    created_at: "2026-11-16T11:00:00.000Z",
    scheduled_at: null,
    recipient_count: 3,
  });
  db.rows("webpush_campaigns").push({
    id: "push-b1",
    tenant_id: B,
    name: "Push",
    status: "falhou",
    created_at: "2026-11-14T12:00:00.000Z",
    scheduled_at: "2026-11-14T12:00:00.000Z",
    target_count: 0,
    sent_count: 0,
    failed_count: 0,
  });
  db.onRpc("voice_campaign_item_counts", () => ({
    data: [
      {
        voice_campaign_id: "voice-a1",
        status: "completed",
        provider_status: null,
        is_future: false,
        item_count: 2,
      },
      {
        voice_campaign_id: "voice-a1",
        status: "failed",
        provider_status: null,
        is_future: false,
        item_count: 1,
      },
    ],
    error: null,
  }));
  const crm = (tenant: string, source: string, date: string, extra: Record<string, number>) => ({
    tenant_id: tenant,
    metric_date: date,
    source_type: "campaign",
    source_key: source,
    source_id: source,
    step_position: -1,
    player_state: "ativo",
    sent: 0,
    failed: 0,
    cost: 0,
    human_clicks: 0,
    direct_conversions: 0,
    direct_revenue: 0,
    ...extra,
  });
  db.rows("crm_results_daily").push(
    crm(A, "sms-a1", "2026-11-15", {
      sent: 60,
      failed: 2,
      cost: 4.8,
      human_clicks: 7,
      direct_conversions: 2,
      direct_revenue: 150,
    }),
    crm(A, "sms-a1", "2026-11-16", {
      sent: 35,
      cost: 2.8,
      human_clicks: 3,
      direct_conversions: 1,
      direct_revenue: 50.5,
    }),
    // Outside the period: not counted.
    crm(A, "sms-a1", "2026-11-01", { sent: 999, cost: 999 }),
    // E-mail: clicks only (no SMS cost) → custo_brl null.
    crm(B, "email-b1", "2026-11-16", {
      human_clicks: 4,
      direct_conversions: 1,
      direct_revenue: 20,
    }),
  );
}

beforeEach(() => {
  fake.db.reset();
  fake.enforcement = false;
  mockedResolver.mockReset();
  mockedResolver.mockResolvedValue({
    casas: [casa(A, "Alfa"), casa(B, "Beta", "ARS")],
    rotulo: "Grupo 1",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CAMPANHAS_TOOLS", () => {
  it("registers campanhas, jornadas and alertas", () => {
    expect(CAMPANHAS_TOOLS.map((tool) => tool.name)).toEqual(["campanhas", "jornadas", "alertas"]);
  });

  it("the gate refusal propagates and nothing is read", async () => {
    mockedResolver.mockRejectedValue(new Error("Você não tem acesso à operação deste grupo."));
    for (const tool of CAMPANHAS_TOOLS) {
      const args = tool.name === "alertas" ? { escopo } : { escopo, periodo: periodo7d };
      await expect(tool.run(identity, args)).rejects.toThrow("Você não tem acesso");
    }
    expect(fake.db.queries).toEqual([]);
    expect(fake.db.rpcCalls).toEqual([]);
  });
});

describe("campanhas", () => {
  it("lists campaigns of the period with Central results, only of the resolved houses", async () => {
    seedCampaigns();
    const result = await campanhas(identity, { escopo, periodo: periodo7d }, NOW);

    expect(mockedResolver).toHaveBeenCalledWith("user-1", escopo);
    expect(tenantIdsRead()).toEqual(new Set([A, B]));
    assertSemDadosPessoais(result);

    expect(result.periodo).toEqual({ inicio: "2026-11-11", fim: "2026-11-17", preset: "7d" });
    expect(result.campanhas.map((c) => c.id)).toEqual([
      "email-b1",
      "voice-a1",
      "sms-a1",
      "push-b1",
      "sms-a2",
    ]);
    expect(result.truncado).toBe(false);

    const sms = result.campanhas.find((c) => c.id === "sms-a1")!;
    expect(sms).toMatchObject({
      canal: "sms",
      casa: { id: A, nome: "Alfa", moeda: "BRL" },
      total: 100,
      enviados: 95,
      falhas: 5,
      expert_id: "exp-1",
      resultados: {
        custo_brl: 7.6,
        cliques_humanos: 10,
        conversoes_diretas: 3,
        receita_direta: 200.5,
      },
    });
    // Campaign without a Central row in the period: null, not zeros.
    expect(result.campanhas.find((c) => c.id === "sms-a2")!.resultados).toBeNull();
    // Voice has no link to the Central: null; counts from call_queue.
    expect(result.campanhas.find((c) => c.id === "voice-a1")).toMatchObject({
      total: 3,
      enviados: 2,
      falhas: 1,
      expert_id: null,
      resultados: null,
    });
    // E-mail: stats jsonb counts, clicks from the Central, no cost.
    expect(result.campanhas.find((c) => c.id === "email-b1")).toMatchObject({
      total: 50,
      enviados: 40,
      falhas: 11,
      resultados: {
        custo_brl: null,
        cliques_humanos: 4,
        conversoes_diretas: 1,
        receita_direta: 20,
      },
    });

    const alfa = result.casas.find((c) => c.id === A)!;
    expect(alfa.campanhas).toBe(3);
    expect(alfa.por_canal.find((r) => r.canal === "sms")).toEqual({
      canal: "sms",
      campanhas: 2,
      enviados: 95,
      falhas: 5,
      custo_brl: 7.6,
      cliques_humanos: 10,
      conversoes_diretas: 3,
      receita_direta: 200.5,
    });
    expect(alfa.por_canal.find((r) => r.canal === "voz")).toMatchObject({
      campanhas: 1,
      custo_brl: null,
      cliques_humanos: null,
    });

    // Two currencies: two totals, never one sum.
    expect(result.totais_por_moeda.map((t) => t.moeda)).toEqual(["ARS", "BRL"]);
    expect(result.totais_por_moeda.find((t) => t.moeda === "BRL")!.totais).toMatchObject({
      campanhas: 3,
      receita_direta: 200.5,
      custo_brl: 7.6,
    });
    expect(result.totais_por_moeda.find((t) => t.moeda === "ARS")!.totais).toMatchObject({
      campanhas: 2,
      receita_direta: 20,
      custo_brl: null,
    });
    expect(result.casas_com_erro).toEqual([]);
  });

  it("canal, status and limite filter and truncate", async () => {
    seedCampaigns();
    const onlySms = await campanhas(identity, { escopo, periodo: periodo7d, canal: "sms" }, NOW);
    expect(onlySms.campanhas.every((c) => c.canal === "sms")).toBe(true);
    expect(fake.db.queries.some((q) => q.table === "email_campaigns")).toBe(false);

    const agendadas = await campanhas(
      identity,
      { escopo, periodo: periodo7d, status: "agendada" },
      NOW,
    );
    expect(agendadas.campanhas.map((c) => c.id)).toEqual(["sms-a2"]);

    const cut = await campanhas(identity, { escopo, periodo: periodo7d, limite: 2 }, NOW);
    expect(cut.campanhas).toHaveLength(2);
    expect(cut.truncado).toBe(true);
    expect(cut.casas.reduce((acc, c) => acc + c.campanhas, 0)).toBe(5);
  });

  it("a failing house goes to casas_com_erro; the other answers", async () => {
    seedCampaigns();
    fake.db.fail("sms_campaigns", "statement timeout", B);
    const result = await campanhas(identity, { escopo, periodo: periodo7d }, NOW);
    expect(result.casas.map((c) => c.id)).toEqual([A]);
    expect(result.casas_com_erro).toEqual([{ id: B, nome: "Beta", erro: "statement timeout" }]);
    expect(result.campanhas.every((c) => c.casa.id === A)).toBe(true);
  });

  it("every house failing is an error", async () => {
    fake.db.fail("sms_campaigns", "fora do ar");
    await expect(campanhas(identity, { escopo, periodo: periodo7d }, NOW)).rejects.toThrow(
      "Nenhuma casa respondeu. fora do ar",
    );
  });
});

describe("jornadas", () => {
  function seedJourneys() {
    const db = fake.db;
    db.rows("journeys").push(
      {
        id: "j-a1",
        tenant_id: A,
        name: "Boas-vindas",
        status: "active",
        trigger_type: "player_registered",
        daily_limit: 500,
        updated_at: "2026-11-10T00:00:00Z",
        revision_of: null,
      },
      {
        id: "j-a2",
        tenant_id: A,
        name: "Rascunho",
        status: "draft",
        trigger_type: "manual",
        daily_limit: null,
        updated_at: "2026-11-12T00:00:00Z",
        revision_of: null,
      },
      // Applied revision: hidden like the panel.
      {
        id: "j-a3",
        tenant_id: A,
        name: "Revisão",
        status: "archived",
        trigger_type: "manual",
        daily_limit: null,
        updated_at: "2026-11-13T00:00:00Z",
        revision_of: "j-a1",
      },
      {
        id: "j-b1",
        tenant_id: B,
        name: "Reativação",
        status: "paused",
        trigger_type: "inactivity",
        daily_limit: 100,
        updated_at: "2026-11-11T00:00:00Z",
        revision_of: null,
      },
      {
        id: "j-c1",
        tenant_id: C,
        name: "Outra",
        status: "active",
        trigger_type: "manual",
        daily_limit: null,
        updated_at: "2026-11-11T00:00:00Z",
        revision_of: null,
      },
    );
    db.onRpc("list_journey_metrics", (args) => ({
      data:
        args.p_tenant_id === A
          ? [
              {
                journey_id: "j-a1",
                metrics: {
                  total: 12,
                  byStatus: { active: 4, completed: 8 },
                  sentByChannel: { sms: 20, email: 3 },
                  finishedWithoutMessage: 2,
                  recovered: 310.456,
                },
              },
            ]
          : [],
      error: null,
    }));
    db.rows("crm_results_daily").push({
      tenant_id: A,
      metric_date: "2026-11-16",
      source_type: "journey",
      source_key: "j-a1",
      source_id: "j-a1",
      step_position: 0,
      player_state: "ativo",
      sent: 9,
      failed: 1,
      cost: 0.72,
      human_clicks: 2,
      direct_conversions: 1,
      direct_revenue: 40,
    });
  }

  it("journeys with metrics, only of the resolved houses; no periodo → no Central numbers", async () => {
    seedJourneys();
    const result = await jornadas(identity, { escopo }, NOW);
    assertSemDadosPessoais(result);
    expect(tenantIdsRead()).toEqual(new Set([A, B]));
    expect(fake.db.rpcCalls.map((c) => c.args.p_tenant_id).sort()).toEqual([A, B].sort());
    expect(result.periodo).toBeNull();
    expect(result.jornadas.map((j) => j.id)).toEqual(["j-a2", "j-b1", "j-a1"]);
    expect(result.jornadas.find((j) => j.id === "j-a1")).toEqual({
      casa: { id: A, nome: "Alfa", moeda: "BRL" },
      id: "j-a1",
      nome: "Boas-vindas",
      status: "active",
      gatilho: "player_registered",
      limite_diario: 500,
      atualizada_em: "2026-11-10T00:00:00Z",
      inscritos: { total: 12, por_status: { active: 4, completed: 8 } },
      enviados_por_canal: [
        { canal: "sms", enviados: 20 },
        { canal: "email", enviados: 3 },
      ],
      concluiram_sem_mensagem: 2,
      receita_recuperada: 310.46,
    });
    expect(result.jornadas.find((j) => j.id === "j-a1")).not.toHaveProperty("periodo_resultados");
    expect(result.casas.find((c) => c.id === A)).toMatchObject({
      jornadas: 2,
      por_status: { active: 1, draft: 1 },
      inscritos: 12,
    });
  });

  it("with periodo: Central numbers, null when the journey has none; status filters", async () => {
    seedJourneys();
    const result = await jornadas(identity, { escopo, periodo: periodo7d }, NOW);
    expect(result.jornadas.find((j) => j.id === "j-a1")!.periodo_resultados).toEqual({
      enviados_sms: 9,
      falhas_sms: 1,
      custo_brl: 0.72,
      cliques_humanos: 2,
      conversoes_diretas: 1,
      receita_direta: 40,
    });
    expect(result.jornadas.find((j) => j.id === "j-a2")!.periodo_resultados).toBeNull();
    expect(result.casas.find((c) => c.id === B)!.periodo_resultados).toBeNull();
    expect(result.totais_por_moeda.find((t) => t.moeda === "BRL")!.totais).toMatchObject({
      jornadas: 2,
      enviados_sms: 9,
      custo_brl: 0.72,
    });

    const ativas = await jornadas(identity, { escopo, status: "active" }, NOW);
    expect(ativas.jornadas.map((j) => j.id)).toEqual(["j-a1"]);
  });

  it("a failing house goes to casas_com_erro", async () => {
    seedJourneys();
    fake.db.fail("journeys", "boom", A);
    const result = await jornadas(identity, { escopo }, NOW);
    expect(result.casas_com_erro).toEqual([{ id: A, nome: "Alfa", erro: "boom" }]);
    expect(result.jornadas.map((j) => j.id)).toEqual(["j-b1"]);
  });
});

describe("alertas", () => {
  function seedAlerts() {
    const db = fake.db;
    seedCampaigns();
    db.rows("tenant_billing").push(
      { tenant_id: A, access_state: "ok" },
      { tenant_id: B, access_state: "locked_manual" },
      { tenant_id: C, access_state: "locked_manual" },
    );
    db.rows("tenant_wallets").push(
      { tenant_id: A, balance: 5 },
      { tenant_id: B, balance: 0 },
      { tenant_id: C, balance: 0 },
    );
    db.onRpc("finance_send_usage", (args) => ({
      data: (args._tenants as string[]).flatMap((tenant) =>
        tenant === A
          ? ["2026-11-14", "2026-11-15", "2026-11-16"].map((day) => ({
              tenant_id: A,
              metric_date: day,
              item: "sms",
              units: 100,
              amount: 10,
              missing_cost_units: 0,
            }))
          : [],
      ),
      error: null,
    }));
    db.rows("journeys").push(
      { id: "j-stale", tenant_id: A, name: "Parada", status: "active" },
      { id: "j-fresh", tenant_id: A, name: "Viva", status: "active" },
      { id: "j-never", tenant_id: B, name: "Nunca enviou", status: "active" },
      { id: "j-c", tenant_id: C, name: "Outra", status: "active" },
    );
    db.rows("journey_step_executions").push(
      {
        tenant_id: A,
        journey_id: "j-stale",
        status: "sent",
        created_at: "2026-11-14T10:00:00.000Z",
      },
      {
        tenant_id: A,
        journey_id: "j-fresh",
        status: "delivered",
        created_at: "2026-11-17T10:00:00.000Z",
      },
      {
        tenant_id: A,
        journey_id: "j-fresh",
        status: "sent",
        created_at: "2026-11-10T10:00:00.000Z",
      },
      {
        tenant_id: B,
        journey_id: "j-never",
        status: "failed",
        created_at: "2026-11-10T10:00:00.000Z",
      },
    );
    db.rows("expert_cap_alerts").push(
      { tenant_id: A, expert_id: "exp-1", month: "2026-11-01" },
      { tenant_id: A, expert_id: "exp-old", month: "2026-10-01" },
      { tenant_id: C, expert_id: "exp-c", month: "2026-11-01" },
    );
    db.rows("experts").push({ id: "exp-1", nome: "Ana" }, { id: "exp-old", nome: "Velho" });
    db.rows("tenant_daily_metrics").push(
      { tenant_id: A, metric_date: "2026-11-16", registrations: 0, approved_deposit_count: 0 },
      { tenant_id: A, metric_date: "2026-11-17", registrations: 0, approved_deposit_count: 0 },
      { tenant_id: B, metric_date: "2026-11-17", registrations: 3, approved_deposit_count: 0 },
    );
  }

  it("finds every alert type of the resolved houses, sorted by gravidade then casa", async () => {
    seedAlerts();
    const result = await alertas(identity, { escopo }, NOW);
    assertSemDadosPessoais(result);
    expect(tenantIdsRead()).toEqual(new Set([A, B]));
    expect(fake.db.rpcCalls.find((c) => c.fn === "finance_send_usage")!.args).toMatchObject({
      _from: "2026-11-14",
      _to: "2026-11-16",
    });

    expect(
      result.alertas.map((a) => `${a.gravidade}:${a.casa.nome}:${a.tipo}:${a.ref?.id ?? ""}`),
    ).toEqual([
      "alta:Alfa:integracao_parada:",
      "alta:Beta:bloqueio_cobranca:",
      "media:Alfa:campanha_com_falha:voice-a1",
      "media:Alfa:jornada_sem_envio:j-stale",
      "media:Alfa:saldo_baixo:",
      "media:Alfa:teto_expert:exp-1",
      "media:Beta:campanha_com_falha:email-b1",
      "media:Beta:campanha_com_falha:push-b1",
    ]);
    expect(result.casas).toEqual([
      { id: A, nome: "Alfa", alertas: 5 },
      { id: B, nome: "Beta", alertas: 3 },
    ]);
    expect(result.verificacoes_com_erro).toEqual([]);
    expect(result.casas_com_erro).toEqual([]);
  });

  it("suspended house: alta, and no integration alert on top", async () => {
    seedAlerts();
    mockedResolver.mockResolvedValue({
      casas: [casa(A, "Alfa", "BRL", "suspended")],
      rotulo: "Alfa",
    });
    const result = await alertas(identity, { escopo: { tipo: "casa", id: A } }, NOW);
    const tipos = result.alertas.map((a) => a.tipo);
    expect(tipos).toContain("casa_suspensa");
    expect(tipos).not.toContain("integracao_parada");
  });

  it("a failing check goes to verificacoes_com_erro and the rest still run", async () => {
    seedAlerts();
    fake.db.fail("tenant_wallets", "sem permissão");
    const result = await alertas(identity, { escopo }, NOW);
    expect(result.verificacoes_com_erro).toEqual([{ verificacao: "saldo", erro: "sem permissão" }]);
    expect(result.alertas.some((a) => a.tipo === "teto_expert")).toBe(true);
  });

  it("billing lock follows the enforcement rule (awaiting_first_payment only with it on)", async () => {
    fake.db.rows("tenant_billing").push({ tenant_id: A, access_state: "awaiting_first_payment" });
    fake.db.onRpc("finance_send_usage", () => ({ data: [], error: null }));
    mockedResolver.mockResolvedValue({ casas: [casa(A, "Alfa")], rotulo: "Alfa" });
    const off = await alertas(identity, { escopo: { tipo: "casa", id: A } }, NOW);
    expect(off.alertas.some((a) => a.tipo === "bloqueio_cobranca")).toBe(false);
    fake.enforcement = true;
    const on = await alertas(identity, { escopo: { tipo: "casa", id: A } }, NOW);
    expect(on.alertas.some((a) => a.tipo === "bloqueio_cobranca")).toBe(true);
  });
});
