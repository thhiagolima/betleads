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

const { callInfobipEmail } = vi.hoisted(() => ({ callInfobipEmail: vi.fn() }));
vi.mock("../infobip-email.server", () => ({ callInfobipEmail }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  isWithinBillingEmailWindow,
  platformEmailFrom,
  sendBillingEmail,
  sendPendingBillingEmails,
  sendPlatformEmail,
} from "./billing-emails.server";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ADMIN_USER = "00000000-0000-4000-8000-000000000001";
const OWNER_USER = "00000000-0000-4000-8000-000000000002";
const GESTOR_USER = "00000000-0000-4000-8000-000000000003";
const MEMBER_USER = "00000000-0000-4000-8000-000000000004";

type UserByIdMock = { mockImplementation: (fn: (id: string) => unknown) => void };

function getUserByIdMock(): UserByIdMock {
  return (fake.admin.client as unknown as { auth: { admin: { getUserById: UserByIdMock } } }).auth
    .admin.getUserById as unknown as UserByIdMock;
}

const EMAIL_BY_USER: Record<string, string> = {
  [ADMIN_USER]: "admin@casa.com",
  [OWNER_USER]: "owner@casa.com",
  [GESTOR_USER]: "gestor@casa.com",
  [MEMBER_USER]: "member@casa.com",
};

function seedRolesAndUsers() {
  fake.admin.rows("user_roles").push(
    { user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" },
    { user_id: OWNER_USER, tenant_id: TENANT, role: "owner" },
    { user_id: GESTOR_USER, tenant_id: TENANT, role: "gestor" },
    { user_id: MEMBER_USER, tenant_id: TENANT, role: "member" },
  );
  (getUserByIdMock() as unknown as { mockImplementation: (fn: (id: string) => unknown) => void })
    .mockImplementation((id: string) => ({
      data: { user: { email: EMAIL_BY_USER[id] ?? null } },
      error: null,
    }));
}

function seedTenant(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Teste", is_demo: false, ...overrides });
}

function seedInvoice(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "invoice-1",
    tenant_id: TENANT,
    due_date: "2026-10-25",
    amount_cents: 400000,
    status: "open",
    paid_at: null,
    ...overrides,
  };
  fake.admin.rows("billing_invoices").push(row);
  return row;
}

// 12:00 BRT, well inside the 08:00-20:00 window.
const INSIDE_WINDOW = new Date("2026-10-22T15:00:00.000Z");
// 21:00 BRT, outside the window.
const OUTSIDE_WINDOW = new Date("2026-10-23T00:00:00.000Z");

beforeEach(() => {
  fake.admin.reset();
  getUserByIdMock().mockImplementation(() => ({ data: { user: { email: null } }, error: null }));
  callInfobipEmail.mockReset();
  callInfobipEmail.mockResolvedValue({ ok: true, status: 200, body: {}, idempotencyKey: "k" });
  process.env.BILLING_INVOICES_ENABLED = "true";
});

afterEach(() => {
  delete process.env.BILLING_INVOICES_ENABLED;
  delete process.env.BILLING_ENFORCEMENT_ENABLED;
  delete process.env.PLATFORM_EMAIL_FROM;
  vi.restoreAllMocks();
});

describe("isWithinBillingEmailWindow", () => {
  it("is true at noon Brasília and false at 21:00 Brasília", () => {
    expect(isWithinBillingEmailWindow(INSIDE_WINDOW)).toBe(true);
    expect(isWithinBillingEmailWindow(OUTSIDE_WINDOW)).toBe(false);
  });
});

describe("platformEmailFrom / sendPlatformEmail", () => {
  it("defaults to no-reply@betleads.io when PLATFORM_EMAIL_FROM is not set", () => {
    expect(platformEmailFrom()).toBe("no-reply@betleads.io");
  });

  it("uses PLATFORM_EMAIL_FROM when set", () => {
    process.env.PLATFORM_EMAIL_FROM = "cobranca@betleads.io";
    expect(platformEmailFrom()).toBe("cobranca@betleads.io");
  });

  it("calls callInfobipEmail with the platform sender, name BetLeads, never a tenantId", async () => {
    await sendPlatformEmail({ to: "x@y.com", subject: "s", html: "<p>h</p>" });
    expect(callInfobipEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "x@y.com",
        from: "no-reply@betleads.io",
        fromName: "BetLeads",
        subject: "s",
        html: "<p>h</p>",
      }),
    );
    const call = callInfobipEmail.mock.calls[0][0];
    expect(call).not.toHaveProperty("tenantId");
  });
});

describe("sendBillingEmail", () => {
  it("sends to admin, owner and gestor, never to member", async () => {
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    expect(result).toEqual({ sent: true, recipients: 3 });
    expect(callInfobipEmail).toHaveBeenCalledTimes(3);
    const sentTo = callInfobipEmail.mock.calls.map((c) => c[0].to);
    expect(sentTo.sort()).toEqual(["admin@casa.com", "gestor@casa.com", "owner@casa.com"]);
    expect(sentTo).not.toContain("member@casa.com");
  });

  it("uses a per-recipient idempotencyKey (billing:<id>:<kind>:<n>)", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push(
      { user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" },
      { user_id: OWNER_USER, tenant_id: TENANT, role: "owner" },
    );
    getUserByIdMock().mockImplementation((id: string) => ({
      data: { user: { email: EMAIL_BY_USER[id] ?? null } },
      error: null,
    }));

    await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    const keys = callInfobipEmail.mock.calls.map((c) => c[0].idempotencyKey).sort();
    expect(keys).toEqual(["billing:invoice-1:issued:0", "billing:invoice-1:issued:1"]);
  });

  it("a force resend's row survives the rollback of a concurrent unforced call whose send failed", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));

    const forceSentAt = new Date(INSIDE_WINDOW.getTime() + 1000).toISOString();
    let firstCall = true;
    callInfobipEmail.mockImplementation(async (input: { idempotencyKey?: string }) => {
      if (firstCall) {
        firstCall = false;
        // Simulate a superadmin force-resend landing in between this call's
        // log insert and its (about to fail) send: it overwrites the same
        // (invoice_id, kind) row with a later sent_at and succeeds.
        callInfobipEmail.mockImplementationOnce(async () => ({
          ok: true,
          status: 200,
          body: {},
          idempotencyKey: "force",
        }));
        await sendBillingEmail("invoice-1", "issued", {
          force: true,
          now: new Date(forceSentAt),
        });
        return { ok: false, status: 500, body: {}, idempotencyKey: input.idempotencyKey ?? "k" };
      }
      return { ok: true, status: 200, body: {}, idempotencyKey: input.idempotencyKey ?? "k" };
    });

    const result = await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    // This call's own send failed...
    expect(result.sent).toBe(false);
    // ...but the concurrent force-resend's row (a different sent_at) must
    // survive this call's rollback, which is scoped to its OWN sent_at.
    const rows = fake.admin.rows("billing_email_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoice_id: "invoice-1", kind: "issued", sent_at: forceSentAt });
  });

  it("does nothing at 21:00 Brasília (outside the window), without force", async () => {
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendBillingEmail("invoice-1", "issued", { now: OUTSIDE_WINDOW });

    expect(result).toEqual({ sent: false, recipients: 0 });
    expect(callInfobipEmail).not.toHaveBeenCalled();
    expect(fake.admin.rows("billing_email_log")).toHaveLength(0);
  });

  it("two concurrent calls send once; a conflicting second insert never sends", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));

    const [a, b] = await Promise.all([
      sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW }),
      sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW }),
    ]);

    const sentResults = [a, b].filter((r) => r.sent);
    expect(sentResults).toHaveLength(1);
    expect(callInfobipEmail).toHaveBeenCalledTimes(1);
    expect(fake.admin.rows("billing_email_log")).toHaveLength(1);
  });

  it("force resends even when a log row already exists", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));

    const first = await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });
    expect(first.sent).toBe(true);

    const second = await sendBillingEmail("invoice-1", "issued", { force: true });
    expect(second.sent).toBe(true);
    expect(callInfobipEmail).toHaveBeenCalledTimes(2);
    expect(fake.admin.rows("billing_email_log")).toHaveLength(1);
  });

  it("never sends 'locked' without enforcement, even with force, and writes no log", async () => {
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();
    delete process.env.BILLING_ENFORCEMENT_ENABLED;

    const result = await sendBillingEmail("invoice-1", "locked", { force: true });

    expect(result).toEqual({ sent: false, recipients: 0 });
    expect(callInfobipEmail).not.toHaveBeenCalled();
    expect(fake.admin.rows("billing_email_log")).toHaveLength(0);
  });

  it("sends 'locked' with enforcement on", async () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendBillingEmail("invoice-1", "locked", { now: INSIDE_WINDOW });

    expect(result).toEqual({ sent: true, recipients: 3 });
  });

  it("never e-mails a demo house, but still writes the log with recipients = 0", async () => {
    seedTenant({ is_demo: true });
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    expect(result).toEqual({ sent: true, recipients: 0 });
    expect(callInfobipEmail).not.toHaveBeenCalled();
    expect(fake.admin.rows("billing_email_log")[0]).toMatchObject({
      invoice_id: "invoice-1",
      kind: "issued",
      recipients: 0,
    });
  });

  it("returns sent:false for an invoice that does not exist", async () => {
    const result = await sendBillingEmail("does-not-exist", "issued", { now: INSIDE_WINDOW });
    expect(result).toEqual({ sent: false, recipients: 0 });
  });

  it("deletes the log row and allows a retry when every recipient send fails", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));
    callInfobipEmail.mockResolvedValue({ ok: false, status: 500, body: {}, idempotencyKey: "k" });

    const result = await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    expect(result).toEqual({ sent: false, recipients: 1 });
    expect(fake.admin.rows("billing_email_log")).toHaveLength(0);
  });

  it("uses exact subjects per kind", async () => {
    seedTenant();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));

    seedInvoice({ id: "inv-issued", due_date: "2026-11-05" });
    await sendBillingEmail("inv-issued", "issued", { now: INSIDE_WINDOW });
    expect(callInfobipEmail.mock.calls.at(-1)?.[0].subject).toBe(
      "Sua mensalidade BetLeads vence em 05/11",
    );

    seedInvoice({ id: "inv-due", due_date: "2026-10-22" });
    await sendBillingEmail("inv-due", "due_today", { now: INSIDE_WINDOW });
    expect(callInfobipEmail.mock.calls.at(-1)?.[0].subject).toBe(
      "Sua mensalidade BetLeads vence hoje",
    );

    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    seedInvoice({ id: "inv-locked" });
    await sendBillingEmail("inv-locked", "locked", { now: INSIDE_WINDOW });
    expect(callInfobipEmail.mock.calls.at(-1)?.[0].subject).toBe(
      "Acesso ao CRM suspenso por falta de pagamento",
    );

    seedInvoice({ id: "inv-paid", status: "paid", paid_at: INSIDE_WINDOW.toISOString() });
    await sendBillingEmail("inv-paid", "paid", { now: INSIDE_WINDOW });
    expect(callInfobipEmail.mock.calls.at(-1)?.[0].subject).toBe("Pagamento confirmado — obrigado!");
  });

  it("the e-mail body links to the Plano e créditos button", async () => {
    seedTenant();
    seedInvoice();
    fake.admin.rows("user_roles").push({ user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" });
    getUserByIdMock().mockImplementation(() => ({
      data: { user: { email: "admin@casa.com" } },
      error: null,
    }));

    await sendBillingEmail("invoice-1", "issued", { now: INSIDE_WINDOW });

    const html = callInfobipEmail.mock.calls.at(-1)?.[0].html as string;
    expect(html).toContain("https://betleads.io/plano-e-creditos");
    expect(html).toContain("Abrir Plano e créditos");
  });
});

describe("sendPendingBillingEmails", () => {
  it("returns 0 and touches nothing when BILLING_INVOICES_ENABLED is off", async () => {
    delete process.env.BILLING_INVOICES_ENABLED;
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendPendingBillingEmails({ now: INSIDE_WINDOW });

    expect(result).toBe(0);
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("returns 0 at 21:00 Brasília, even with the flag on", async () => {
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendPendingBillingEmails({ now: OUTSIDE_WINDOW });

    expect(result).toBe(0);
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("sends issued for every open invoice without a log, once", async () => {
    seedTenant();
    seedInvoice();
    seedRolesAndUsers();

    const result = await sendPendingBillingEmails({ now: INSIDE_WINDOW });

    expect(result).toBe(1);
    expect(fake.admin.rows("billing_email_log")).toEqual([
      expect.objectContaining({ invoice_id: "invoice-1", kind: "issued", recipients: 3 }),
    ]);

    callInfobipEmail.mockClear();
    const again = await sendPendingBillingEmails({ now: INSIDE_WINDOW });
    expect(again).toBe(0);
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("sends due_today only for invoices due exactly today", async () => {
    seedTenant();
    seedInvoice({ id: "due-today", due_date: "2026-10-22" });
    seedInvoice({ id: "due-later", due_date: "2026-10-25" });
    seedRolesAndUsers();
    // Already-sent 'issued' for both so only due_today is counted.
    fake.admin
      .rows("billing_email_log")
      .push(
        { invoice_id: "due-today", kind: "issued", recipients: 3, sent_at: new Date().toISOString() },
        { invoice_id: "due-later", kind: "issued", recipients: 3, sent_at: new Date().toISOString() },
      );

    const result = await sendPendingBillingEmails({ now: INSIDE_WINDOW });

    expect(result).toBe(1);
    const dueTodayLogs = fake.admin
      .rows("billing_email_log")
      .filter((r) => r.kind === "due_today");
    expect(dueTodayLogs).toEqual([
      expect.objectContaining({ invoice_id: "due-today", kind: "due_today" }),
    ]);
  });

  it("never sends 'locked' without enforcement, but does with it", async () => {
    seedTenant();
    fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "locked_unpaid" });
    seedInvoice({ id: "locked-inv" });
    seedRolesAndUsers();
    fake.admin
      .rows("billing_email_log")
      .push({ invoice_id: "locked-inv", kind: "issued", recipients: 3, sent_at: new Date().toISOString() });

    const withoutEnforcement = await sendPendingBillingEmails({ now: INSIDE_WINDOW });
    expect(withoutEnforcement).toBe(0);
    expect(fake.admin.rows("billing_email_log").filter((r) => r.kind === "locked")).toHaveLength(0);

    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    const withEnforcement = await sendPendingBillingEmails({ now: INSIDE_WINDOW });
    expect(withEnforcement).toBe(1);
    expect(fake.admin.rows("billing_email_log").filter((r) => r.kind === "locked")).toHaveLength(1);
  });

  it("sends paid for invoices paid within the last 48h", async () => {
    seedTenant();
    seedRolesAndUsers();
    seedInvoice({
      id: "paid-recent",
      status: "paid",
      paid_at: new Date(INSIDE_WINDOW.getTime() - 60_000).toISOString(),
    });
    seedInvoice({
      id: "paid-old",
      status: "paid",
      paid_at: new Date(INSIDE_WINDOW.getTime() - 60 * 60_000 * 49).toISOString(),
    });

    const result = await sendPendingBillingEmails({ now: INSIDE_WINDOW });

    expect(result).toBe(1);
    const paidLogs = fake.admin.rows("billing_email_log").filter((r) => r.kind === "paid");
    expect(paidLogs).toEqual([expect.objectContaining({ invoice_id: "paid-recent" })]);
  });

  it("an exempt house without any invoice never gets an e-mail", async () => {
    seedTenant();
    fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "exempt" });
    seedRolesAndUsers();

    const result = await sendPendingBillingEmails({ now: INSIDE_WINDOW });

    expect(result).toBe(0);
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });
});
