// Task 10: aviso "Ciente" quando um canal da casa é desligado. Design:
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md,
// §4.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { ackChannelNoticeFor, getPendingChannelNoticesFor } from "./tenant-channel-notices.server";
import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";
import { __resetProviderAccountsCacheForTests } from "./provider-accounts.server";

const USER = "00000000-0000-4000-8000-0000000000u1";
const OTHER_USER = "00000000-0000-4000-8000-0000000000u2";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000ad";
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const DISABLED_AT = "2026-11-05T12:00:00.000Z";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
  __resetProviderAccountsCacheForTests();
  fake.db.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER_ADMIN, error: null }));
  fake.db.onRpc("has_tenant_access", (args) => ({
    data: args._user_id === USER && args._tenant_id === TENANT,
    error: null,
  }));
});

function disableChannel(tenantId: string, channel: string, disabledAt: string) {
  fake.db.rows("tenant_channels").push({
    tenant_id: tenantId,
    channel,
    enabled: false,
    disabled_at: disabledAt,
  });
}

describe("getPendingChannelNoticesFor", () => {
  it("pendente depois de desligar o canal", async () => {
    disableChannel(TENANT, "voice", DISABLED_AT);

    const pending = await getPendingChannelNoticesFor(USER, TENANT);

    expect(pending).toEqual([{ kind: "disabled", channel: "voice", disabledAt: DISABLED_AT }]);
  });

  it("vazio quando nenhum canal está desligado", async () => {
    expect(await getPendingChannelNoticesFor(USER, TENANT)).toEqual([]);
  });

  it("vazio depois do ack", async () => {
    disableChannel(TENANT, "voice", DISABLED_AT);
    await ackChannelNoticeFor(USER, { tenantId: TENANT, channel: "voice", disabledAt: DISABLED_AT });

    expect(await getPendingChannelNoticesFor(USER, TENANT)).toEqual([]);
  });

  it("reaparece com um novo disabled_at (religar + desligar de novo)", async () => {
    disableChannel(TENANT, "voice", DISABLED_AT);
    await ackChannelNoticeFor(USER, { tenantId: TENANT, channel: "voice", disabledAt: DISABLED_AT });
    expect(await getPendingChannelNoticesFor(USER, TENANT)).toEqual([]);

    // Religa (remove a linha "desligado") e desliga de novo com outro disabled_at.
    const rows = fake.db.rows("tenant_channels");
    rows.length = 0;
    __resetTenantChannelsCacheForTests();
    const newDisabledAt = "2026-11-06T09:00:00.000Z";
    disableChannel(TENANT, "voice", newDisabledAt);
    __resetTenantChannelsCacheForTests();

    expect(await getPendingChannelNoticesFor(USER, TENANT)).toEqual([
      { kind: "disabled", channel: "voice", disabledAt: newDisabledAt },
    ]);
  });

  it("vazio para o super admin mesmo com canal desligado", async () => {
    disableChannel(TENANT, "voice", DISABLED_AT);

    expect(await getPendingChannelNoticesFor(SUPER_ADMIN, TENANT)).toEqual([]);
  });
});

describe("ackChannelNoticeFor", () => {
  it("grava o ack (idempotente)", async () => {
    disableChannel(TENANT, "voice", DISABLED_AT);

    await ackChannelNoticeFor(USER, { tenantId: TENANT, channel: "voice", disabledAt: DISABLED_AT });
    await ackChannelNoticeFor(USER, { tenantId: TENANT, channel: "voice", disabledAt: DISABLED_AT });

    expect(fake.db.rows("tenant_channel_notice_acks")).toHaveLength(1);
    expect(fake.db.rows("tenant_channel_notice_acks")[0]).toMatchObject({
      user_id: USER,
      tenant_id: TENANT,
      channel: "voice",
      disabled_at: DISABLED_AT,
    });
  });

  it("recusa ack de uma casa alheia", async () => {
    disableChannel(OTHER_TENANT, "voice", DISABLED_AT);

    await expect(
      ackChannelNoticeFor(OTHER_USER, { tenantId: OTHER_TENANT, channel: "voice", disabledAt: DISABLED_AT }),
    ).rejects.toThrow(/acesso/i);

    expect(fake.db.rows("tenant_channel_notice_acks")).toEqual([]);
  });
});

// Conta própria (Task 11): a revogação da concessão pausa a conta própria da
// casa; o aviso "Ciente" reaproveita tenant_channel_notice_acks com channel
// "own:<canal>" e disabled_at = revoked_at.
describe("aviso de revogação da conta própria", () => {
  const ADMIN = USER;
  const GESTOR = "00000000-0000-4000-8000-0000000000g1";
  const EXPERT = "00000000-0000-4000-8000-0000000000e1";
  const OWN_SMS = "00000000-0000-4000-a000-0000000000b1";
  const REVOKED_AT = "2026-11-07T10:00:00.000Z";

  function revokeOwnSms(revokedAt: string, pendingDecision = true) {
    const grants = fake.db.rows("tenant_own_provider_grants");
    grants.length = 0;
    grants.push({
      tenant_id: TENANT,
      channel: "sms",
      allowed: false,
      monthly_fee_cents: 0,
      revoked_at: revokedAt,
      pending_decision: pendingDecision,
    });
    const accounts = fake.db.rows("provider_accounts");
    accounts.length = 0;
    accounts.push({
      id: OWN_SMS,
      provider: "short_brasil",
      label: "Conta da casa",
      channels: ["sms"],
      credentials_source: "db",
      credentials_encrypted: "x",
      config: {},
      status: "disabled",
      disabled_reason: "revoked",
      owner_tenant_id: TENANT,
    });
    const links = fake.db.rows("tenant_channel_providers");
    links.length = 0;
    links.push({ tenant_id: TENANT, channel: "sms", provider_account_id: OWN_SMS });
    __resetProviderAccountsCacheForTests();
  }

  beforeEach(() => {
    fake.db.onRpc("has_tenant_access", (args) => ({
      data: [ADMIN, GESTOR].includes(String(args._user_id)) && args._tenant_id === TENANT,
      error: null,
    }));
    fake.db.rows("user_roles").push({ user_id: EXPERT, tenant_id: TENANT, role: "expert" });
    fake.db.rows("experts").push({
      id: "expert-1",
      user_id: EXPERT,
      tenant_id: TENANT,
      nome: "Expert",
      tipo: "restrito",
      envio_modo: "casa",
      teto_mensal: 0,
      ativo: true,
    });
  });

  it("aparece para admin, gestor e expert da casa", async () => {
    revokeOwnSms(REVOKED_AT);
    for (const user of [ADMIN, GESTOR, EXPERT]) {
      expect(await getPendingChannelNoticesFor(user, TENANT)).toEqual([
        { kind: "own_revoked", channel: "sms", disabledAt: REVOKED_AT },
      ]);
    }
  });

  it("nunca para o super admin", async () => {
    revokeOwnSms(REVOKED_AT);
    expect(await getPendingChannelNoticesFor(SUPER_ADMIN, TENANT)).toEqual([]);
  });

  it("some depois do Ciente (ack em own:sms com disabled_at = revoked_at), só para quem confirmou", async () => {
    revokeOwnSms(REVOKED_AT);
    await ackChannelNoticeFor(EXPERT, {
      tenantId: TENANT,
      kind: "own_revoked",
      channel: "sms",
      disabledAt: REVOKED_AT,
    });

    expect(fake.db.rows("tenant_channel_notice_acks")).toEqual([
      expect.objectContaining({
        user_id: EXPERT,
        tenant_id: TENANT,
        channel: "own:sms",
        disabled_at: REVOKED_AT,
      }),
    ]);
    expect(await getPendingChannelNoticesFor(EXPERT, TENANT)).toEqual([]);
    // O ack de revogação não confirma um desligamento de canal, nem vale para outro usuário.
    expect(await getPendingChannelNoticesFor(GESTOR, TENANT)).toHaveLength(1);
  });

  it("revogar de novo (novo revoked_at) traz o aviso de volta", async () => {
    revokeOwnSms(REVOKED_AT);
    await ackChannelNoticeFor(ADMIN, {
      tenantId: TENANT,
      kind: "own_revoked",
      channel: "sms",
      disabledAt: REVOKED_AT,
    });
    expect(await getPendingChannelNoticesFor(ADMIN, TENANT)).toEqual([]);

    const again = "2026-11-08T09:00:00.000Z";
    revokeOwnSms(again);

    expect(await getPendingChannelNoticesFor(ADMIN, TENANT)).toEqual([
      { kind: "own_revoked", channel: "sms", disabledAt: again },
    ]);
  });

  it("'manter pausado' (decisão tomada, conta ainda pausada) continua avisando quem não confirmou", async () => {
    revokeOwnSms(REVOKED_AT, false);
    expect(await getPendingChannelNoticesFor(ADMIN, TENANT)).toEqual([
      { kind: "own_revoked", channel: "sms", disabledAt: REVOKED_AT },
    ]);
  });

  it("depois de 'usar a padrão' (sem decisão pendente, sem link) não avisa mais", async () => {
    revokeOwnSms(REVOKED_AT, false);
    fake.db.rows("tenant_channel_providers").length = 0;
    __resetProviderAccountsCacheForTests();
    expect(await getPendingChannelNoticesFor(ADMIN, TENANT)).toEqual([]);
  });

  it("ack de revogação de canal sem conta própria (webpush) é recusado", async () => {
    await expect(
      ackChannelNoticeFor(ADMIN, {
        tenantId: TENANT,
        kind: "own_revoked",
        channel: "webpush",
        disabledAt: REVOKED_AT,
      }),
    ).rejects.toThrow();
    expect(fake.db.rows("tenant_channel_notice_acks")).toEqual([]);
  });
});
