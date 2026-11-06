// Task 7 (review fix #2) — call flow blocks can be any mix (not "always
// starts with a call"), so `enrollPlayerInCallFlow`/`saveCallFlow` must
// only require voice (and sms, for saveCallFlow) when the flow actually has
// a call block. Extracted as `assertCallFlowEnrollmentCanSend`/
// `assertActiveCallFlowCanSend` so the guard can be unit-tested directly
// (createServerFn handlers can't — see journeys.functions.ts's
// `assertNoNewDisabledChannelSteps`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./infobip-voice.server", () => ({ callInfobipVoice: vi.fn(), normalizeE164BR: vi.fn() }));
vi.mock("./sms.functions", () => ({ sendSmsInternal: vi.fn() }));
vi.mock("./consent.server", () => ({ evaluateVoiceContactPolicy: vi.fn() }));
vi.mock("./send-window.server", () => ({ deferIfOutsideWindow: vi.fn(async () => null) }));
vi.mock("./billing/wallet-alerts.server", () => ({ notifyNoBalance: vi.fn(async () => false) }));

import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";
import { assertActiveCallFlowCanSend, assertCallFlowEnrollmentCanSend } from "./call-flows.functions";

const TENANT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
});

function voiceOff() {
  fake.db.rows("tenant_channels").push({
    tenant_id: TENANT,
    channel: "voice",
    enabled: false,
    disabled_at: "2026-11-05T00:00:00Z",
  });
}

describe("assertCallFlowEnrollmentCanSend (enrollPlayerInCallFlow guard)", () => {
  it("fluxo só com bloco delay: voz desligada não bloqueia (não tem bloco de ligação)", async () => {
    voiceOff();
    await expect(
      assertCallFlowEnrollmentCanSend(TENANT, [{ block_type: "delay" }]),
    ).resolves.toBeUndefined();
  });

  it("fluxo com bloco de ligação: voz desligada bloqueia", async () => {
    voiceOff();
    await expect(
      assertCallFlowEnrollmentCanSend(TENANT, [{ block_type: "call" }]),
    ).rejects.toThrow("O canal Voz está desabilitado para esta casa.");
  });

  it("fluxo sem blocos: nunca bloqueia", async () => {
    voiceOff();
    await expect(assertCallFlowEnrollmentCanSend(TENANT, [])).resolves.toBeUndefined();
  });
});

describe("assertActiveCallFlowCanSend (saveCallFlow guard, flow active)", () => {
  it("bloco de ligação com SMS de follow-up: recusa sms e voz quando ambos desligados", async () => {
    voiceOff();
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "sms",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });
    await expect(
      assertActiveCallFlowCanSend(TENANT, [{ block_type: "call", sms: [{ condition: "always" }] }]),
    ).rejects.toThrow();
  });

  it("só bloco delay: nenhum canal é checado", async () => {
    voiceOff();
    await expect(
      assertActiveCallFlowCanSend(TENANT, [{ block_type: "delay" }]),
    ).resolves.toBeUndefined();
  });
});
