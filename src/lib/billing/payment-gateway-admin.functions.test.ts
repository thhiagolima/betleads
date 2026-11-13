// Gateways de pagamento (super admin): credentials of Upper/SpacePay in the DB,
// with env fallback, and the active provider for new charges.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
const loader = vi.hoisted(() => ({
  getUpperConfig: vi.fn(),
  getSpacePayConfig: vi.fn(),
  getActivePixProvider: vi.fn(),
  savePaymentGatewayCredentials: vi.fn(),
  deletePaymentGatewayCredentials: vi.fn(),
  setActivePixProvider: vi.fn(),
  describePaymentGateways: vi.fn(),
}));
const probe = vi.hoisted(() => ({
  testUpperConnection: vi.fn(),
  testSpacePayConnection: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("@/lib/admin-audit.server", () => ({
  auditAdminAction: vi.fn(async (args: Record<string, unknown>) => {
    audit.calls.push(args);
  }),
}));
vi.mock("./payment-gateway-config.server", () => loader);
vi.mock("./payment-gateway-test.server", () => probe);

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  adminDeletePaymentGatewayFor,
  adminListPaymentGatewaysFor,
  adminSavePaymentGatewayFor,
  adminSetActivePixProviderFor,
  adminTestPaymentGatewayFor,
  isValidCnpj,
  isValidCpf,
} from "./payment-gateway-admin.functions";

const ADMIN = { userId: "00000000-0000-4000-8000-0000000000ad" };
const NOT_ADMIN = { userId: "00000000-0000-4000-8000-0000000000ee" };

const VALID_CPF = "529.982.247-25";
const VALID_CNPJ = "11.222.333/0001-81";
const SECRET_48 = "s".repeat(48);

const STORED_SPACEPAY = {
  gatewayToken: "stored-gateway-token",
  casinoToken: "stored-casino-token",
  platformId: "stored-platform",
  callbackSecret: "c".repeat(40),
  apiBase: null,
  payer: { name: "BetLeads Ltda", document: "52998224725", email: "fin@betleads.test", phone: "11999998888" },
};
const STORED_UPPER = { apiKey: "stored-upper-key", webhookSecret: "stored-webhook", apiBase: null };

const none = { source: "none", config: null };

beforeEach(() => {
  fake.db.reset();
  audit.calls = [];
  for (const fn of [...Object.values(loader), ...Object.values(probe)]) fn.mockReset();
  loader.getUpperConfig.mockResolvedValue(none);
  loader.getSpacePayConfig.mockResolvedValue(none);
  loader.getActivePixProvider.mockResolvedValue("upper");
  fake.db.onRpc("is_super_admin", (args) => ({ data: args._user_id === ADMIN.userId, error: null }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function allAuditText() {
  return JSON.stringify(audit.calls);
}

describe("document validation", () => {
  it("accepts real CPF/CNPJ check digits only", () => {
    expect(isValidCpf(VALID_CPF)).toBe(true);
    expect(isValidCpf("529.982.247-24")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCnpj(VALID_CNPJ)).toBe(true);
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
  });
});

describe("super admin guard", () => {
  it("refuses every action to a non super admin", async () => {
    await expect(adminListPaymentGatewaysFor(NOT_ADMIN)).rejects.toThrow(/plataforma/);
    await expect(
      adminSavePaymentGatewayFor(NOT_ADMIN, { provider: "upper", credentials: { apiKey: "x" } }),
    ).rejects.toThrow(/plataforma/);
    await expect(adminTestPaymentGatewayFor(NOT_ADMIN, { provider: "upper" })).rejects.toThrow(/plataforma/);
    await expect(adminSetActivePixProviderFor(NOT_ADMIN, { provider: "upper" })).rejects.toThrow(/plataforma/);
    await expect(adminDeletePaymentGatewayFor(NOT_ADMIN, { provider: "upper" })).rejects.toThrow(/plataforma/);
    expect(loader.savePaymentGatewayCredentials).not.toHaveBeenCalled();
    expect(loader.setActivePixProvider).not.toHaveBeenCalled();
    expect(loader.deletePaymentGatewayCredentials).not.toHaveBeenCalled();
  });
});

describe("adminListPaymentGatewaysFor", () => {
  it("returns the loader's description (no secrets)", async () => {
    const described = {
      activeProvider: "upper",
      activeSource: "default",
      gateways: {
        upper: { source: "env", hints: { apiKey: "••••abcd" }, updatedAt: null },
        spacepay: { source: "none", hints: {}, updatedAt: null },
      },
    };
    loader.describePaymentGateways.mockResolvedValue(described);
    vi.stubEnv("PUBLIC_APP_URL", " https://crm.betleads.test// ");
    expect(await adminListPaymentGatewaysFor(ADMIN)).toEqual({
      ...described,
      publicAppUrl: "https://crm.betleads.test",
    });
  });

  it("publicAppUrl is null when PUBLIC_APP_URL is unset or blank on the server", async () => {
    loader.describePaymentGateways.mockResolvedValue({ gateways: {} });
    vi.stubEnv("PUBLIC_APP_URL", "  ");
    expect((await adminListPaymentGatewaysFor(ADMIN)).publicAppUrl).toBeNull();
    vi.stubEnv("PUBLIC_APP_URL", undefined);
    expect((await adminListPaymentGatewaysFor(ADMIN)).publicAppUrl).toBeNull();
  });
});

describe("adminSavePaymentGatewayFor — Upper", () => {
  it("creates the row with a new key and audits field names only", async () => {
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "upper",
      credentials: { apiKey: " new-upper-key ", webhookSecret: "", apiBase: "https://api.upper.test/v1" },
    });
    expect(loader.savePaymentGatewayCredentials).toHaveBeenCalledWith(
      "upper",
      { apiKey: "new-upper-key", webhookSecret: null, apiBase: "https://api.upper.test/v1" },
      ADMIN.userId,
    );
    expect(audit.calls[0]).toMatchObject({
      action: "payment_gateway.create",
      after: { provider: "upper", fields_changed: ["apiBase", "apiKey"] },
    });
    expect(allAuditText()).not.toContain("new-upper-key");
  });

  it("blank secret keeps the stored one (partial update)", async () => {
    loader.getUpperConfig.mockResolvedValue({ source: "database", config: STORED_UPPER });
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "upper",
      credentials: { apiKey: "", webhookSecret: "rotated-webhook" },
    });
    expect(loader.savePaymentGatewayCredentials).toHaveBeenCalledWith(
      "upper",
      { apiKey: "stored-upper-key", webhookSecret: "rotated-webhook", apiBase: null },
      ADMIN.userId,
    );
    expect(audit.calls[0]).toMatchObject({
      action: "payment_gateway.update",
      after: { fields_changed: ["webhookSecret"] },
    });
    expect(allAuditText()).not.toMatch(/rotated-webhook|stored-upper-key/);
  });

  it("clearFields erases an optional stored value", async () => {
    loader.getUpperConfig.mockResolvedValue({ source: "database", config: STORED_UPPER });
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "upper",
      credentials: {},
      clearFields: ["webhookSecret"],
    });
    expect(loader.savePaymentGatewayCredentials.mock.calls[0][1]).toEqual({
      apiKey: "stored-upper-key",
      webhookSecret: null,
      apiBase: null,
    });
  });

  it("never copies env values: env-only config still needs the key", async () => {
    loader.getUpperConfig.mockResolvedValue({ source: "env", config: STORED_UPPER });
    await expect(
      adminSavePaymentGatewayFor(ADMIN, { provider: "upper", credentials: { apiKey: "" } }),
    ).rejects.toThrow("Informe a API key da Upper.");
  });

  it("rejects a non-https API base", async () => {
    await expect(
      adminSavePaymentGatewayFor(ADMIN, {
        provider: "upper",
        credentials: { apiKey: "k", apiBase: "http://api.upper.test" },
      }),
    ).rejects.toThrow(/https/);
    expect(loader.savePaymentGatewayCredentials).not.toHaveBeenCalled();
  });
});

describe("adminSavePaymentGatewayFor — SpacePay", () => {
  const full = {
    gatewayToken: "new-gateway-token",
    casinoToken: "",
    platformId: "  casino-77  ",
    callbackSecret: SECRET_48,
    apiBase: "",
    payer: { name: "BetLeads Ltda", document: VALID_CNPJ, email: "fin@betleads.test", phone: "(11) 99999-8888" },
  };

  it("saves a full config with digits-only document/phone", async () => {
    await adminSavePaymentGatewayFor(ADMIN, { provider: "spacepay", credentials: full });
    expect(loader.savePaymentGatewayCredentials).toHaveBeenCalledWith(
      "spacepay",
      {
        gatewayToken: "new-gateway-token",
        casinoToken: null,
        platformId: "casino-77",
        callbackSecret: SECRET_48,
        apiBase: null,
        payer: { name: "BetLeads Ltda", document: "11222333000181", email: "fin@betleads.test", phone: "11999998888" },
      },
      ADMIN.userId,
    );
    expect(allAuditText()).not.toMatch(/new-gateway-token|sssss|11222333000181/);
    expect(audit.calls[0].after).toMatchObject({
      fields_changed: expect.arrayContaining(["callbackSecret", "gatewayToken", "payer.document"]),
    });
  });

  it("validates callback secret length, document, e-mail and phone", async () => {
    const bad = (patch: Record<string, unknown>) =>
      adminSavePaymentGatewayFor(ADMIN, { provider: "spacepay", credentials: { ...full, ...patch } });
    await expect(bad({ callbackSecret: "short" })).rejects.toThrow(/32 caracteres/);
    await expect(bad({ platformId: "p".repeat(201) })).rejects.toThrow();
    await expect(bad({ payer: { ...full.payer, document: "123.456.789-00" } })).rejects.toThrow(/CPF ou CNPJ/);
    await expect(bad({ payer: { ...full.payer, email: "nope" } })).rejects.toThrow(/E-mail/);
    await expect(bad({ payer: { ...full.payer, phone: "1234" } })).rejects.toThrow(/Telefone/);
    expect(loader.savePaymentGatewayCredentials).not.toHaveBeenCalled();
  });

  it("requires the callback secret and payer when nothing is stored", async () => {
    await expect(
      adminSavePaymentGatewayFor(ADMIN, {
        provider: "spacepay",
        credentials: { ...full, callbackSecret: "" },
      }),
    ).rejects.toThrow(/segredo do callback/);
    await expect(
      adminSavePaymentGatewayFor(ADMIN, {
        provider: "spacepay",
        credentials: { ...full, payer: { ...full.payer, name: "" } },
      }),
    ).rejects.toThrow(/nome do pagador/);
  });

  it("partial update keeps stored secrets and payer", async () => {
    loader.getSpacePayConfig.mockResolvedValue({ source: "database", config: STORED_SPACEPAY });
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: { gatewayToken: "", payer: { email: "novo@betleads.test" } },
    });
    expect(loader.savePaymentGatewayCredentials.mock.calls[0][1]).toEqual({
      ...STORED_SPACEPAY,
      payer: { ...STORED_SPACEPAY.payer, email: "novo@betleads.test" },
    });
    expect(audit.calls[0].after).toEqual({ provider: "spacepay", fields_changed: ["payer.email"] });
  });

  it("platformId is optional: saves without it (null) and a stored row without it stays valid", async () => {
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: { ...full, platformId: "  " },
    });
    expect(loader.savePaymentGatewayCredentials.mock.calls[0][1].platformId).toBeNull();

    loader.getSpacePayConfig.mockResolvedValue({
      source: "database",
      config: { ...STORED_SPACEPAY, platformId: null },
    });
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: { platformId: " new-platform " },
    });
    expect(loader.savePaymentGatewayCredentials.mock.calls[1][1]).toEqual({
      ...STORED_SPACEPAY,
      platformId: "new-platform",
    });
    expect(audit.calls[1].after).toEqual({ provider: "spacepay", fields_changed: ["platformId"] });
  });

  it("clearFields erases a stored platformId (blank alone keeps it)", async () => {
    loader.getSpacePayConfig.mockResolvedValue({ source: "database", config: STORED_SPACEPAY });
    await adminSavePaymentGatewayFor(ADMIN, { provider: "spacepay", credentials: { platformId: "" } });
    expect(loader.savePaymentGatewayCredentials.mock.calls[0][1].platformId).toBe("stored-platform");
    await adminSavePaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: {},
      clearFields: ["platformId"],
    });
    expect(loader.savePaymentGatewayCredentials.mock.calls[1][1].platformId).toBeNull();
  });
});

describe("adminTestPaymentGatewayFor", () => {
  it("tests the stored config (env too) when no candidate is given", async () => {
    loader.getUpperConfig.mockResolvedValue({ source: "env", config: STORED_UPPER });
    probe.testUpperConnection.mockResolvedValue({ ok: true, message: "Conectado." });
    expect(await adminTestPaymentGatewayFor(ADMIN, { provider: "upper" })).toEqual({
      ok: true,
      message: "Conectado.",
    });
    expect(probe.testUpperConnection).toHaveBeenCalledWith({ apiKey: "stored-upper-key", apiBase: null });
    expect(audit.calls[0]).toMatchObject({
      action: "payment_gateway.test",
      after: { provider: "upper", candidate: false, ok: true },
    });
  });

  it("tests candidate credentials merged with the stored row before saving", async () => {
    loader.getSpacePayConfig.mockResolvedValue({ source: "database", config: STORED_SPACEPAY });
    probe.testSpacePayConnection.mockResolvedValue({ ok: false, message: "Recusado." });
    const result = await adminTestPaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: { gatewayToken: "candidate-token", apiBase: "https://sp.test" },
    });
    expect(result.ok).toBe(false);
    expect(probe.testSpacePayConnection).toHaveBeenCalledWith({
      gatewayToken: "candidate-token",
      casinoToken: "stored-casino-token",
      platformId: "stored-platform",
      apiBase: "https://sp.test",
    });
    await adminTestPaymentGatewayFor(ADMIN, {
      provider: "spacepay",
      credentials: { platformId: " candidate-platform " },
    });
    expect(probe.testSpacePayConnection).toHaveBeenLastCalledWith({
      gatewayToken: "stored-gateway-token",
      casinoToken: "stored-casino-token",
      platformId: "candidate-platform",
      apiBase: null,
    });
    expect(loader.savePaymentGatewayCredentials).not.toHaveBeenCalled();
    expect(allAuditText()).not.toContain("candidate-token");
  });

  it("reports a missing config without calling the gateway", async () => {
    const result = await adminTestPaymentGatewayFor(ADMIN, { provider: "spacepay" });
    expect(result).toEqual({ ok: false, message: "SpacePay sem token do gateway configurado." });
    expect(probe.testSpacePayConnection).not.toHaveBeenCalled();
  });
});

describe("adminSetActivePixProviderFor", () => {
  it("refuses a provider with no config", async () => {
    await expect(adminSetActivePixProviderFor(ADMIN, { provider: "spacepay" })).rejects.toThrow(
      /SpacePay não tem credenciais/,
    );
    expect(loader.setActivePixProvider).not.toHaveBeenCalled();
  });

  it("switches and audits before/after", async () => {
    loader.getSpacePayConfig.mockResolvedValue({ source: "database", config: STORED_SPACEPAY });
    expect(await adminSetActivePixProviderFor(ADMIN, { provider: "spacepay" })).toEqual({
      ok: true,
      activeProvider: "spacepay",
    });
    expect(loader.setActivePixProvider).toHaveBeenCalledWith("spacepay", ADMIN.userId);
    expect(audit.calls[0]).toMatchObject({
      action: "payment_gateway.set_active",
      before: { active_provider: "upper" },
      after: { active_provider: "spacepay", credentials_source: "database" },
    });
  });

  it("rejects an unknown provider", async () => {
    await expect(adminSetActivePixProviderFor(ADMIN, { provider: "stripe" })).rejects.toThrow();
  });
});

describe("adminDeletePaymentGatewayFor", () => {
  it("refuses when there is no DB row", async () => {
    loader.getUpperConfig.mockResolvedValue({ source: "env", config: STORED_UPPER });
    await expect(adminDeletePaymentGatewayFor(ADMIN, { provider: "upper" })).rejects.toThrow(
      /não tem credenciais salvas no banco/,
    );
  });

  it("refuses deleting the active provider without env fallback", async () => {
    vi.stubEnv("UPPER_API_KEY", "");
    loader.getUpperConfig.mockResolvedValue({ source: "database", config: STORED_UPPER });
    await expect(adminDeletePaymentGatewayFor(ADMIN, { provider: "upper" })).rejects.toThrow(
      /gateway das novas cobranças/,
    );
    expect(loader.deletePaymentGatewayCredentials).not.toHaveBeenCalled();
  });

  it("allows deleting the active provider when env covers it", async () => {
    vi.stubEnv("UPPER_API_KEY", "env-key");
    loader.getUpperConfig.mockResolvedValue({ source: "database", config: STORED_UPPER });
    await adminDeletePaymentGatewayFor(ADMIN, { provider: "upper" });
    expect(loader.deletePaymentGatewayCredentials).toHaveBeenCalledWith("upper");
    expect(audit.calls[0]).toMatchObject({
      action: "payment_gateway.delete",
      after: { provider: "upper", env_fallback: true },
    });
  });

  it("refuses an inactive provider without env while it has open charges", async () => {
    vi.stubEnv("SPACEPAY_GATEWAY_TOKEN", "");
    loader.getSpacePayConfig.mockResolvedValue({ source: "database", config: STORED_SPACEPAY });
    fake.db.rows("payment_charges").push(
      { id: "c1", provider: "spacepay", status: "ACTIVE" },
      { id: "c2", provider: "upper", status: "ACTIVE" },
    );
    await expect(adminDeletePaymentGatewayFor(ADMIN, { provider: "spacepay" })).rejects.toThrow(
      /1 cobrança\(s\) Pix em aberto/,
    );
    fake.db.rows("payment_charges")[0].status = "PAID";
    await adminDeletePaymentGatewayFor(ADMIN, { provider: "spacepay" });
    expect(loader.deletePaymentGatewayCredentials).toHaveBeenCalledWith("spacepay");
  });
});
