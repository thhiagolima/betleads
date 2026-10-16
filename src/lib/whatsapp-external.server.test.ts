// F0-07 (SEC-12 / DEV-70): external WhatsApp integration webhook — role
// required, SSRF guard, no redirects, response body never persisted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  dns: new Map<string, string[]>(),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const addrs = fake.dns.get(host) ?? ["93.184.216.34"];
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));

import {
  loadManagedExternalIntegration,
  saveExternalIntegrationFor,
  sendExternalTriggerEvent,
  type ExternalIntegration,
} from "./whatsapp-external.server";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let userDb: ReturnType<typeof createFakeDb>;
const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const validInput = {
  url: "https://hooks.example.com/betleads",
  active: true,
  triggers: ["recuperacao_vip"],
};

function integration(url: string): ExternalIntegration {
  return {
    id: "int-1",
    tenant_id: TENANT,
    url,
    active: true,
    triggers: [],
    disable_internal: true,
  };
}

const lead = { id: null, telefone: "5511999999999", nome: "Lead" };

beforeEach(() => {
  fake.admin.reset();
  fake.dns.clear();
  // A regular (non-demo) tenant, so the demo send guard lets the webhook out.
  fake.admin.rows("tenants").push({ id: TENANT, status: "active", is_demo: false });
  userDb = createFakeDb();
  userDb.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === "super-user",
    error: null,
  }));
  fake.admin
    .rows("user_roles")
    .push(
      { user_id: "admin-user", tenant_id: TENANT, role: "admin" },
      { user_id: "gestor-user", tenant_id: TENANT, role: "gestor" },
      { user_id: "member-user", tenant_id: TENANT, role: "member" },
      { user_id: "foreign-admin", tenant_id: OTHER_TENANT, role: "admin" },
    );
  fetchMock = vi.fn(async () => new Response("echo: lead pii", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("saveExternalIntegrationFor — roles", () => {
  it.each(["member-user", "foreign-admin", "nobody"])("refuses %s", async (user) => {
    await expect(saveExternalIntegrationFor(userDb.client, user, validInput)).rejects.toThrow(
      /administradores|gestores/i,
    );
    expect(userDb.rows("whatsapp_external_integrations")).toHaveLength(0);
  });

  it.each(["admin-user", "gestor-user", "super-user"])("allows %s", async (user) => {
    const res = await saveExternalIntegrationFor(userDb.client, user, validInput);
    expect(res.integration).toMatchObject({ tenant_id: TENANT, url: validInput.url });
  });
});

describe("saveExternalIntegrationFor — SSRF guard", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/hook",
    "https://localhost/hook",
    "http://hooks.example.com/plain-http",
    "https://127.0.0.1/hook",
    "https://2130706433/hook",
    "https://[::ffff:169.254.169.254]/x",
  ])("refuses %s", async (url) => {
    await expect(
      saveExternalIntegrationFor(userDb.client, "admin-user", { ...validInput, url }),
    ).rejects.toThrow();
    expect(userDb.rows("whatsapp_external_integrations")).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    fake.dns.set("rebind.example.com", ["10.1.2.3"]);
    await expect(
      saveExternalIntegrationFor(userDb.client, "admin-user", {
        ...validInput,
        url: "https://rebind.example.com/hook",
      }),
    ).rejects.toThrow(/interno|reservado/);
  });
});

describe("loadManagedExternalIntegration (test / send-all)", () => {
  it("refuses a regular member", async () => {
    userDb.rows("whatsapp_external_integrations").push({ ...integration(validInput.url) });
    await expect(loadManagedExternalIntegration(userDb.client, "member-user")).rejects.toThrow(
      /administradores|gestores/i,
    );
  });

  it("returns the tenant's integration for an admin", async () => {
    userDb.rows("whatsapp_external_integrations").push({ ...integration(validInput.url) });
    const row = await loadManagedExternalIntegration(userDb.client, "admin-user");
    expect(row.url).toBe(validInput.url);
  });
});

describe("sendExternalTriggerEvent — outbound request", () => {
  it("never contacts an internal destination stored before the fix", async () => {
    const res = await sendExternalTriggerEvent({
      integration: integration("http://169.254.169.254/latest/meta-data/"),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    expect(res.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const [event] = fake.admin.rows("whatsapp_external_events");
    expect(event.status).toBe("failed");
    expect(event.response_body ?? null).toBeNull();
  });

  it("does not persist the response body and disables redirects", async () => {
    const res = await sendExternalTriggerEvent({
      integration: integration(validInput.url),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    expect(res.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const [event] = fake.admin.rows("whatsapp_external_events");
    expect(event.status).toBe("sent");
    expect(event.http_status).toBe(200);
    expect(event.response_body ?? null).toBeNull();
    expect(JSON.stringify(event)).not.toContain("echo: lead pii");
  });

  it("treats a redirect as a failure without following it", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    const res = await sendExternalTriggerEvent({
      integration: integration(validInput.url),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    expect(res.sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [event] = fake.admin.rows("whatsapp_external_events");
    expect(event.http_status).toBe(302);
    expect(String(event.error)).toMatch(/redirect/i);
  });

  it("keeps stored error messages short", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("x".repeat(5000));
    });
    vi.useFakeTimers();
    const pending = sendExternalTriggerEvent({
      integration: integration(validInput.url),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();
    const [event] = fake.admin.rows("whatsapp_external_events");
    expect(String(event.error).length).toBeLessThanOrEqual(200);
  });
});
