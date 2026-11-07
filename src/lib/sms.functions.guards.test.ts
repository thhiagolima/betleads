// Task 7 (review fix #3) — scheduleBulkSms/sendBulkSms share
// `assertBulkSmsCanSend`, extracted so the guard can be unit-tested
// directly (createServerFn handlers can't: the TanStack Start compiler
// swaps their body for a client-side stub — see journeys.functions.ts's
// `assertNoNewDisabledChannelSteps`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
// assertTenantCanOperate/assertTenantNotDemoForSend are exercised by their
// own suites; here they're no-ops so only the channel guard is under test.
vi.mock("@/lib/tenant-access.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-access.server")>();
  return {
    ...actual,
    assertTenantCanOperate: vi.fn(async () => undefined),
    assertTenantNotDemoForSend: vi.fn(async () => undefined),
  };
});

import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";
import { assertBulkSmsCanSend } from "./sms.functions";

const TENANT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
});

describe("assertBulkSmsCanSend (scheduleBulkSms/sendBulkSms guard)", () => {
  it("casa com SMS desligado lança CHANNEL_DISABLED_MESSAGE", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "sms",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });
    await expect(assertBulkSmsCanSend(TENANT)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
  });

  it("casa sem linha (SMS ligado por padrão) resolve normalmente", async () => {
    await expect(assertBulkSmsCanSend(TENANT)).resolves.toBeUndefined();
  });
});
