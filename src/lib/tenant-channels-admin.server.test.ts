// Task 5: super admin liga/desliga um canal da casa, cancelando o que está
// agendado/pausado naquele canal. Design: docs/superpowers/specs/
// 2026-11-05-contas-padrao-canais-por-casa-design.md, §3 and §5.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("@/lib/admin-audit.server", () => ({
  auditAdminAction: vi.fn(async (args: Record<string, unknown>) => {
    audit.calls.push(args);
  }),
}));

import { adminSetTenantChannelFor, adminTenantChannelImpactFor } from "./tenant-channels-admin.server";
import { __resetTenantChannelsCacheForTests, isChannelEnabled } from "./tenant-channels.server";

const ADMIN = { userId: "00000000-0000-4000-8000-0000000000ad" };
const NOT_ADMIN = { userId: "00000000-0000-4000-8000-0000000000ee" };
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  fake.db.reset();
  audit.calls = [];
  __resetTenantChannelsCacheForTests();
  fake.db.onRpc("is_super_admin", (args) => ({
    data: args._user_id === ADMIN.userId,
    error: null,
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("adminSetTenantChannelFor", () => {
  it("only the super admin gets in", async () => {
    await expect(
      adminSetTenantChannelFor(NOT_ADMIN, { tenantId: TENANT, channel: "sms", enabled: false }),
    ).rejects.toThrow(/plataforma/);
  });

  it("desligar grava enabled=false/disabled_at, audita e invalida o cache", async () => {
    expect(await isChannelEnabled(TENANT, "sms")).toBe(true);

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 0 });
    const row = fake.db.rows("tenant_channels")[0];
    expect(row).toMatchObject({ tenant_id: TENANT, channel: "sms", enabled: false, updated_by: ADMIN.userId });
    expect(row.disabled_at).toBeTruthy();
    expect(audit.calls).toEqual([
      expect.objectContaining({
        actorUserId: ADMIN.userId,
        action: "tenant_channel.disable",
        tenantId: TENANT,
        before: { channel: "sms", enabled: true },
        after: { channel: "sms", enabled: false },
      }),
    ]);

    __resetTenantChannelsCacheForTests();
    expect(await isChannelEnabled(TENANT, "sms")).toBe(false);
  });

  it("desligar SMS cancela campanhas agendada/pausada da casa, mas não de outra casa", async () => {
    fake.db.rows("sms_campaigns").push(
      { id: "camp-agendada", tenant_id: TENANT, status: "agendada", last_error: null },
      { id: "camp-pausada", tenant_id: TENANT, status: "pausada", last_error: "Saldo insuficiente" },
      { id: "camp-enviando", tenant_id: TENANT, status: "enviando", last_error: null },
      { id: "camp-outra-casa", tenant_id: OTHER_TENANT, status: "agendada", last_error: null },
    );

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 2 });
    const byId = (id: string) => fake.db.rows("sms_campaigns").find((r) => r.id === id)!;
    expect(byId("camp-agendada")).toMatchObject({
      status: "cancelada",
      last_error: "Canal SMS desabilitado para a casa.",
    });
    expect(byId("camp-pausada")).toMatchObject({
      status: "cancelada",
      last_error: "Canal SMS desabilitado para a casa.",
    });
    expect(byId("camp-enviando")).toMatchObject({ status: "enviando" });
    expect(byId("camp-outra-casa")).toMatchObject({ status: "agendada", tenant_id: OTHER_TENANT });
  });

  it("desligar webpush cancela agendada/pausada via cancelWebpushCampaign", async () => {
    // webpush começa desligado por padrão para a casa: liga primeiro para o
    // "desligar" ter campanhas de fato para cancelar.
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "webpush",
      enabled: true,
      disabled_at: null,
    });
    fake.db.rows("webpush_campaigns").push(
      { id: "wp-agendada", tenant_id: TENANT, status: "agendada", last_error: null },
      { id: "wp-pausada", tenant_id: TENANT, status: "pausada", last_error: null },
      { id: "wp-enviando", tenant_id: TENANT, status: "enviando", last_error: null },
    );

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "webpush",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 2 });
    const byId = (id: string) => fake.db.rows("webpush_campaigns").find((r) => r.id === id)!;
    expect(byId("wp-agendada").status).toBe("cancelada");
    expect(byId("wp-pausada").status).toBe("cancelada");
    expect(byId("wp-enviando").status).toBe("enviando");
  });

  it("desligar e-mail pausa agendada com blocked_reason='channel_disabled'", async () => {
    fake.db.rows("email_campaigns").push(
      { id: "mail-agendada", tenant_id: TENANT, status: "agendada", blocked_reason: null },
      { id: "mail-enviando", tenant_id: TENANT, status: "enviando", blocked_reason: null },
      { id: "mail-pausada", tenant_id: TENANT, status: "pausada", blocked_reason: "outro motivo" },
    );

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "email",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 1 });
    const byId = (id: string) => fake.db.rows("email_campaigns").find((r) => r.id === id)!;
    expect(byId("mail-agendada")).toMatchObject({ status: "pausada", blocked_reason: "channel_disabled" });
    expect(byId("mail-enviando")).toMatchObject({ status: "enviando", blocked_reason: null });
    expect(byId("mail-pausada")).toMatchObject({ status: "pausada", blocked_reason: "outro motivo" });
  });

  it("desligar voz cancela itens pendentes do call_queue", async () => {
    fake.db.rows("call_queue").push(
      { id: "cq-1", tenant_id: TENANT, status: "pending_audio" },
      { id: "cq-2", tenant_id: TENANT, status: "audio_ready" },
      { id: "cq-3", tenant_id: TENANT, status: "queued" },
      { id: "cq-4", tenant_id: TENANT, status: "paused" },
      { id: "cq-5", tenant_id: TENANT, status: "completed" },
    );

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "voice",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 4 });
    const byId = (id: string) => fake.db.rows("call_queue").find((r) => r.id === id)!;
    expect(byId("cq-1").status).toBe("cancelled");
    expect(byId("cq-2").status).toBe("cancelled");
    expect(byId("cq-3").status).toBe("cancelled");
    expect(byId("cq-4").status).toBe("cancelled");
    expect(byId("cq-5").status).toBe("completed");
  });

  it("religar grava enabled=true/disabled_at=null e não reativa o que foi cancelado", async () => {
    fake.db.rows("sms_campaigns").push({ id: "camp-1", tenant_id: TENANT, status: "agendada", last_error: null });
    await adminSetTenantChannelFor(ADMIN, { tenantId: TENANT, channel: "sms", enabled: false });
    audit.calls = [];

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      enabled: true,
    });

    expect(result).toEqual({ cancelled: 0 });
    const row = fake.db.rows("tenant_channels")[0];
    expect(row).toMatchObject({ enabled: true, disabled_at: null });
    expect(audit.calls).toEqual([
      expect.objectContaining({
        action: "tenant_channel.enable",
        before: { channel: "sms", enabled: false },
        after: { channel: "sms", enabled: true },
      }),
    ]);
    // The campaign cancelled while the channel was off stays cancelled.
    expect(fake.db.rows("sms_campaigns")[0]).toMatchObject({ status: "cancelada" });
  });

  it("desligar um canal já desligado é no-op: não muda disabled_at, sem auditoria nova", async () => {
    await adminSetTenantChannelFor(ADMIN, { tenantId: TENANT, channel: "sms", enabled: false });
    const disabledAtAfterFirst = fake.db.rows("tenant_channels")[0].disabled_at;
    audit.calls = [];

    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 0 });
    expect(fake.db.rows("tenant_channels")[0].disabled_at).toBe(disabledAtAfterFirst);
    expect(audit.calls).toEqual([]);
  });

  it("desligar webpush (padrão já desligado, sem linha) também é no-op", async () => {
    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "webpush",
      enabled: false,
    });

    expect(result).toEqual({ cancelled: 0 });
    expect(fake.db.rows("tenant_channels")).toEqual([]);
    expect(audit.calls).toEqual([]);
  });

  it("ligar webpush para uma casa cria uma linha enabled=true", async () => {
    const result = await adminSetTenantChannelFor(ADMIN, {
      tenantId: TENANT,
      channel: "webpush",
      enabled: true,
    });

    expect(result).toEqual({ cancelled: 0 });
    expect(fake.db.rows("tenant_channels")[0]).toMatchObject({
      tenant_id: TENANT,
      channel: "webpush",
      enabled: true,
      disabled_at: null,
    });
    expect(audit.calls).toEqual([
      expect.objectContaining({
        action: "tenant_channel.enable",
        before: { channel: "webpush", enabled: false },
        after: { channel: "webpush", enabled: true },
      }),
    ]);
  });
});

describe("adminTenantChannelImpactFor", () => {
  it("only the super admin gets in", async () => {
    await expect(
      adminTenantChannelImpactFor(NOT_ADMIN, { tenantId: TENANT, channel: "sms" }),
    ).rejects.toThrow(/plataforma/);
  });

  it("conta jornadas ativas com passo do canal e campanhas agendadas/pausadas/enviando", async () => {
    fake.db.rows("journeys").push(
      { id: "j-active-sms", tenant_id: TENANT, status: "active" },
      { id: "j-active-other-channel", tenant_id: TENANT, status: "active" },
      { id: "j-paused", tenant_id: TENANT, status: "paused" },
      { id: "j-other-tenant", tenant_id: OTHER_TENANT, status: "active" },
    );
    fake.db.rows("journey_steps").push(
      { id: "s1", journey_id: "j-active-sms", step_type: "sms", is_enabled: true },
      { id: "s2", journey_id: "j-active-sms", step_type: "wait", is_enabled: true },
      { id: "s3", journey_id: "j-active-other-channel", step_type: "email", is_enabled: true },
      { id: "s4", journey_id: "j-paused", step_type: "sms", is_enabled: true },
      { id: "s5", journey_id: "j-other-tenant", step_type: "sms", is_enabled: true },
    );
    fake.db.rows("sms_campaigns").push(
      { id: "c1", tenant_id: TENANT, status: "agendada" },
      { id: "c2", tenant_id: TENANT, status: "pausada" },
      { id: "c3", tenant_id: TENANT, status: "enviando" },
      { id: "c4", tenant_id: TENANT, status: "cancelada" },
      { id: "c5", tenant_id: OTHER_TENANT, status: "agendada" },
    );

    const result = await adminTenantChannelImpactFor(ADMIN, { tenantId: TENANT, channel: "sms" });

    expect(result).toEqual({ activeJourneys: 1, scheduledCampaigns: 3 });
  });

  it("webpush não tem passo de jornada hoje: activeJourneys sempre 0", async () => {
    fake.db.rows("journeys").push({ id: "j1", tenant_id: TENANT, status: "active" });
    fake.db.rows("journey_steps").push({ id: "s1", journey_id: "j1", step_type: "sms", is_enabled: true });
    fake.db.rows("webpush_campaigns").push({ id: "wp1", tenant_id: TENANT, status: "agendada" });

    const result = await adminTenantChannelImpactFor(ADMIN, { tenantId: TENANT, channel: "webpush" });

    expect(result).toEqual({ activeJourneys: 0, scheduledCampaigns: 1 });
  });
});
