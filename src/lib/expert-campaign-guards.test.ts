// Área do Expert §8 — guardas unitárias: reserva com teto (wallet), recusa de
// voz por teto, portão de voz por tick, escopo no resolvedor de público
// (falha fechado, seleção refiltrada) e links só da casa.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  EXPERT_CAP_REACHED_MESSAGE,
  isExpertRefusal,
  reserveForDelivery,
  reserveUsage,
} from "@/lib/billing/wallet.server";
import { classifyVoiceDispatchResult } from "@/lib/calls.server";
import { ExpertVoiceGate } from "@/lib/expert-voice.server";
import type { ExpertScope } from "@/lib/expert-campaign-scope.server";
import { filterPlayerIdsToExpert } from "@/lib/expert-campaign-scope.server";
import {
  PermanentAudienceError,
  resolveAudienceForTenant,
  type SelectionDb,
} from "@/lib/sms-audience-selection.server";
import {
  assertExpertContentLinksAllowed,
  extractContentUrls,
} from "@/lib/expert-content-policy.server";
import { campaignAudienceCriteriaInput } from "@/lib/sms-audience-criteria";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const EXPERT = "00000000-0000-4000-8000-0000000000e1";
const OTHER_EXPERT = "00000000-0000-4000-8000-0000000000e2";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => fake.admin.reset());

describe("wallet: reserva de envio de expert", () => {
  function rpcClient(error: string | null) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return error
            ? { data: null, error: { message: error } }
            : { data: { idempotent: false, amount: -0.08, balance: 9 }, error: null };
        },
        from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
      },
    };
  }
  const args = { tenantId: TENANT, item: "sms" as const, units: 1, referenceType: "sms_send", referenceId: "r1", idempotencyKey: "k1" };

  it("com expertId usa expert_wallet_reserve; sem, wallet_reserve (casa inalterada)", async () => {
    const withExpert = rpcClient(null);
    await reserveUsage(withExpert.client, { ...args, expertId: EXPERT });
    expect(withExpert.calls[0]).toMatchObject({ fn: "expert_wallet_reserve", args: { _expert: EXPERT, _tenant: TENANT } });
    const house = rpcClient(null);
    await reserveUsage(house.client, args);
    expect(house.calls[0].fn).toBe("wallet_reserve");
    expect("_expert" in house.calls[0].args).toBe(false);
  });

  it("teto atingido vira recusa própria, distinta de saldo insuficiente", async () => {
    const capped = rpcClient("expert_cap_reached");
    const r = await reserveUsage(capped.client, { ...args, expertId: EXPERT });
    expect(r).toEqual({ ok: false, error: EXPERT_CAP_REACHED_MESSAGE, refusal: "expert_cap" });
    const broke = rpcClient("insufficient_balance");
    expect(await reserveUsage(broke.client, { ...args, expertId: EXPERT })).toEqual({
      ok: false,
      error: "Saldo insuficiente",
    });
    const inactive = rpcClient("expert_inactive");
    expect(await reserveUsage(inactive.client, { ...args, expertId: EXPERT })).toMatchObject({
      refusal: "expert_inactive",
    });
    expect(isExpertRefusal("expert_cap")).toBe(true);
    expect(isExpertRefusal("Saldo insuficiente")).toBe(false);
  });

  it("reserveForDelivery repassa o expert e a recusa", async () => {
    const capped = rpcClient("expert_cap_reached");
    const r = await reserveForDelivery(capped.client, {
      tenantId: TENANT,
      item: "voice_30s",
      prefix: "voice",
      deliveryKey: null,
      units: 4,
      referenceType: "voice_call",
      expertId: EXPERT,
    });
    expect(r).toMatchObject({ ok: false, refusal: "expert_cap" });
    expect(capped.calls[0].fn).toBe("expert_wallet_reserve");
  });

  it("voz: recusa por teto tem classificação própria (nunca saldo da casa)", () => {
    expect(classifyVoiceDispatchResult({ ok: false, status: 0, body: {}, errorKind: "expert_cap" })).toBe("expert_cap");
    expect(classifyVoiceDispatchResult({ ok: false, status: 0, body: {}, errorKind: "expert_inactive" })).toBe(
      "expert_inactive",
    );
  });
});

function scope(overrides: Partial<ExpertScope> = {}): ExpertScope {
  return {
    expertId: EXPERT,
    tenantId: TENANT,
    nome: "Eu",
    tipo: "restrito",
    ativo: true,
    envioModo: "livre",
    tetoMensal: null,
    affiliateIds: ["AFF1"],
    ...overrides,
  };
}

describe("portão de voz do expert (por tick)", () => {
  function seedQueue() {
    fake.admin.rows("players").push(
      { id: pid(1), tenant_id: TENANT, affiliate_id: "AFF1" },
      { id: pid(2), tenant_id: TENANT, affiliate_id: "AFF2" },
    );
    fake.admin.rows("call_queue").push(
      { id: "q1", tenant_id: TENANT, lead_id: pid(1), status: "audio_ready", expert_id: EXPERT },
      { id: "q2", tenant_id: TENANT, lead_id: pid(2), status: "audio_ready", expert_id: EXPERT },
      { id: "q3", tenant_id: TENANT, lead_id: pid(1), status: "audio_ready", expert_id: OTHER_EXPERT },
      { id: "q4", tenant_id: TENANT, lead_id: pid(1), status: "audio_ready", expert_id: null },
    );
    fake.admin.rows("expert_voice_campaigns").push({ id: "v1", tenant_id: TENANT, expert_id: EXPERT, status: "enfileirada" });
  }
  const item = (id: string) => fake.admin.rows("call_queue").find((r) => r.id === id) as any;

  it("disca quem está no escopo; cancela quem saiu", async () => {
    seedQueue();
    const gate = new ExpertVoiceGate({ db: fake.admin.client, loadScope: async () => scope(), notifyCap: vi.fn() });
    expect(await gate.admit(item("q1"), { expertId: EXPERT, campaignId: "v1" })).toBe("dial");
    expect(await gate.admit(item("q2"), { expertId: EXPERT, campaignId: "v1" })).toBe("cancelled");
    expect(item("q2")).toMatchObject({ status: "cancelled", provider_status: "fora_do_escopo" });
  });

  it("expert desativado: todos os itens dele cancelados, os de outros intactos", async () => {
    seedQueue();
    const gate = new ExpertVoiceGate({
      db: fake.admin.client,
      loadScope: async () => scope({ ativo: false }),
      notifyCap: vi.fn(),
    });
    expect(await gate.admit(item("q1"), { expertId: EXPERT, campaignId: "v1" })).toBe("cancelled");
    expect(item("q1").status).toBe("cancelled");
    expect(item("q2").status).toBe("cancelled");
    expect(item("q3").status).toBe("audio_ready");
    expect(item("q4").status).toBe("audio_ready");
  });

  it("teto: pausa só os itens desse expert, avisa o admin, e pula o resto do tick", async () => {
    seedQueue();
    const notifyCap = vi.fn(async () => true);
    const gate = new ExpertVoiceGate({ db: fake.admin.client, loadScope: async () => scope(), notifyCap });
    await gate.onCapReached(TENANT, EXPERT);
    expect(item("q1")).toMatchObject({ status: "paused", provider_status: "teto_expert" });
    expect(item("q2").status).toBe("paused");
    expect(item("q3").status).toBe("audio_ready");
    expect(item("q4").status).toBe("audio_ready");
    expect(fake.admin.rows("expert_voice_campaigns")[0].status).toBe("pausada");
    expect(notifyCap).toHaveBeenCalledWith(TENANT, EXPERT);
    expect(await gate.admit(item("q1"), { expertId: EXPERT, campaignId: "v1" })).toBe("skip");
  });
});

describe("resolvedor de público com escopo do expert", () => {
  function db(rpcData: Record<string, unknown> | null = null) {
    const calls: Array<Record<string, unknown>> = [];
    fake.admin.onRpc("resolve_sms_audience_v2", (args) => {
      calls.push(args);
      return { data: rpcData, error: null };
    });
    return { calls, client: fake.admin.client as unknown as SelectionDb };
  }

  it("falha fechado se o RPC não confirmar o escopo (migration ausente)", async () => {
    const { client } = db({ phones: ["5511999990001"], total: 1 });
    await expect(
      resolveAudienceForTenant(client, TENANT, { level: null }, { expertId: EXPERT, affiliateIds: ["AFF1"] }),
    ).rejects.toThrow(/ainda não está disponível/);
  });

  it("seleção do expert é refiltrada pelo escopo atual (afiliado desvinculado)", async () => {
    db();
    fake.admin.rows("players").push(
      { id: pid(1), tenant_id: TENANT, telefone: "11999990001", email: "a@x.com", affiliate_id: "AFF1" },
      { id: pid(2), tenant_id: TENANT, telefone: "11999990002", email: "b@x.com", affiliate_id: "AFF2" },
    );
    fake.admin.rows("sms_audiences").push({
      id: pid(500),
      tenant_id: TENANT,
      expert_id: EXPERT,
      criteria: { timing: "selection", playerIds: [pid(1), pid(2)], selectionCount: 2 },
    });
    // AFF2 was unlinked from the expert after the selection was created.
    const r = await resolveAudienceForTenant(
      fake.admin.client as unknown as SelectionDb,
      TENANT,
      { timing: "selection", audienceId: pid(500) },
      { expertId: EXPERT, affiliateIds: ["AFF1"] },
    );
    expect(r.total).toBe(1);
    expect(r.phones).toEqual(["11999990001"]);
  });

  it("seleção de outro expert é recusada; da casa só para o de acesso total", async () => {
    db();
    fake.admin.rows("sms_audiences").push(
      { id: pid(501), tenant_id: TENANT, expert_id: OTHER_EXPERT, criteria: { timing: "selection", playerIds: [pid(1)] } },
      { id: pid(502), tenant_id: TENANT, expert_id: null, criteria: { timing: "selection", playerIds: [pid(1)] } },
    );
    const client = fake.admin.client as unknown as SelectionDb;
    await expect(
      resolveAudienceForTenant(client, TENANT, { timing: "selection", audienceId: pid(501) }, { expertId: EXPERT, affiliateIds: null }),
    ).rejects.toBeInstanceOf(PermanentAudienceError);
    await expect(
      resolveAudienceForTenant(client, TENANT, { timing: "selection", audienceId: pid(502) }, { expertId: EXPERT, affiliateIds: ["AFF1"] }),
    ).rejects.toBeInstanceOf(PermanentAudienceError);
    await expect(
      resolveAudienceForTenant(client, TENANT, { timing: "selection", audienceId: pid(502) }, { expertId: EXPERT, affiliateIds: null }),
    ).resolves.toBeTruthy();
  });

  it("filterPlayerIdsToExpert: restrito não alcança outro afiliado nem outra casa", async () => {
    fake.admin.rows("players").push(
      { id: pid(1), tenant_id: TENANT, affiliate_id: " AFF1" },
      { id: pid(2), tenant_id: TENANT, affiliate_id: "AFF2" },
      { id: pid(3), tenant_id: "outra", affiliate_id: "AFF1" },
    );
    expect(await filterPlayerIdsToExpert(scope(), [pid(1), pid(2), pid(3)], fake.admin.client)).toEqual([pid(1)]);
    expect(await filterPlayerIdsToExpert(scope({ affiliateIds: [] }), [pid(1)], fake.admin.client)).toEqual([]);
    expect(await filterPlayerIdsToExpert(scope({ tipo: "total" }), [pid(1), pid(2), pid(3)], fake.admin.client)).toEqual([
      pid(1),
      pid(2),
    ]);
  });

  it("lista de jogadores no critério de campanha (forma de lista externa) é recusada", () => {
    expect(campaignAudienceCriteriaInput.safeParse({ timing: "selection", playerIds: [pid(1)] }).success).toBe(false);
  });
});

describe("links no conteúdo do expert", () => {
  beforeEach(() => {
    fake.admin.rows("tenants").push({ id: TENANT, site_url: "https://www.casa.bet" });
    fake.admin.rows("shortio_settings").push({ tenant_id: TENANT, enabled: true, allowed_destination_hosts: ["parceiro.com"] });
  });

  it("aceita site/subdomínio da casa e hosts liberados; recusa o resto (inclusive encurtador)", async () => {
    await expect(
      assertExpertContentLinksAllowed(TENANT, "Veja https://casa.bet/x e https://app.casa.bet e https://parceiro.com/a e www.casa.bet."),
    ).resolves.toBeUndefined();
    await expect(assertExpertContentLinksAllowed(TENANT, "https://bit.ly/abc")).rejects.toThrow(/bit.ly/);
    await expect(assertExpertContentLinksAllowed(TENANT, "golpe www.evil.com/x")).rejects.toThrow(
      /Link não permitido: www.evil.com/,
    );
    await expect(assertExpertContentLinksAllowed(TENANT, '<img src="https://cdn.evil.com/a.png">')).rejects.toThrow();
  });

  it("sem nenhum domínio da casa, nada passa (fecha por padrão)", async () => {
    fake.admin.reset();
    await expect(assertExpertContentLinksAllowed(TENANT, "https://casa.bet")).rejects.toThrow();
    await expect(assertExpertContentLinksAllowed(TENANT, "texto sem link {link_cadastro}")).resolves.toBeUndefined();
  });

  it("extrai URLs de texto e HTML", () => {
    expect(extractContentUrls('Oi https://a.com/x. <a href="https://b.com">b</a> www.c.com')).toEqual([
      "https://a.com/x",
      "https://b.com",
      "www.c.com",
    ]);
  });
});

describe("worker de SMS: campanha de expert pendente/recusada", () => {
  it("nunca recebe deps de envio (lock liberado, nada enviado)", async () => {
    const { expertCampaignDeps } = await import("@/lib/expert-sms-campaign.server");
    const updateCampaign = vi.fn(async () => true);
    const send = vi.fn();
    const base = { updateCampaign, send } as any;
    for (const approval_status of ["pendente", "recusada"]) {
      const deps = await expertCampaignDeps(
        { id: "c", tenant_id: TENANT, expert_id: EXPERT, approval_status } as any,
        base,
        { resolveAudienceTargets: vi.fn(), loadScope: vi.fn(async () => scope()) },
      );
      expect(deps).toBeNull();
    }
    expect(send).not.toHaveBeenCalled();
    expect(updateCampaign).toHaveBeenCalledWith(expect.anything(), { locked_at: null, locked_by: null });
  });
});
