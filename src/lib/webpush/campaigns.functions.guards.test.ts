// Task 7 (review fix #3) — scheduleWebpushCampaignFn's guard sequence,
// extracted as `assertWebpushCampaignCanSend` so it can be unit-tested
// directly (createServerFn handlers can't — see journeys.functions.ts's
// `assertNoNewDisabledChannelSteps`). Covers the brief's Task 1 case: a
// house with no `tenant_channels` row (web push off by default) throws.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
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

import { __resetTenantChannelsCacheForTests } from "@/lib/tenant-channels.server";
import { assertWebpushCampaignCanSend } from "./campaigns.functions";

const TENANT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
});

describe("assertWebpushCampaignCanSend (scheduleWebpushCampaignFn guard)", () => {
  it("casa sem linha em tenant_channels (web push desligado por padrão) lança CHANNEL_DISABLED_MESSAGE", async () => {
    await expect(assertWebpushCampaignCanSend(TENANT)).rejects.toThrow(
      "O canal Web push está desabilitado para esta casa.",
    );
  });

  it("casa com web push ligado explicitamente resolve normalmente", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "webpush",
      enabled: true,
      disabled_at: null,
    });
    await expect(assertWebpushCampaignCanSend(TENANT)).resolves.toBeUndefined();
  });
});
