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
import {
  connectWhatsappSessionFor,
  createWhatsappSessionFor,
  refreshContactNamesFor,
  refreshGroupNamesFor,
  sendToLeadFromSessionFor,
  syncWhatsappSessionsFor,
} from "./whatsapp.functions";

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
    { id: "s-normal", instance_name: "inst-normal", tenant_id: NORMAL, name: "Normal", status: "connected" },
    { id: "s-demo", instance_name: "inst-demo", tenant_id: DEMO, name: "Demo", status: "connected" },
    {
      id: "s-orphan",
      instance_name: "inst-orphan",
      tenant_id: UNKNOWN_TENANT,
      name: "Orfa",
      status: "connected",
    },
  );
  vi.stubEnv("EVOLUTION_API_URL", "https://evolution.example.com");
  vi.stubEnv("EVOLUTION_API_KEY", "evo-test-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

describe("evolutionFetch path hardening", () => {
  it.each([
    ["/message/sendText/inst-demo?instanceName=inst-normal"],
    ["/message/sendText/inst-normal/../inst-demo"],
    ["/message/sendText/inst-normal/%2e%2e/inst-demo"],
    ["/message/sendText/inst-normal/%2E%2E/inst-demo"],
    ["/message/sendText/inst-normal/.%2e/inst-demo"],
    ["/message/sendText/./inst-normal"],
    ["/message/sendText/inst-normal/extra"],
    ["/message/sendText/inst-normal%2F..%2Finst-demo"],
    ["/message/sendText/inst-normal%5C..%5Cinst-demo"],
    ["/message/sendText/inst-normal\\..\\inst-demo"],
    ["/message//sendText/inst-normal"],
    ["/message/sendText/inst-normal#frag"],
    ["/instance/create/inst-normal"],
    ["/instance/fetchInstances/inst-normal"],
    ["/instance/fetchInstances?instanceName=inst-normal&instanceName=inst-demo"],
    ["message/sendText/inst-normal"],
  ])("blocks %s without calling fetch", async (path) => {
    await expect(evolutionFetch(path, { method: "POST", tenantId: NORMAL })).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    await expect(evolutionFetch(path, { method: "POST" })).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("still allows /instance/fetchInstances?instanceName= for a normal instance", async () => {
    await evolutionFetch("/instance/fetchInstances?instanceName=inst-normal");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("evolutionFetch init.tenantId override", () => {
  it("blocks a normal tenant targeting a demo tenant's existing instance", async () => {
    await expect(
      evolutionFetch("/message/sendText/inst-demo", { method: "POST", tenantId: NORMAL }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    await expect(
      evolutionFetch("/instance/create", {
        method: "POST",
        body: { instanceName: "inst-demo" },
        tenantId: NORMAL,
      }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("allows a tenant targeting its own existing instance", async () => {
    await evolutionFetch("/message/sendText/inst-normal", { method: "POST", tenantId: NORMAL });
    await evolutionFetch("/instance/create", {
      method: "POST",
      body: { instanceName: "inst-normal" },
      tenantId: NORMAL,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checks the tenant on the bare listing when one is given", async () => {
    await expect(evolutionFetch("/instance/fetchInstances", { tenantId: DEMO })).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await evolutionFetch("/instance/fetchInstances", { tenantId: NORMAL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("whatsapp.functions demo-block wiring", () => {
  const ctx = () => ({ supabase: fake.db.client });
  const asCaller = (tenantId: string) =>
    fake.db.onRpc("current_tenant_id", () => ({ data: tenantId, error: null }));
  const calledUrls = () => fetchMock.mock.calls.map((call) => String(call[0]));
  const row = (table: string, id: string) => fake.db.rows(table).find((r) => r.id === id);

  it("createWhatsappSession: a demo caller gets the block itself, nothing is created", async () => {
    asCaller(DEMO);
    const error = await createWhatsappSessionFor({ name: "Nova", instance_name: "inst-nova" }, ctx()).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(DemoTenantBlockedError);
    expect(error.message).not.toMatch(/Evolution recusou/);
    expect(fake.db.rows("whatsapp_sessions").map((r) => r.instance_name)).not.toContain("inst-nova");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("createWhatsappSession: a normal caller reaches /instance/create", async () => {
    asCaller(NORMAL);
    await createWhatsappSessionFor({ name: "Nova", instance_name: "inst-nova" }, ctx());
    expect(calledUrls()[0]).toBe("https://evolution.example.com/instance/create");
  });

  it("sendToLeadFromSession: number resolution propagates the block (no chat row)", async () => {
    const error = await sendToLeadFromSessionFor(
      { session_id: "s-demo", phone: "5511900000001", text: "Oi" },
      ctx(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DemoTenantBlockedError);
    expect(fake.db.rows("whatsapp_chats")).toEqual([]);
    expect(fake.db.rows("whatsapp_messages")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // Not mistaken for a dropped session either.
    expect(row("whatsapp_sessions", "s-demo")?.status).toBe("connected");
  });

  it("connectWhatsappSession: the proxy catch rethrows the block (no proxy log, no QR)", async () => {
    fake.db.rows("whatsapp_proxies").push({
      id: "px-1",
      protocol: "http",
      host: "proxy.example.com",
      port: 8080,
      username: null,
      password_encrypted: null,
      status: "active",
    });
    const session = row("whatsapp_sessions", "s-demo")!;
    session.proxy_id = "px-1";
    session.status = "disconnected";
    const error = await connectWhatsappSessionFor({ id: "s-demo" }, ctx()).catch((e) => e);
    expect(error).toBeInstanceOf(DemoTenantBlockedError);
    expect(fake.db.rows("whatsapp_proxy_logs")).toEqual([]);
    expect(session.status).toBe("disconnected");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("connectWhatsappSession without proxy: blocked before any QR call", async () => {
    const error = await connectWhatsappSessionFor({ id: "s-demo" }, ctx()).catch((e) => e);
    expect(error).toBeInstanceOf(DemoTenantBlockedError);
    expect(row("whatsapp_sessions", "s-demo")?.status).toBe("connected");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("syncWhatsappSessions: a demo caller never reaches the bare listing", async () => {
    asCaller(DEMO);
    await expect(syncWhatsappSessionsFor(ctx())).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("syncWhatsappSessions: a normal caller lists and probes only allowed instances", async () => {
    asCaller(NORMAL);
    fetchMock.mockImplementation(async () => Response.json([]));
    await syncWhatsappSessionsFor(ctx());
    expect(calledUrls()).toEqual([
      "https://evolution.example.com/instance/fetchInstances",
      "https://evolution.example.com/instance/connectionState/inst-normal",
    ]);
  });

  describe("name refresh across tenants (a super admin sees every session)", () => {
    beforeEach(() => {
      // Demo and orphan sessions come BEFORE the normal one.
      const sessions = fake.db.rows("whatsapp_sessions");
      const normal = sessions.splice(
        sessions.findIndex((r) => r.id === "s-normal"),
        1,
      );
      sessions.push(...normal);
      const chat = (id: string, sessionId: string, jid: string, isGroup: boolean) => ({
        id,
        session_id: sessionId,
        remote_jid: jid,
        phone: jid.split("@")[0],
        name: jid.split("@")[0],
        is_group: isGroup,
        profile_pic_url: "https://pic.example.com/p.png",
      });
      fake.db
        .rows("whatsapp_chats")
        .push(
          chat("g-demo", "s-demo", "111@g.us", true),
          chat("g-normal", "s-normal", "222@g.us", true),
          chat("c-demo", "s-demo", "5511900000001@s.whatsapp.net", false),
          chat("c-normal", "s-normal", "5511900000002@s.whatsapp.net", false),
        );
      fetchMock.mockImplementation(async () =>
        Response.json({ subject: "Grupo Real", data: [{ name: "Fulano" }] }),
      );
    });

    it("refreshGroupNames skips demo/orphan sessions and still refreshes the normal one", async () => {
      await expect(refreshGroupNamesFor(ctx())).resolves.toEqual({ updated: 1, skipped: 2 });
      expect(fetchMock).toHaveBeenCalled();
      expect(calledUrls().every((u) => u.includes("/inst-normal"))).toBe(true);
      expect(row("whatsapp_chats", "g-normal")?.name).toBe("Grupo Real");
      expect(row("whatsapp_chats", "g-demo")?.name).toBe("111");
    });

    it("refreshContactNames skips demo/orphan sessions and still refreshes the normal one", async () => {
      await expect(refreshContactNamesFor(ctx())).resolves.toEqual({ updated: 1, skipped: 2 });
      expect(fetchMock).toHaveBeenCalled();
      expect(calledUrls().every((u) => u.includes("/inst-normal"))).toBe(true);
      expect(row("whatsapp_chats", "c-normal")?.name).toBe("Fulano");
      expect(row("whatsapp_chats", "c-demo")?.name).toBe("5511900000001");
    });

    it("throws DEMO_SEND_BLOCKED when every session is blocked", async () => {
      const sessions = fake.db.rows("whatsapp_sessions");
      sessions.splice(
        sessions.findIndex((r) => r.id === "s-normal"),
        1,
      );
      await expect(refreshGroupNamesFor(ctx())).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
      await expect(refreshContactNamesFor(ctx())).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });
  });
});
