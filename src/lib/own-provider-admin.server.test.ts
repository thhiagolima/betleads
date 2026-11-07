// Conta própria de provedor: concessões do super admin e as guardas novas nas
// funções de conta do super admin (contas com dono só o admin da casa altera).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
const domains = vi.hoisted(() => ({ refreshTenantDomain: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("@/lib/admin-audit.server", () => ({
  auditAdminAction: vi.fn(async (args: Record<string, unknown>) => {
    audit.calls.push(args);
  }),
}));
vi.mock("@/lib/tenant-domains.server", () => ({
  refreshTenantDomain: domains.refreshTenantDomain,
}));

import {
  adminListOwnProviderGrantsFor,
  adminResolveRevokedOwnProviderFor,
  adminSetOwnProviderGrantFor,
} from "./own-provider-admin.server";
import {
  adminDeleteProviderAccountFor,
  adminListProviderAccountsFor,
  adminSaveProviderAccountFor,
  adminSetProviderAccountStatusFor,
  adminSetTenantChannelProviderFor,
  adminTestProviderAccountFor,
} from "./provider-accounts-admin.server";
import { __resetProviderAccountsCacheForTests } from "./provider-accounts.server";
import { saveProviderAccountInput } from "./provider-accounts.shared";
import { encryptProviderCredentials } from "./secret-box.server";

const ADMIN = { userId: "00000000-0000-4000-8000-0000000000ad" };
const NOT_ADMIN = { userId: "00000000-0000-4000-8000-0000000000ee" };
const TENANT = "00000000-0000-4000-8000-000000000001";
const OWNED = "66666666-6666-4666-8666-666666666666";
const OWNED_MESSAGE = "Conta da casa: só o admin da casa altera.";
const SECRET = "segredo-da-casa-9876";

async function ownedAccount(overrides: Record<string, unknown> = {}) {
  fake.db.rows("provider_accounts").push({
    id: OWNED,
    provider: "infobip",
    label: "Infobip da Casa Um",
    channels: ["sms"],
    credentials_source: "db",
    credentials_encrypted: await encryptProviderCredentials({ api_key: SECRET }),
    config: { base_url: "https://casa.api.infobip.com" },
    status: "active",
    owner_tenant_id: TENANT,
    own_unit_cost: 0.04,
    last_callback_at: "2026-11-06T10:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    ...overrides,
  });
}

function grant(overrides: Record<string, unknown> = {}) {
  fake.db.rows("tenant_own_provider_grants").push({
    tenant_id: TENANT,
    channel: "sms",
    allowed: true,
    monthly_fee_cents: 5000,
    granted_at: "2026-11-01T00:00:00Z",
    granted_by: ADMIN.userId,
    revoked_at: null,
    revoked_by: null,
    pending_decision: false,
    ...overrides,
  });
}

function link(channel = "sms", accountId = OWNED) {
  fake.db.rows("tenant_channel_providers").push({
    tenant_id: TENANT,
    channel,
    provider_account_id: accountId,
  });
}

const tenantAudits = () => fake.db.rows("tenant_audit_logs");

beforeEach(() => {
  fake.db.reset();
  audit.calls = [];
  domains.refreshTenantDomain.mockReset();
  __resetProviderAccountsCacheForTests();
  fake.db.onRpc("is_super_admin", (args) => ({ data: args._user_id === ADMIN.userId, error: null }));
  fake.db.rows("tenants").push({ id: TENANT, nome: "Casa Um" });
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adminSetOwnProviderGrantFor", () => {
  it("only the super admin gets in", async () => {
    await expect(
      adminSetOwnProviderGrantFor(NOT_ADMIN, {
        tenantId: TENANT,
        channel: "sms",
        allowed: true,
        monthlyFeeCents: 0,
      }),
    ).rejects.toThrow(/plataforma/);
    expect(fake.db.rows("tenant_own_provider_grants")).toHaveLength(0);
  });

  it("grants a channel with its fee and audits in both logs", async () => {
    await adminSetOwnProviderGrantFor(ADMIN, {
      tenantId: TENANT,
      channel: "email",
      allowed: true,
      monthlyFeeCents: 12_000,
    });
    expect(fake.db.rows("tenant_own_provider_grants")).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        channel: "email",
        allowed: true,
        monthly_fee_cents: 12_000,
        granted_by: ADMIN.userId,
        revoked_at: null,
        pending_decision: false,
      }),
    ]);
    expect(tenantAudits()).toEqual([
      expect.objectContaining({ tenant_id: TENANT, action: "own_provider.grant", actor_user_id: ADMIN.userId }),
    ]);
    expect(audit.calls).toEqual([
      expect.objectContaining({ action: "own_provider.grant", tenantId: TENANT }),
    ]);
  });

  it("revoking an active grant disables the house's account and marks pending_decision", async () => {
    await ownedAccount();
    grant();
    link();
    await adminSetOwnProviderGrantFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      allowed: false,
      monthlyFeeCents: 5000,
    });
    expect(fake.db.rows("tenant_own_provider_grants")[0]).toMatchObject({
      allowed: false,
      revoked_by: ADMIN.userId,
      pending_decision: true,
    });
    expect(fake.db.rows("tenant_own_provider_grants")[0].revoked_at).toBeTruthy();
    expect(fake.db.rows("provider_accounts").find((r) => r.id === OWNED)).toMatchObject({
      status: "disabled",
    });
    // The link stays (the channel pauses; nothing falls back to BetLeads).
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(1);
    expect(tenantAudits().map((r) => r.action)).toEqual(["own_provider.revoke"]);
    expect(JSON.stringify(tenantAudits())).not.toContain(SECRET);
  });

  it("granting again clears revoked_at/by and pending_decision but does not reactivate the account", async () => {
    await ownedAccount({ status: "disabled" });
    grant({
      allowed: false,
      revoked_at: "2026-11-05T00:00:00Z",
      revoked_by: ADMIN.userId,
      pending_decision: true,
    });
    await adminSetOwnProviderGrantFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      allowed: true,
      monthlyFeeCents: 6000,
    });
    expect(fake.db.rows("tenant_own_provider_grants")[0]).toMatchObject({
      allowed: true,
      monthly_fee_cents: 6000,
      revoked_at: null,
      revoked_by: null,
      pending_decision: false,
    });
    expect(fake.db.rows("provider_accounts")[0].status).toBe("disabled");
  });
});

describe("adminResolveRevokedOwnProviderFor", () => {
  beforeEach(async () => {
    await ownedAccount({ status: "disabled" });
    grant({ allowed: false, revoked_at: "2026-11-05T00:00:00Z", pending_decision: true });
    link();
  });

  it("use_default removes the house's link and clears pending_decision", async () => {
    await adminResolveRevokedOwnProviderFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      action: "use_default",
    });
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
    expect(fake.db.rows("tenant_own_provider_grants")[0].pending_decision).toBe(false);
    expect(tenantAudits().map((r) => r.action)).toEqual(["own_provider.resolve"]);
  });

  it("keep_paused keeps the link and clears pending_decision", async () => {
    await adminResolveRevokedOwnProviderFor(ADMIN, {
      tenantId: TENANT,
      channel: "sms",
      action: "keep_paused",
    });
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(1);
    expect(fake.db.rows("tenant_own_provider_grants")[0].pending_decision).toBe(false);
  });

  it("use_default on e-mail moves the house's domains back", async () => {
    fake.db.rows("tenant_own_provider_grants")[0].channel = "email";
    fake.db.rows("tenant_channel_providers")[0].channel = "email";
    fake.db.rows("tenant_domains").push({
      id: "d1",
      tenant_id: TENANT,
      hostname: "mail.casa.com",
      kind: "email",
      removed_at: null,
      provider_account_id: OWNED,
    });
    domains.refreshTenantDomain.mockResolvedValue({
      hostname: "mail.casa.com",
      status: "pending",
      last_error: null,
    });
    await adminResolveRevokedOwnProviderFor(ADMIN, {
      tenantId: TENANT,
      channel: "email",
      action: "use_default",
    });
    expect(domains.refreshTenantDomain).toHaveBeenCalledWith("d1", { requestVerify: true });
  });

  it("refuses when nothing is pending", async () => {
    fake.db.rows("tenant_own_provider_grants")[0].pending_decision = false;
    await expect(
      adminResolveRevokedOwnProviderFor(ADMIN, { tenantId: TENANT, channel: "sms", action: "use_default" }),
    ).rejects.toThrow();
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(1);
  });
});

describe("adminListOwnProviderGrantsFor", () => {
  it("lists grants with the house's account and whether it is active, never credentials", async () => {
    await ownedAccount();
    grant();
    grant({ channel: "voice", allowed: false, monthly_fee_cents: 0 });
    link();
    fake.db.rows("sms_send_logs").push({
      tenant_id: TENANT,
      provider_account_id: OWNED,
      status: "sent",
      created_at: new Date().toISOString(),
    });
    const list = await adminListOwnProviderGrantsFor(ADMIN);
    const sms = list.find((g) => g.channel === "sms")!;
    expect(sms).toMatchObject({
      tenantId: TENANT,
      allowed: true,
      monthlyFeeCents: 5000,
      pendingDecision: false,
      active: true,
      account: {
        id: OWNED,
        provider: "infobip",
        label: "Infobip da Casa Um",
        status: "active",
        lastCallbackAt: "2026-11-06T10:00:00Z",
      },
    });
    expect(sms.account!.lastAcceptedSendAt).toBeTruthy();
    expect(list.find((g) => g.channel === "voice")).toMatchObject({ account: null, active: false });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    await expect(adminListOwnProviderGrantsFor(NOT_ADMIN)).rejects.toThrow(/plataforma/);
  });
});

describe("super admin account functions refuse owned accounts", () => {
  beforeEach(async () => {
    await ownedAccount();
  });

  it("save", async () => {
    await expect(
      adminSaveProviderAccountFor(
        ADMIN,
        saveProviderAccountInput.parse({
          id: OWNED,
          provider: "infobip",
          label: "trocada",
          channels: ["sms"],
          config: { base_url: "https://x.api.infobip.com" },
          credentials: { api_key: "nova" },
        }),
      ),
    ).rejects.toThrow(OWNED_MESSAGE);
    expect(fake.db.rows("provider_accounts")[0].label).toBe("Infobip da Casa Um");
  });

  it("test never calls the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(adminTestProviderAccountFor(ADMIN, { id: OWNED })).rejects.toThrow(OWNED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delete", async () => {
    await expect(adminDeleteProviderAccountFor(ADMIN, { id: OWNED })).rejects.toThrow(OWNED_MESSAGE);
    expect(fake.db.rows("provider_accounts")).toHaveLength(1);
  });

  it("setTenantChannelProvider to or away from an owned account", async () => {
    await expect(
      adminSetTenantChannelProviderFor(ADMIN, { tenantId: TENANT, channel: "sms", accountId: OWNED }),
    ).rejects.toThrow(OWNED_MESSAGE);
    link();
    await expect(
      adminSetTenantChannelProviderFor(ADMIN, { tenantId: TENANT, channel: "sms", accountId: null }),
    ).rejects.toThrow(OWNED_MESSAGE);
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(1);
  });

  it("status: the super admin may disable an owned account (audited for the house) but not re-enable it", async () => {
    await adminSetProviderAccountStatusFor(ADMIN, { id: OWNED, status: "disabled" });
    expect(fake.db.rows("provider_accounts")[0].status).toBe("disabled");
    expect(tenantAudits()).toEqual([expect.objectContaining({ tenant_id: TENANT })]);
    await expect(
      adminSetProviderAccountStatusFor(ADMIN, { id: OWNED, status: "active" }),
    ).rejects.toThrow(OWNED_MESSAGE);
    expect(fake.db.rows("provider_accounts")[0].status).toBe("disabled");
  });

  it("the listing marks ownerTenantId and carries no credential hint for owned accounts", async () => {
    const listing = await adminListProviderAccountsFor(ADMIN);
    const view = listing.accounts.find((a) => a.id === OWNED)!;
    expect(view.ownerTenantId).toBe(TENANT);
    expect(view.credentialHints).toEqual({});
    expect(JSON.stringify(listing)).not.toContain("9876");
    expect(JSON.stringify(listing)).not.toContain(SECRET);
  });
});
