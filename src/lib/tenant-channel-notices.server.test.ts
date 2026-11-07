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

const USER = "00000000-0000-4000-8000-0000000000u1";
const OTHER_USER = "00000000-0000-4000-8000-0000000000u2";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000ad";
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const DISABLED_AT = "2026-11-05T12:00:00.000Z";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
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

    expect(pending).toEqual([{ channel: "voice", disabledAt: DISABLED_AT }]);
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
      { channel: "voice", disabledAt: newDisabledAt },
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
