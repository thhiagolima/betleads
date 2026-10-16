// F0-06 (SEC-13/SEC-29) and F0-09 (SEC-15) regression tests for the
// WhatsApp/Evolution server logic. No network: Evolution is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
vi.mock("./evolution.server", () => ({
  evolutionFetch: vi.fn(async () => ({})),
}));

import { evolutionFetch } from "./evolution.server";
import {
  configureEvolutionWebhookFor,
  deleteWhatsappSessionFor,
  diagnoseEvolutionFor,
  evolutionRealtimeConfigFor,
} from "./whatsapp-admin.server";
import { evolutionWebhookTarget } from "./whatsapp-evolution-auth.server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGACY = "00000000-0000-0000-0000-000000000001";
const SESSION_B = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "22222222-2222-4222-8222-222222222222";
const SECRET = "whsec-test-0123456789abcdef";
const GLOBAL_KEY = "evo-global-key-should-never-leak";

const evo = vi.mocked(evolutionFetch);
let tenantDb: ReturnType<typeof createFakeDb>;
const superAdmins = new Set(["super-user"]);

beforeEach(() => {
  fake.admin.reset();
  tenantDb = createFakeDb();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: superAdmins.has(String(args._user_id)),
    error: null,
  }));
  // Demo-action guard (Task 7): every tenant used below must resolve to a
  // known, non-demo row, or `assertTenantNotDemo` fails closed.
  fake.admin
    .rows("tenants")
    .push(
      { id: TENANT_A, status: "active", is_demo: false },
      { id: TENANT_B, status: "active", is_demo: false },
    );
  evo.mockReset();
  evo.mockResolvedValue([{ name: "casa-a", token: "instance-token" }]);
  vi.stubEnv("EVOLUTION_API_URL", "http://127.0.0.1:9");
  vi.stubEnv("EVOLUTION_API_KEY", GLOBAL_KEY);
  vi.stubEnv("EVOLUTION_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configureEvolutionWebhook (SEC-13)", () => {
  it("refuses a regular tenant member before touching Evolution", async () => {
    await expect(configureEvolutionWebhookFor("member-user", "casa-a")).rejects.toThrow(
      /plataforma/,
    );
    expect(evo).not.toHaveBeenCalled();
  });

  it("registers the secret as a header, never in the URL, and never returns it", async () => {
    fake.admin
      .rows("whatsapp_sessions")
      .push({ id: SESSION_A, tenant_id: TENANT_A, instance_name: "casa-a" });
    const res = await configureEvolutionWebhookFor("super-user", "casa-a");
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(GLOBAL_KEY);

    expect(evo).toHaveBeenCalledTimes(1);
    const [path, init] = evo.mock.calls[0] as unknown as [
      string,
      { body: { webhook: Record<string, unknown> } },
    ];
    expect(path).toBe("/webhook/set/casa-a");
    const hook = init.body.webhook;
    expect(hook.url).toBe("https://app.example.com/api/public/evolution-webhook");
    expect(hook.headers).toEqual({ "x-webhook-secret": SECRET });
    expect(JSON.stringify(init.body)).not.toContain("token=");
    expect(JSON.stringify(init.body)).not.toContain(GLOBAL_KEY);
  });

  it("does not fall back to EVOLUTION_API_KEY when the webhook secret is unset", async () => {
    fake.admin
      .rows("whatsapp_sessions")
      .push({ id: SESSION_A, tenant_id: TENANT_A, instance_name: "casa-a" });
    vi.stubEnv("EVOLUTION_WEBHOOK_SECRET", "");
    await expect(configureEvolutionWebhookFor("super-user", "casa-a")).rejects.toThrow(
      /EVOLUTION_WEBHOOK_SECRET/,
    );
    expect(evo).not.toHaveBeenCalled();
  });
});

describe("evolutionWebhookTarget (used on session creation)", () => {
  it("builds a header-authenticated target without token or global key", () => {
    const target = evolutionWebhookTarget(["MESSAGES_UPSERT"]);
    expect(target.url).toBe("https://app.example.com/api/public/evolution-webhook");
    expect(target.headers).toEqual({ "x-webhook-secret": SECRET });
    expect(JSON.stringify(target)).not.toContain(GLOBAL_KEY);
  });

  it("throws when the secret is missing instead of using EVOLUTION_API_KEY", () => {
    vi.stubEnv("EVOLUTION_WEBHOOK_SECRET", "");
    expect(() => evolutionWebhookTarget(["MESSAGES_UPSERT"])).toThrow(/EVOLUTION_WEBHOOK_SECRET/);
  });
});

describe("diagnoseEvolution / getEvolutionRealtimeConfig (SEC-13/SEC-29)", () => {
  it("refuses diagnoseEvolution to a regular member", async () => {
    await expect(diagnoseEvolutionFor("member-user")).rejects.toThrow(/plataforma/);
    expect(evo).not.toHaveBeenCalled();
  });

  it("never returns the raw instance list (instance tokens) even to the super admin", async () => {
    const res = await diagnoseEvolutionFor("super-user");
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain("instance-token");
    expect(JSON.stringify(res)).not.toContain(GLOBAL_KEY);
  });

  it("refuses getEvolutionRealtimeConfig to a regular member", async () => {
    await expect(evolutionRealtimeConfigFor("member-user")).rejects.toThrow(/plataforma/);
  });
});

describe("deleteWhatsappSession (SEC-15)", () => {
  function seedOtherTenantSession() {
    const admin = fake.admin;
    admin
      .rows("whatsapp_sessions")
      .push({ id: SESSION_B, tenant_id: TENANT_B, instance_name: "casa-b" });
    admin
      .rows("lead_whatsapp_assignments")
      .push({ id: "as-b", session_id: SESSION_B, tenant_id: TENANT_B });
    admin
      .rows("whatsapp_messages")
      .push({ id: "msg-b", session_id: SESSION_B, tenant_id: TENANT_B });
    admin.rows("whatsapp_chats").push({ id: "chat-b", session_id: SESSION_B, tenant_id: TENANT_B });
  }

  it("refuses to force-delete a session the caller cannot read (other tenant)", async () => {
    seedOtherTenantSession();
    // Tenant A's RLS view (tenantDb) does not contain SESSION_B.
    await expect(
      deleteWhatsappSessionFor(tenantDb.client, { id: SESSION_B, force: true }),
    ).rejects.toThrow(/não encontrada/i);

    expect(fake.admin.rows("lead_whatsapp_assignments")).toHaveLength(1);
    expect(fake.admin.rows("whatsapp_messages")).toHaveLength(1);
    expect(fake.admin.rows("whatsapp_chats")).toHaveLength(1);
    expect(evo).not.toHaveBeenCalled();
  });

  it("refuses the non-force path too when the session is not visible", async () => {
    seedOtherTenantSession();
    await expect(deleteWhatsappSessionFor(tenantDb.client, { id: SESSION_B })).rejects.toThrow(
      /não encontrada/i,
    );
    expect(evo).not.toHaveBeenCalled();
  });

  it("force-deletes only rows of the caller's tenant (plus legacy rows) for its own session", async () => {
    tenantDb
      .rows("whatsapp_sessions")
      .push({ id: SESSION_A, tenant_id: TENANT_A, instance_name: "casa-a" });
    const admin = fake.admin;
    admin
      .rows("lead_whatsapp_assignments")
      .push(
        { id: "as-a", session_id: SESSION_A, tenant_id: TENANT_A },
        { id: "as-legacy", session_id: SESSION_A, tenant_id: LEGACY },
        { id: "as-foreign", session_id: SESSION_A, tenant_id: TENANT_B },
      );
    admin
      .rows("whatsapp_messages")
      .push(
        { id: "m-a", session_id: SESSION_A, tenant_id: TENANT_A },
        { id: "m-foreign", session_id: SESSION_A, tenant_id: TENANT_B },
      );
    admin
      .rows("whatsapp_chats")
      .push(
        { id: "c-a", session_id: SESSION_A, tenant_id: TENANT_A },
        { id: "c-foreign", session_id: SESSION_A, tenant_id: TENANT_B },
      );

    await deleteWhatsappSessionFor(tenantDb.client, { id: SESSION_A, force: true });

    expect(admin.rows("lead_whatsapp_assignments").map((r) => r.id)).toEqual(["as-foreign"]);
    expect(admin.rows("whatsapp_messages").map((r) => r.id)).toEqual(["m-foreign"]);
    expect(admin.rows("whatsapp_chats").map((r) => r.id)).toEqual(["c-foreign"]);
    expect(tenantDb.rows("whatsapp_sessions")).toHaveLength(0);
    expect(evo).toHaveBeenCalledWith("/instance/delete/casa-a", { method: "DELETE" });
  });
});
