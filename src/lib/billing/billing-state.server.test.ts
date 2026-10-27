// Mensalidade Task 4 — server-side lock of unpaid houses and who can pay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  __resetDemoTenantCacheForTests,
  assertTenantCanSendExternally,
  assertTenantNotDemoForSend,
  demoSendBlockedReason,
  resolveCurrentTenantId,
  resolveOperationalTenantForRequest,
  resolveOperationalTenantId,
} from "@/lib/tenant-access.server";
import { getCurrentTenantAccessStatusFor } from "@/lib/tenants.functions";

import {
  BILLING_LOCKED_TEXT,
  getTenantBillingSnapshot,
  isBillingLockedFor,
  requireTenantPayer,
  resolveTenantForBilling,
  TenantBillingLockedError,
} from "./billing-state.server";
import { isBillingLockedError, isSendBlockedError } from "./billing-locked-error";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const DEMO_TENANT = "00000000-0000-4000-8000-00000000a0a1";
const SUSPENDED_TENANT = "00000000-0000-4000-8000-00000000a0a2";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000b1";
const OWNER = "00000000-0000-4000-8000-0000000000b2";
const GESTOR = "00000000-0000-4000-8000-0000000000b3";
const MEMBER = "00000000-0000-4000-8000-0000000000b4";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000b5";

const NOT_PAYER = "Peça ao administrador da casa para pagar a mensalidade.";

/**
 * A user-scoped client double: `is_super_admin` honours `_user_id` and,
 * without it (the `auth.uid()` default), answers for `userId`;
 * `current_tenant_id` is the user's active house; `user_roles` holds every
 * role (the real RLS lets a user read only their own rows — the code always
 * filters by `user_id`).
 */
function userClient(userId: string, activeTenant: string | null = TENANT) {
  const db = createFakeDb();
  db.onRpc("is_super_admin", (args) => ({
    data: ((args?._user_id as string | undefined) ?? userId) === SUPER_ADMIN,
    error: null,
  }));
  db.onRpc("current_tenant_id", () => ({ data: activeTenant, error: null }));
  db.rows("user_roles").push(
    { user_id: ADMIN, tenant_id: TENANT, role: "admin" },
    { user_id: OWNER, tenant_id: TENANT, role: "owner" },
    { user_id: GESTOR, tenant_id: TENANT, role: "gestor" },
    { user_id: MEMBER, tenant_id: TENANT, role: "member" },
    { user_id: PLAIN_USER, tenant_id: TENANT, role: "user" },
  );
  return db.client;
}

function setBillingState(tenantId: string, state: string | null) {
  const tenant = fake.admin.rows("tenants").find((row) => row.id === tenantId)!;
  tenant.tenant_billing = state ? { access_state: state } : null;
  __resetDemoTenantCacheForTests();
}

beforeEach(() => {
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin.rows("tenants").push(
    {
      id: TENANT,
      nome: "Casa",
      slug: "casa",
      status: "active",
      is_demo: false,
      plano: "starter",
      crm_model: "CRM_PLATAFORMA",
      tenant_billing: { access_state: "ok" },
    },
    { id: DEMO_TENANT, status: "active", is_demo: true, tenant_billing: null },
    { id: SUSPENDED_TENANT, status: "suspended", is_demo: false, tenant_billing: null },
  );
  vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
  // Enforcement only counts with invoices on (fails closed otherwise).
  vi.stubEnv("BILLING_INVOICES_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireTenantPayer", () => {
  it.each([
    ["admin", ADMIN],
    ["owner", OWNER],
    ["gestor", GESTOR],
    ["superadmin", SUPER_ADMIN],
  ])("accepts the %s", async (_label, userId) => {
    await expect(
      requireTenantPayer(userClient(userId), TENANT, NOT_PAYER, userId),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["member", MEMBER],
    ["user", PLAIN_USER],
  ])("refuses a %s with the given message", async (_label, userId) => {
    await expect(requireTenantPayer(userClient(userId), TENANT, NOT_PAYER, userId)).rejects.toThrow(
      NOT_PAYER,
    );
  });

  it("refuses an admin of ANOTHER house", async () => {
    const other = "00000000-0000-4000-8000-00000000a0ff";
    await expect(requireTenantPayer(userClient(ADMIN), other, NOT_PAYER, ADMIN)).rejects.toThrow(
      NOT_PAYER,
    );
  });
});

describe("isBillingLockedFor", () => {
  it("locked_unpaid with enforcement: true for an admin, false for the superadmin", async () => {
    setBillingState(TENANT, "locked_unpaid");
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(true);
    expect(await isBillingLockedFor(TENANT, SUPER_ADMIN)).toBe(false);
  });

  it("locked_unpaid without enforcement: false", async () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "false");
    setBillingState(TENANT, "locked_unpaid");
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(false);
  });

  it("awaiting_first_payment follows enforcement", async () => {
    setBillingState(TENANT, "awaiting_first_payment");
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(true);
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "");
    __resetDemoTenantCacheForTests();
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(false);
  });

  it.each(["locked_manual", "frozen"])("%s locks even without enforcement", async (state) => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "false");
    setBillingState(TENANT, state);
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(true);
    expect(await isBillingLockedFor(TENANT, SUPER_ADMIN)).toBe(false);
  });

  it.each(["ok", "due_soon", "overdue", "exempt"])("%s never locks", async (state) => {
    setBillingState(TENANT, state);
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(false);
  });

  it("a house without a billing row is never locked", async () => {
    setBillingState(TENANT, null);
    expect(await isBillingLockedFor(TENANT, ADMIN)).toBe(false);
  });
});

describe("resolvers on a locked house", () => {
  beforeEach(() => setBillingState(TENANT, "locked_unpaid"));

  it("resolveOperationalTenantForRequest refuses an admin with BILLING_LOCKED", async () => {
    const error = await resolveOperationalTenantForRequest(userClient(ADMIN), ADMIN, null).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TenantBillingLockedError);
    expect(error).toMatchObject({ code: "BILLING_LOCKED", message: BILLING_LOCKED_TEXT });
    expect(BILLING_LOCKED_TEXT).toBe("Acesso suspenso. Regularize a mensalidade em Plano e créditos.");
  });

  it("resolveTenantForBilling lets the same admin through", async () => {
    await expect(resolveTenantForBilling(userClient(ADMIN), ADMIN, null)).resolves.toBe(TENANT);
  });

  it("resolveOperationalTenantForRequest lets the superadmin through", async () => {
    await expect(
      resolveOperationalTenantForRequest(userClient(SUPER_ADMIN), SUPER_ADMIN, TENANT),
    ).resolves.toBe(TENANT);
  });

  it("resolveCurrentTenantId refuses a gestor and lets the superadmin through", async () => {
    await expect(resolveCurrentTenantId(userClient(GESTOR))).rejects.toMatchObject({
      code: "BILLING_LOCKED",
    });
    await expect(resolveCurrentTenantId(userClient(SUPER_ADMIN))).resolves.toBe(TENANT);
  });

  it("resolveOperationalTenantId refuses an admin and lets the superadmin through", async () => {
    await expect(resolveOperationalTenantId(userClient(ADMIN))).rejects.toMatchObject({
      code: "BILLING_LOCKED",
    });
    await expect(resolveOperationalTenantId(userClient(SUPER_ADMIN))).resolves.toBe(TENANT);
  });

  it("an unlocked house resolves normally (no extra superadmin query)", async () => {
    setBillingState(TENANT, "overdue");
    const client = userClient(ADMIN);
    const rpc = vi.spyOn(client, "rpc");
    await expect(resolveCurrentTenantId(client)).resolves.toBe(TENANT);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["current_tenant_id"]);
  });

  it("keeps the suspended-house message unchanged", async () => {
    await expect(
      resolveOperationalTenantId(userClient(ADMIN, SUSPENDED_TENANT)),
    ).rejects.toThrow("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
  });
});

describe("send guards on a locked house", () => {
  beforeEach(() => setBillingState(TENANT, "locked_unpaid"));

  it("assertTenantCanSendExternally throws TenantBillingLockedError", async () => {
    await expect(assertTenantCanSendExternally(TENANT)).rejects.toBeInstanceOf(
      TenantBillingLockedError,
    );
  });

  it("assertTenantNotDemoForSend throws it too (sends stop for everyone)", async () => {
    await expect(assertTenantNotDemoForSend(TENANT)).rejects.toBeInstanceOf(
      TenantBillingLockedError,
    );
    await expect(demoSendBlockedReason(TENANT)).resolves.toBe(BILLING_LOCKED_TEXT);
  });

  it("allowBillingLocked lets a provider READ through (Short.io statistics)", async () => {
    await expect(
      assertTenantNotDemoForSend(TENANT, { allowBillingLocked: true }),
    ).resolves.toBeUndefined();
  });

  it("without enforcement an unpaid house still sends", async () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "false");
    __resetDemoTenantCacheForTests();
    await expect(assertTenantCanSendExternally(TENANT)).resolves.toBeUndefined();
  });

  it("demo stays DEMO_SEND_BLOCKED", async () => {
    await expect(assertTenantCanSendExternally(DEMO_TENANT)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });

  it("isSendBlockedError recognizes the lock in every shape a dispatcher sees", () => {
    expect(isSendBlockedError(new TenantBillingLockedError())).toBe(true);
    expect(isBillingLockedError(new Error(BILLING_LOCKED_TEXT))).toBe(true);
    expect(isBillingLockedError({ code: "BILLING_LOCKED" })).toBe(true);
    expect(isBillingLockedError(new Error("boom"))).toBe(false);
  });
});

describe("getTenantBillingSnapshot", () => {
  it("reads the billing row and the open invoice", async () => {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      access_state: "locked_unpaid",
      next_due_date: "2026-10-10",
      manual_block_reason: null,
    });
    fake.admin.rows("billing_invoices").push(
      { id: "inv-paid", tenant_id: TENANT, amount_cents: 400000, due_date: "2026-09-10", status: "paid" },
      { id: "inv-open", tenant_id: TENANT, amount_cents: 400000, due_date: "2026-10-10", status: "open" },
    );
    await expect(getTenantBillingSnapshot(TENANT)).resolves.toEqual({
      state: "locked_unpaid",
      invoice: { id: "inv-open", amountCents: 400000, dueDate: "2026-10-10", status: "open" },
      nextDueDate: "2026-10-10",
      manualBlockReason: null,
    });
  });

  it("a house without a billing row reads as ok with no invoice", async () => {
    await expect(getTenantBillingSnapshot(TENANT)).resolves.toEqual({
      state: "ok",
      invoice: null,
      nextDueDate: null,
      manualBlockReason: null,
    });
  });
});

describe("getCurrentTenantAccessStatus billing block", () => {
  beforeEach(() => {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      access_state: "locked_unpaid",
      next_due_date: "2026-10-10",
      manual_block_reason: null,
    });
    fake.admin.rows("billing_invoices").push({
      id: "inv-open",
      tenant_id: TENANT,
      amount_cents: 400000,
      due_date: "2026-10-10",
      status: "open",
    });
  });

  type Ctx = Parameters<typeof getCurrentTenantAccessStatusFor>[0];
  const ctxFor = (userId: string) =>
    ({ userId, supabase: userClient(userId) }) as unknown as Ctx;

  it("an admin of a locked house gets the lock (and the status is not refused)", async () => {
    const status = await getCurrentTenantAccessStatusFor(ctxFor(ADMIN));
    expect(status.blocked).toBe(false);
    expect(status.billing).toMatchObject({
      state: "locked_unpaid",
      effectiveLock: true,
      role: "payer",
      enforcement: true,
      invoice: { id: "inv-open", amountCents: 400000, dueDate: "2026-10-10", status: "open" },
    });
    expect(status.billing?.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("a member is a member", async () => {
    const status = await getCurrentTenantAccessStatusFor(ctxFor(MEMBER));
    expect(status.billing).toMatchObject({ role: "member", effectiveLock: true });
  });

  it("the superadmin sees the house's state but is never locked", async () => {
    const status = await getCurrentTenantAccessStatusFor(ctxFor(SUPER_ADMIN));
    expect(status.isSuperAdmin).toBe(true);
    expect(status.billing).toMatchObject({
      state: "locked_unpaid",
      effectiveLock: false,
      role: "super_admin",
    });
  });

  it("enforcement off: no effective lock", async () => {
    vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "false");
    const status = await getCurrentTenantAccessStatusFor(ctxFor(ADMIN));
    expect(status.billing).toMatchObject({ effectiveLock: false, enforcement: false });
  });
});
