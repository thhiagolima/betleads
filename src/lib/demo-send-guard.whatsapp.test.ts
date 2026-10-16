// Task 5 — demo send guard on the WhatsApp transport (Evolution API).
//
// Runs the real evolutionFetch and the real fail-closed guard
// (assertTenantNotDemoForSend) against an in-memory database and a mocked
// fetch. The tenant is resolved from whatsapp_sessions.instance_name (or an
// explicit tenantId when the row does not exist yet). For a demo tenant, an
// unknown instance or a path without an instance, nothing may reach the
// network. A normal tenant is the control: it reaches fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import {
  assertEvolutionInstanceCanCall,
  evolutionFetch,
  isEvolutionConnectionClosed,
  setEvolutionProxy,
} from "./evolution.server";
import { DemoTenantBlockedError } from "./demo-tenant";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const UNKNOWN_TENANT = "00000000-0000-4000-8000-00000000000f";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  fake.db
    .rows("tenants")
    .push({ id: NORMAL, status: "active", is_demo: false }, { id: DEMO, status: "active", is_demo: true });
  fake.db.rows("whatsapp_sessions").push(
    { id: "s-normal", instance_name: "inst-normal", tenant_id: NORMAL },
    { id: "s-demo", instance_name: "inst-demo", tenant_id: DEMO },
    { id: "s-orphan", instance_name: "inst-orphan", tenant_id: UNKNOWN_TENANT },
  );
  vi.stubEnv("EVOLUTION_API_URL", "https://evolution.example.com");
  vi.stubEnv("EVOLUTION_API_KEY", "evo-test-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchMock = vi.fn(async () => Response.json({ key: { id: "msg-1" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sendText = (instance: string) =>
  evolutionFetch(`/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    body: { number: "5511900000001", text: "Oi" },
  });

describe("evolutionFetch demo send guard", () => {
  it("blocks sendText on a demo tenant instance: DEMO_SEND_BLOCKED, no fetch", async () => {
    await expect(sendText("inst-demo")).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks an instance with no whatsapp_sessions row (fail-closed)", async () => {
    await expect(sendText("inst-desconhecida")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks an instance whose tenant does not exist (fail-closed)", async () => {
    await expect(sendText("inst-orphan")).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks /instance/connect on a demo instance (no QR, no real number)", async () => {
    await expect(evolutionFetch("/instance/connect/inst-demo")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["/message/sendMedia/inst-demo"],
    ["/message/sendWhatsAppAudio/inst-demo"],
    ["/instance/restart/inst-demo"],
    ["/instance/connectionState/inst-demo"],
    ["/instance/logout/inst-demo"],
    ["/instance/delete/inst-demo"],
    ["/webhook/set/inst-demo"],
    ["/websocket/set/inst-demo"],
    ["/chat/whatsappNumbers/inst-demo"],
    ["/instance/fetchInstances?instanceName=inst-demo"],
  ])("blocks %s on a demo instance", async (path) => {
    await expect(evolutionFetch(path, { method: "POST" })).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("blocks setEvolutionProxy on a demo instance", async () => {
    await expect(setEvolutionProxy("inst-demo", null)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("decodes the instance segment before looking it up", async () => {
    fake.db.rows("whatsapp_sessions").push({ id: "s-sp", instance_name: "demo casa", tenant_id: DEMO });
    await expect(sendText("demo casa")).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("lets a normal tenant instance reach fetch", async () => {
    const resp = await sendText("inst-normal");
    expect(resp).toEqual({ key: { id: "msg-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://evolution.example.com/message/sendText/inst-normal",
    );
  });

  it("propagates a whatsapp_sessions lookup error without calling fetch", async () => {
    fake.db.failNext("whatsapp_sessions", "select", "db down");
    await expect(sendText("inst-normal")).rejects.toThrow(/db down/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  describe("/instance/create (no row yet)", () => {
    const create = (tenantId?: string) =>
      evolutionFetch("/instance/create", {
        method: "POST",
        body: { instanceName: "inst-nova", qrcode: true, integration: "WHATSAPP-BAILEYS" },
        tenantId,
      });

    it("blocks without a tenantId (fail-closed)", async () => {
      await expect(create()).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it("blocks with a demo tenantId", async () => {
      await expect(create(DEMO)).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it("blocks with an unknown tenantId", async () => {
      await expect(create(UNKNOWN_TENANT)).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it("reaches fetch with a normal tenantId and does not send tenantId to Evolution", async () => {
      await create(NORMAL);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body).toEqual({ instanceName: "inst-nova", qrcode: true, integration: "WHATSAPP-BAILEYS" });
    });
  });

  it("keeps /instance/fetchInstances (no instance, super-admin diagnosis) exempt", async () => {
    fetchMock.mockImplementation(async () => Response.json([]));
    await expect(evolutionFetch("/instance/fetchInstances")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks any other path without an instance segment", async () => {
    await expect(evolutionFetch("/message/sendText")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("assertEvolutionInstanceCanCall (direct Evolution fetches)", () => {
  it("blocks demo / unknown / empty instances and allows a normal one", async () => {
    await expect(assertEvolutionInstanceCanCall("inst-demo")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    await expect(assertEvolutionInstanceCanCall("inst-desconhecida")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    await expect(assertEvolutionInstanceCanCall("")).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    await expect(assertEvolutionInstanceCanCall("inst-normal")).resolves.toBeUndefined();
  });
});

describe("isEvolutionConnectionClosed", () => {
  it("never classifies a demo block as a closed connection", () => {
    const err = new DemoTenantBlockedError("DEMO_SEND_BLOCKED") as Error & { rawBody?: string };
    err.rawBody = "Connection Closed";
    expect(isEvolutionConnectionClosed(err)).toBe(false);
  });
});
