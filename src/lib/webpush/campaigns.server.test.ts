// Web push (OneSignal) — Task 10: campaign scheduling, listing and audience
// count. Mocks @/integrations/supabase/client.server so assertDestinationAllowed
// (shortio.server.ts, hardwired to supabaseAdmin) reads shortio_settings /
// tenants from the same in-memory fake db instance passed explicitly as `db`
// to the functions under test (same pattern as links.server.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import {
  cancelWebpushCampaign,
  countWebpushAudience,
  listWebpushCampaigns,
  scheduleWebpushCampaign,
} from "./campaigns.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const CAMPAIGN_URL = "https://casa.bet/promo";

beforeEach(() => {
  fake.db.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedActiveApp(tenantId = TENANT, status = "ativo", id = `app-${tenantId}`) {
  fake.db.rows("tenant_webpush_apps").push({ id, tenant_id: tenantId, status });
  return id;
}

function seedSubscription(appId: string, tenantId = TENANT, overrides: Record<string, unknown> = {}) {
  fake.db.rows("push_subscriptions").push({
    id: `sub-${fake.db.rows("push_subscriptions").length + 1}`,
    tenant_id: tenantId,
    app_id: appId,
    status: "ativa",
    ...overrides,
  });
}

function seedPlayer(id: string, tenantId = TENANT) {
  fake.db.rows("players").push({ id, tenant_id: tenantId, telefone: "11999990000", email: null });
}

function stubPrice(unitPrice: number, exempt = false) {
  fake.db.onRpc("billing_effective_price", () => ({
    data: { unit_price: unitPrice, provider_unit_cost: 0, free_monthly_units: 0, exempt },
    error: null,
  }));
}

const baseScheduleInput = {
  tenantId: TENANT,
  name: "Campanha teste",
  title: "Título",
  body: "Corpo da mensagem",
  url: CAMPAIGN_URL,
  scheduledAt: null as string | null,
};

describe("scheduleWebpushCampaign", () => {
  it("recusa link http://", async () => {
    seedActiveApp();
    await expect(
      scheduleWebpushCampaign(fake.db.client, {
        ...baseScheduleInput,
        audience: { kind: "todos" },
        url: "http://casa.bet/promo",
      }),
    ).rejects.toThrow(/https/i);
  });

  it("recusa agendar quando a casa não tem app ativa", async () => {
    // No tenant_webpush_apps row at all.
    await expect(
      scheduleWebpushCampaign(fake.db.client, { ...baseScheduleInput, audience: { kind: "todos" } }),
    ).rejects.toThrow(/Web Push não instalado nesta casa/);
  });

  it("recusa quando o único app da casa ainda está instalando (não passou pelo teste)", async () => {
    seedActiveApp(TENANT, "instalando");
    await expect(
      scheduleWebpushCampaign(fake.db.client, { ...baseScheduleInput, audience: { kind: "todos" } }),
    ).rejects.toThrow(/Web Push não instalado nesta casa/);
  });

  it("recusa agendar 30s no futuro (menos de 60s)", async () => {
    seedActiveApp();
    const in30s = new Date(Date.now() + 30_000).toISOString();
    await expect(
      scheduleWebpushCampaign(fake.db.client, {
        ...baseScheduleInput,
        audience: { kind: "todos" },
        scheduledAt: in30s,
      }),
    ).rejects.toThrow(/60 segundos/);
  });

  it("aceita agendar 90s no futuro", async () => {
    seedActiveApp();
    const in90s = new Date(Date.now() + 90_000).toISOString();
    const result = await scheduleWebpushCampaign(fake.db.client, {
      ...baseScheduleInput,
      audience: { kind: "todos" },
      scheduledAt: in90s,
    });
    expect(result.id).toBeTruthy();
  });

  it("audiência 'todos' grava target_player_ids = null e conta inscrições ativas de apps ativo/legado", async () => {
    const appId = seedActiveApp();
    seedSubscription(appId);
    seedSubscription(appId);
    const legadoApp = seedActiveApp(TENANT, "legado", "app-legado");
    seedSubscription(legadoApp);
    // inactive app's subscription must not be counted.
    const desativado = seedActiveApp(TENANT, "desativado", "app-desativado");
    seedSubscription(desativado);

    await scheduleWebpushCampaign(fake.db.client, { ...baseScheduleInput, audience: { kind: "todos" } });

    const row = fake.db.rows("webpush_campaigns")[0] as Record<string, unknown>;
    expect(row.audience_kind).toBe("todos");
    expect(row.target_player_ids).toBeNull();
    expect(row.target_count).toBe(3);
  });

  it("audiência 'filtro' grava os ids de jogadores resolvidos e audience_criteria", async () => {
    const appId = seedActiveApp();
    const p1 = "00000000-0000-4000-8000-0000000000f1";
    const p2 = "00000000-0000-4000-8000-0000000000f2";
    seedPlayer(p1);
    seedPlayer(p2);
    seedSubscription(appId, TENANT, { player_id: p1 });
    seedSubscription(appId, TENANT, { player_id: p2 });
    // A subscription of a player not in the filter must not be counted.
    const otherPlayer = "00000000-0000-4000-8000-0000000000f9";
    seedPlayer(otherPlayer);
    seedSubscription(appId, TENANT, { player_id: otherPlayer });

    const result = await scheduleWebpushCampaign(fake.db.client, {
      ...baseScheduleInput,
      audience: { kind: "filtro", criteria: { playerIds: [p1, p2] } },
    });

    expect(result.id).toBeTruthy();
    const row = fake.db.rows("webpush_campaigns")[0] as Record<string, unknown>;
    expect(row.audience_kind).toBe("filtro");
    expect((row.target_player_ids as string[]).sort()).toEqual([p1, p2].sort());
    expect(row.target_count).toBe(2);
    expect(row.audience_criteria).toBeTruthy();
  });

  it("não deixa jogador de outra casa entrar no filtro", async () => {
    const appId = seedActiveApp();
    const mine = "00000000-0000-4000-8000-0000000000f1";
    const theirs = "00000000-0000-4000-8000-0000000000f2";
    seedPlayer(mine, TENANT);
    seedPlayer(theirs, OTHER_TENANT);
    seedSubscription(appId, TENANT, { player_id: mine });

    const result = await scheduleWebpushCampaign(fake.db.client, {
      ...baseScheduleInput,
      audience: { kind: "filtro", criteria: { playerIds: [mine, theirs] } },
    });

    const row = fake.db.rows("webpush_campaigns").find((r) => r.id === result.id) as Record<
      string,
      unknown
    >;
    expect(row.target_player_ids).toEqual([mine]);
    expect(row.target_count).toBe(1);
  });
});

describe("countWebpushAudience", () => {
  it("em casa isenta (plano interno) devolve unitPrice 0", async () => {
    stubPrice(0.01, true);
    const appId = seedActiveApp();
    seedSubscription(appId);
    seedSubscription(appId);

    const result = await countWebpushAudience(fake.db.client, TENANT, { kind: "todos" });

    expect(result.unitPrice).toBe(0);
    expect(result.estimatedCost).toBe(0);
    expect(result.subscriptions).toBe(2);
    expect(result.players).toBeNull();
  });

  it("em casa normal devolve o preço efetivo e o custo estimado", async () => {
    stubPrice(0.01, false);
    const appId = seedActiveApp();
    seedSubscription(appId);
    seedSubscription(appId);
    seedSubscription(appId);

    const result = await countWebpushAudience(fake.db.client, TENANT, { kind: "todos" });

    expect(result.unitPrice).toBe(0.01);
    expect(result.subscriptions).toBe(3);
    expect(result.estimatedCost).toBeCloseTo(0.03, 5);
  });

  it("audiência 'filtro' devolve a contagem de jogadores e de inscrições casadas", async () => {
    stubPrice(0.01, false);
    const appId = seedActiveApp();
    const p1 = "00000000-0000-4000-8000-0000000000f1";
    const p2 = "00000000-0000-4000-8000-0000000000f2";
    seedPlayer(p1);
    seedPlayer(p2);
    seedSubscription(appId, TENANT, { player_id: p1 });
    // p2 has no active subscription.

    const result = await countWebpushAudience(fake.db.client, TENANT, {
      kind: "filtro",
      criteria: { playerIds: [p1, p2] },
    });

    expect(result.players).toBe(2);
    expect(result.subscriptions).toBe(1);
  });
});

describe("listWebpushCampaigns", () => {
  it("lista só as campanhas da casa, com os campos projetados", async () => {
    fake.db.rows("webpush_campaigns").push(
      {
        id: "c1",
        tenant_id: TENANT,
        name: "Campanha A",
        status: "agendada",
        scheduled_at: "2026-11-10T00:00:00.000Z",
        target_count: 10,
        sent_count: 0,
        failed_count: 0,
        created_at: "2026-11-05T00:00:00.000Z",
      },
      {
        id: "c2",
        tenant_id: OTHER_TENANT,
        name: "Campanha de outra casa",
        status: "agendada",
        scheduled_at: "2026-11-10T00:00:00.000Z",
        target_count: 5,
        sent_count: 0,
        failed_count: 0,
        created_at: "2026-11-05T00:00:00.000Z",
      },
    );

    const list = await listWebpushCampaigns(fake.db.client, TENANT);

    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: "c1",
      name: "Campanha A",
      status: "agendada",
      scheduledAt: "2026-11-10T00:00:00.000Z",
      targetCount: 10,
      sentCount: 0,
      failedCount: 0,
      createdAt: "2026-11-05T00:00:00.000Z",
    });
  });
});

describe("cancelWebpushCampaign", () => {
  function seedCampaign(status: string) {
    fake.db.rows("webpush_campaigns").push({
      id: "c1",
      tenant_id: TENANT,
      name: "Campanha",
      status,
      scheduled_at: "2026-11-10T00:00:00.000Z",
      target_count: 10,
      sent_count: 0,
      failed_count: 0,
      created_at: "2026-11-05T00:00:00.000Z",
    });
  }

  it("cancela uma campanha agendada", async () => {
    seedCampaign("agendada");
    const result = await cancelWebpushCampaign(fake.db.client, { tenantId: TENANT, id: "c1" });
    expect(result.ok).toBe(true);
    expect((fake.db.rows("webpush_campaigns")[0] as Record<string, unknown>).status).toBe(
      "cancelada",
    );
  });

  it("cancela uma campanha pausada", async () => {
    seedCampaign("pausada");
    const result = await cancelWebpushCampaign(fake.db.client, { tenantId: TENANT, id: "c1" });
    expect(result.ok).toBe(true);
  });

  it("recusa cancelar uma campanha já enviada", async () => {
    seedCampaign("enviado");
    await expect(
      cancelWebpushCampaign(fake.db.client, { tenantId: TENANT, id: "c1" }),
    ).rejects.toThrow(/não pode mais ser cancelada/);
    expect((fake.db.rows("webpush_campaigns")[0] as Record<string, unknown>).status).toBe(
      "enviado",
    );
  });

  it("recusa cancelar uma campanha de outra casa", async () => {
    seedCampaign("agendada");
    await expect(
      cancelWebpushCampaign(fake.db.client, { tenantId: OTHER_TENANT, id: "c1" }),
    ).rejects.toThrow(/não pode mais ser cancelada/);
  });
});
