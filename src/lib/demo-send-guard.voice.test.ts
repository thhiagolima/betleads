// Task 4 — demo send guard on Infobip voice calls (callInfobipVoice).
//
// Runs the real guard (assertTenantNotDemoForSend) against an in-memory
// database and a mocked fetch. For a demo tenant, an unknown tenant id or an
// empty tenantId, nothing may reach the network. A normal tenant is the
// control: it reaches fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { callInfobipVoice } from "./infobip-voice.server";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const UNKNOWN = "00000000-0000-4000-8000-00000000000f";

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async () => Response.json({ callId: "call-1" }));
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  fake.db
    .rows("tenants")
    .push({ id: NORMAL, status: "active", is_demo: false }, { id: DEMO, status: "active", is_demo: true });
  vi.stubEnv("INFOBIP_BASE_URL", "https://infobip.example");
  vi.stubEnv("INFOBIP_API_KEY", "infobip-test-key");
  vi.stubEnv("INFOBIP_VOICE_FROM", "+551130000000");
  vi.stubEnv("INFOBIP_VOICE_CALLBACK_TOKEN", "callback-token");
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example.test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const content = { type: "tts" as const, text: "Oi", language: "pt" };

describe("callInfobipVoice demo send guard", () => {
  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no fetch", async () => {
    await expect(
      callInfobipVoice("+5511999999999", content, { tenantId: DEMO }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks an unknown tenant (fail-closed)", async () => {
    await expect(
      callInfobipVoice("+5511999999999", content, { tenantId: UNKNOWN }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks an empty tenantId (fail-closed)", async () => {
    await expect(
      callInfobipVoice("+5511999999999", content, { tenantId: "" }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("control: a normal tenant reaches the provider fetch", async () => {
    const result = await callInfobipVoice("+5511999999999", content, { tenantId: NORMAL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.providerCallId).toBe("call-1");
  });

  it("a tenant lookup failure is fail-closed (no fetch)", async () => {
    fake.db.failNext("tenants", "select", "connection reset");
    await expect(
      callInfobipVoice("+5511999999999", content, { tenantId: NORMAL }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
