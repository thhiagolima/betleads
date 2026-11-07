import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  (fake.admin.client as unknown as { auth: unknown }).auth = {
    admin: { getUserById: vi.fn() },
  };
  return { supabaseAdmin: fake.admin.client };
});

const { sendPlatformEmail } = vi.hoisted(() => ({ sendPlatformEmail: vi.fn() }));
vi.mock("@/lib/billing/billing-emails.server", () => ({ sendPlatformEmail }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import type { StoredAlert } from "./alert-lifecycle";
import {
  criticalAlertEmail,
  listSuperAdminEmails,
  notifyCriticalAlerts,
} from "./alert-email.server";

const SUPER_1 = "00000000-0000-4000-8000-000000000001";
const SUPER_2 = "00000000-0000-4000-8000-000000000002";
const SUPER_BROKEN = "00000000-0000-4000-8000-000000000009";
const HOUSE_ADMIN = "00000000-0000-4000-8000-000000000003";
const SCOPED_SUPER = "00000000-0000-4000-8000-000000000004";
const HOUSE_A = "00000000-0000-4000-8000-0000000000a1";

const NOW = new Date("2026-11-05T15:00:00.000Z");

type GetUserById = {
  mockImplementation: (fn: (id: string) => unknown) => void;
};

function getUserById(): GetUserById {
  return (fake.admin.client as unknown as { auth: { admin: { getUserById: GetUserById } } }).auth
    .admin.getUserById;
}

function stored(key: string, overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: `id-${key}`,
    alertKey: key,
    kind: "job",
    severity: "critical",
    message: `Mensagem de ${key}`,
    tenantId: null,
    href: "/admin#saude",
    openedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    seenCount: 1,
    acknowledgedAt: null,
    silencedUntil: null,
    lastNotifiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin
    .rows("user_roles")
    .push(
      { user_id: SUPER_1, tenant_id: null, role: "super_admin" },
      { user_id: SUPER_2, tenant_id: null, role: "super_admin" },
      { user_id: SUPER_BROKEN, tenant_id: null, role: "super_admin" },
      { user_id: HOUSE_ADMIN, tenant_id: HOUSE_A, role: "admin" },
      { user_id: SCOPED_SUPER, tenant_id: HOUSE_A, role: "super_admin" },
    );
  getUserById().mockImplementation((id: string) => {
    if (id === SUPER_BROKEN) return { data: null, error: { message: "user not found" } };
    const emails: Record<string, string> = {
      [SUPER_1]: "root1@betleads.io",
      // Same address on two accounts: e-mailed once.
      [SUPER_2]: "root1@betleads.io",
      [HOUSE_ADMIN]: "admin@casa-a.com",
      [SCOPED_SUPER]: "scoped@casa-a.com",
    };
    return { data: { user: { email: emails[id] ?? null } }, error: null };
  });
  sendPlatformEmail.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("listSuperAdminEmails", () => {
  it("returns distinct e-mails of global super admins only, skipping unresolvable users", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await listSuperAdminEmails()).toEqual(["root1@betleads.io"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("criticalAlertEmail", () => {
  it("lists every alert, escapes HTML and links to the Saúde tab", () => {
    const { subject, html } = criticalAlertEmail([
      stored("job:a", { message: "Robô <script>x</script> parado" }),
      stored("provider:sms", { message: "Disjuntor SMS aberto", seenCount: 3 }),
    ]);

    expect(subject).toBe("2 alertas críticos na plataforma BetLeads");
    expect(html).toContain("Robô &lt;script&gt;x&lt;/script&gt; parado");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Disjuntor SMS aberto");
    expect(html).toContain('href="https://betleads.io/admin#saude"');
  });

  it("uses the singular for one alert", () => {
    expect(criticalAlertEmail([stored("job:a")]).subject).toBe(
      "1 alerta crítico na plataforma BetLeads",
    );
  });
});

describe("notifyCriticalAlerts", () => {
  // Recipients are resolved by the caller (alert-store.server.ts) before it claims.
  const RECIPIENTS = ["root1@betleads.io", "root2@betleads.io"];

  it("sends nothing to an empty recipient list", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    expect(await notifyCriticalAlerts([stored("job:a")], NOW, [])).toBe(0);
    expect(sendPlatformEmail).not.toHaveBeenCalled();
  });

  it("is a no-op unless PLATFORM_ALERTS_EMAIL_ENABLED is exactly 'true'", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "1");
    expect(await notifyCriticalAlerts([stored("job:a")], NOW, RECIPIENTS)).toBe(0);
    expect(sendPlatformEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty list", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    expect(await notifyCriticalAlerts([], NOW, RECIPIENTS)).toBe(0);
    expect(sendPlatformEmail).not.toHaveBeenCalled();
  });

  it("sends one e-mail per super admin and counts only accepted sends", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendPlatformEmail
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const sent = await notifyCriticalAlerts([stored("job:a"), stored("job:b")], NOW, RECIPIENTS);

    expect(sent).toBe(1);
    expect(sendPlatformEmail).toHaveBeenCalledTimes(2);
    const keys = sendPlatformEmail.mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(sendPlatformEmail.mock.calls[0][0]).toMatchObject({
      to: "root1@betleads.io",
      subject: "2 alertas críticos na plataforma BetLeads",
    });
  });

  it("a throwing send is logged and does not stop the other recipients", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendPlatformEmail
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    expect(await notifyCriticalAlerts([stored("job:a")], NOW, RECIPIENTS)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
