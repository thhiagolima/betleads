import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { createUpperCharge } = vi.hoisted(() => ({ createUpperCharge: vi.fn() }));
vi.mock("./upper-pix.server", () => ({
  createUpperCharge,
  UpperError: class UpperError extends Error {
    status: number;
    code: string | null;
    retryable: boolean;
    constructor(message: string, options: { status: number; code: string | null; retryable: boolean }) {
      super(message);
      this.name = "UpperError";
      this.status = options.status;
      this.code = options.code;
      this.retryable = options.retryable;
    }
  },
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { DEMO_ACTION_BLOCKED_TEXT } from "@/lib/demo-tenant";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import {
  BILLING_LOCKED_PURCHASE_MESSAGE,
  createCreditTopupFor,
  getTopupStatusFor,
} from "./topup.functions";
import { UpperError } from "./upper-pix.server";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_USER = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_USER = "00000000-0000-4000-8000-0000000000cd";
const OWNER_USER = "00000000-0000-4000-8000-0000000000ce";
const MEMBER_USER = "00000000-0000-4000-8000-0000000000cf";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000d0";

let userDb: ReturnType<typeof createFakeDb>;

function ctxFor(userId: string) {
  return { userId, supabase: userDb.client };
}

function upperChargeResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "upstream-1",
    externalId: overrides.externalId ?? "bl-top-x",
    status: "ACTIVE",
    amountCents: 100000,
    emv: "00020101...",
    qrCodeImage: "https://img.example/qr.png",
    paymentUrl: "https://pay.example/x",
    expiresAt: "2026-10-22T12:00:00Z",
    paidAt: null,
    paidAmountCents: null,
    payer: null,
    raw: { status: "ACTIVE" },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.BILLING_GATEWAY_ENABLED = "true";
  process.env.UPPER_API_KEY = "test-upper-key";

  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  fake.admin.onRpc("billing_tenant_exempt", () => ({ data: false, error: null }));
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Sorte Alta", plano: "padrao" });
  fake.admin.rows("tenants").push({ id: OTHER_TENANT, nome: "Outra Casa", plano: "padrao" });

  userDb = createFakeDb();
  userDb.onRpc("is_super_admin", () => ({ data: false, error: null }));
  userDb.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
  userDb.onRpc("is_tenant_admin", (args) => ({
    data: args._tenant === TENANT,
    error: null,
  }));
  userDb.rows("user_roles").push(
    { user_id: ADMIN_USER, tenant_id: TENANT, role: "admin" },
    { user_id: GESTOR_USER, tenant_id: TENANT, role: "gestor" },
    { user_id: OWNER_USER, tenant_id: TENANT, role: "owner" },
    { user_id: MEMBER_USER, tenant_id: TENANT, role: "member" },
    { user_id: PLAIN_USER, tenant_id: TENANT, role: "user" },
  );

  createUpperCharge.mockReset();
  createUpperCharge.mockResolvedValue(upperChargeResult());
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BILLING_ENFORCEMENT_ENABLED;
  delete process.env.BILLING_GATEWAY_ENABLED;
  delete process.env.UPPER_API_KEY;
});

describe("createCreditTopupFor", () => {
  it("refuses when the gateway is off", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "false";
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Compra por Pix indisponível no momento.");
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("refuses with the unavailable message, before writing anything, when UPPER_API_KEY is missing", async () => {
    process.env.UPPER_API_KEY = "  ";
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Compra por Pix indisponível no momento.");
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(0);
    expect(fake.admin.rows("payment_charges")).toHaveLength(0);
  });

  it.each([
    ["gestor", GESTOR_USER],
    ["owner", OWNER_USER],
  ])("accepts a %s of the house (payer roles: admin, owner, gestor)", async (_role, userId) => {
    userDb.onRpc("is_tenant_admin", () => ({ data: false, error: null }));
    const result = await createCreditTopupFor(ctxFor(userId), {
      tenantId: TENANT,
      packageCode: "p1000",
    });
    expect(result.chargeId).toBeTruthy();
    expect(createUpperCharge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["member", MEMBER_USER],
    ["user", PLAIN_USER],
  ])("refuses a %s of the house", async (_role, userId) => {
    await expect(
      createCreditTopupFor(ctxFor(userId), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Só o admin ou o gestor da casa pode comprar créditos.");
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("refuses a house locked for the monthly fee with the exact copy, before writing anything", async () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    fake.admin.onRpc("is_super_admin", () => ({ data: false, error: null }));
    fake.admin.rows("tenants")[0].tenant_billing = { access_state: "locked_unpaid" };
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Disponível depois de pagar a mensalidade");
    expect(BILLING_LOCKED_PURCHASE_MESSAGE).toBe("Disponível depois de pagar a mensalidade");
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(0);
  });

  it("buys normally for an unpaid house while enforcement is off (no effective lock)", async () => {
    fake.admin.rows("tenants")[0].tenant_billing = { access_state: "locked_unpaid" };
    const result = await createCreditTopupFor(ctxFor(ADMIN_USER), {
      tenantId: TENANT,
      packageCode: "p1000",
    });
    expect(result.chargeId).toBeTruthy();
  });

  it("refuses the demo tenant", async () => {
    fake.admin.rows("tenants")[0].is_demo = true;
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow(DEMO_ACTION_BLOCKED_TEXT);
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("refuses a house user who passes another house's tenantId", async () => {
    // userDb's current_tenant_id resolves to TENANT; the caller is not a
    // super admin, so asking for OTHER_TENANT must be refused before
    // anything else runs.
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: OTHER_TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Sem acesso aos dados desta conta.");
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(0);
  });

  it("refuses an exempt house", async () => {
    fake.admin.onRpc("billing_tenant_exempt", () => ({ data: true, error: null }));
    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Esta casa é isenta e não precisa comprar créditos");
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("creates exactly one order and one charge, with a bl-top- external_id up to 64 chars", async () => {
    const result = await createCreditTopupFor(ctxFor(ADMIN_USER), {
      tenantId: TENANT,
      packageCode: "p1000",
    });

    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(1);
    expect(fake.admin.rows("payment_charges")).toHaveLength(1);

    const order = fake.admin.rows("credit_topup_orders")[0];
    const charge = fake.admin.rows("payment_charges")[0];

    expect(charge.kind).toBe("credit_topup");
    expect(charge.ref_id).toBe(order.id);
    expect(charge.external_id).toBe(`bl-top-${order.id}`);
    expect(String(charge.external_id).length).toBeLessThanOrEqual(64);
    expect(charge.amount_cents).toBe(100000);
    expect(order.charge_id).toBe(charge.id);

    expect(result.orderId).toBe(order.id);
    expect(result.chargeId).toBe(charge.id);
    expect(result.amountCents).toBe(100000);
    expect(result.emv).toBe("00020101...");
    expect(result.qrCodeImage).toBe("https://img.example/qr.png");
    expect(result.paymentUrl).toBe("https://pay.example/x");
    expect(result.expiresAt).toBe("2026-10-22T12:00:00Z");

    expect(createUpperCharge).toHaveBeenCalledTimes(1);
    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.externalId).toBe(`bl-top-${order.id}`);
    expect(callArgs.expiresIn).toBe(3600);
    expect(callArgs.description).toBe("Sorte Alta - Créditos BetLeads R$ 1.000,00");

    // The Pix checkout details must actually land on the charge row (not
    // just in the returned result) — this is what the purchase screen
    // re-reads via getTopupStatus/a page refresh.
    expect(charge.provider_charge_id).toBe("upstream-1");
    expect(charge.emv).toBe("00020101...");
    expect(charge.qr_code_image).toBe("https://img.example/qr.png");
    expect(charge.payment_url).toBe("https://pay.example/x");
    expect(charge.expires_at).toBe("2026-10-22T12:00:00Z");
  });

  it("completes a free-value purchase end to end (no package code)", async () => {
    createUpperCharge.mockResolvedValue(
      upperChargeResult({ amountCents: 15000, status: "ACTIVE" }),
    );

    const result = await createCreditTopupFor(ctxFor(ADMIN_USER), {
      tenantId: TENANT,
      amountCents: 15000,
    });

    const order = fake.admin.rows("credit_topup_orders")[0];
    const charge = fake.admin.rows("payment_charges")[0];

    expect(order.amount_cents).toBe(15000);
    expect(order.package_code).toBeNull();
    expect(charge.amount_cents).toBe(15000);
    expect(result.amountCents).toBe(15000);

    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.amountCents).toBe(15000);
    expect(callArgs.description).toBe("Sorte Alta - Créditos BetLeads R$ 150,00");
  });

  it("creates two distinct orders/charges/external_id on two consecutive calls", async () => {
    const first = await createCreditTopupFor(ctxFor(ADMIN_USER), {
      tenantId: TENANT,
      packageCode: "p1000",
    });
    const second = await createCreditTopupFor(ctxFor(ADMIN_USER), {
      tenantId: TENANT,
      packageCode: "p1000",
    });

    expect(first.orderId).not.toBe(second.orderId);
    expect(first.chargeId).not.toBe(second.chargeId);
    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(2);
    expect(fake.admin.rows("payment_charges")).toHaveLength(2);
    const externalIds = fake.admin.rows("payment_charges").map((row) => row.external_id);
    expect(new Set(externalIds).size).toBe(2);
  });

  it("marks the order failed and the charge FAILED when Upper fails twice (502), with the generic message", async () => {
    createUpperCharge.mockRejectedValue(
      new UpperError("Upper respondeu 502.", { status: 502, code: null, retryable: true }),
    );

    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Não foi possível gerar o Pix agora. Tente de novo em instantes.");

    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(1);
    expect(fake.admin.rows("payment_charges")).toHaveLength(1);
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("failed");
    const charge = fake.admin.rows("payment_charges")[0];
    expect(charge.status).toBe("FAILED");
    expect(charge.last_error).toBeTruthy();
    expect(JSON.stringify(charge.last_error)).not.toContain("502.");
  });

  it("marks the just-created order failed when the charge insert fails, never calling Upper", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_charges", "insert", "db down");

    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Não foi possível gerar o Pix agora. Tente de novo em instantes.");

    expect(fake.admin.rows("payment_charges")).toHaveLength(0);
    expect(fake.admin.rows("credit_topup_orders")).toHaveLength(1);
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("failed");
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  describe("open Pix cap (3 per house)", () => {
    const FUTURE = "2999-01-01T00:00:00Z";
    const PAST = "2000-01-01T00:00:00Z";

    function seedCharge(overrides: Record<string, unknown>) {
      fake.admin.rows("payment_charges").push({
        tenant_id: TENANT,
        status: "ACTIVE",
        expires_at: FUTURE,
        ...overrides,
      });
    }

    it("refuses a 4th purchase while 3 unexpired PENDING/ACTIVE charges are open", async () => {
      seedCharge({ id: "open-1", status: "ACTIVE" });
      seedCharge({ id: "open-2", status: "PENDING", expires_at: null });
      seedCharge({ id: "open-3", status: "ACTIVE" });

      await expect(
        createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
      ).rejects.toThrow(
        "Você já tem Pix em aberto. Pague ou aguarde expirar antes de gerar outro.",
      );
      expect(createUpperCharge).not.toHaveBeenCalled();
      expect(fake.admin.rows("credit_topup_orders")).toHaveLength(0);
      expect(fake.admin.rows("payment_charges")).toHaveLength(3);
    });

    it("does not count expired-by-time, terminal, paid or other houses' charges", async () => {
      seedCharge({ id: "open-1", status: "ACTIVE" });
      seedCharge({ id: "open-2", status: "PENDING", expires_at: null });
      seedCharge({ id: "stale", status: "ACTIVE", expires_at: PAST });
      seedCharge({ id: "expired", status: "EXPIRED" });
      seedCharge({ id: "paid", status: "PAID" });
      seedCharge({ id: "other", status: "ACTIVE", tenant_id: OTHER_TENANT });

      const result = await createCreditTopupFor(ctxFor(ADMIN_USER), {
        tenantId: TENANT,
        packageCode: "p1000",
      });
      expect(result.chargeId).toBeTruthy();
      expect(createUpperCharge).toHaveBeenCalledTimes(1);
    });
  });

  it("maps NOT_CONFIGURED/FEATURE_DISABLED Upper errors to the unavailable message", async () => {
    createUpperCharge.mockRejectedValue(
      new UpperError("Upper não configurado.", {
        status: 0,
        code: "NOT_CONFIGURED",
        retryable: false,
      }),
    );

    await expect(
      createCreditTopupFor(ctxFor(ADMIN_USER), { tenantId: TENANT, packageCode: "p1000" }),
    ).rejects.toThrow("Compra por Pix indisponível no momento.");
  });
});

describe("getTopupStatusFor", () => {
  it("returns status/paidAt/credited for a charge belonging to the caller's house", async () => {
    userDb.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      status: "PAID",
      paid_at: "2026-10-22T12:00:00Z",
      credited_at: "2026-10-22T12:00:05Z",
    });

    const result = await getTopupStatusFor(ctxFor(ADMIN_USER), { chargeId: "charge-1" });
    expect(result).toEqual({
      status: "PAID",
      paidAt: "2026-10-22T12:00:00Z",
      credited: true,
      needsReview: false,
    });
  });

  it("returns needsReview:true for a PAID charge flagged for review (not credited)", async () => {
    userDb.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      status: "PAID",
      paid_at: "2026-10-22T12:00:00Z",
      credited_at: null,
      needs_review: true,
    });

    const result = await getTopupStatusFor(ctxFor(ADMIN_USER), { chargeId: "charge-1" });
    expect(result).toEqual({
      status: "PAID",
      paidAt: "2026-10-22T12:00:00Z",
      credited: false,
      needsReview: true,
    });
  });

  it("returns credited:false while credited_at is still null", async () => {
    userDb.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      status: "ACTIVE",
      paid_at: null,
      credited_at: null,
    });

    const result = await getTopupStatusFor(ctxFor(ADMIN_USER), { chargeId: "charge-1" });
    expect(result.credited).toBe(false);
  });

  it("throws not-found for a charge belonging to another house (simulated RLS)", async () => {
    // The user's own client only ever sees rows RLS lets through; here we
    // simulate that by simply not inserting the row into userDb at all —
    // exactly what RLS would produce for another house's charge.
    await expect(
      getTopupStatusFor(ctxFor(ADMIN_USER), { chargeId: "charge-does-not-belong-to-me" }),
    ).rejects.toThrow("Cobrança não encontrada");
  });
});
