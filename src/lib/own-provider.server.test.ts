// Conta própria de provedor: funções da casa (admin da casa). Review Focus 2:
// o super admin "entrando como a casa" é recusado — só uma linha `admin` em
// user_roles daquela casa abre estas funções.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }));
const domains = vi.hoisted(() => ({ refreshTenantDomain: vi.fn() }));
const auth = vi.hoisted(() => ({
  users: new Map<string, string>(),
  passwords: new Map<string, string>(),
  signIns: [] as string[],
  signOuts: 0,
  /** Runs inside signInWithPassword (simulates a change between read and write). */
  onSignIn: null as null | (() => void),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.db.client,
      auth: {
        admin: {
          getUserById: async (id: string) => {
            const email = auth.users.get(id);
            return email
              ? { data: { user: { id, email } }, error: null }
              : { data: { user: null }, error: { message: "User not found" } };
          },
        },
      },
    },
  };
});
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        auth.signIns.push(email);
        auth.onSignIn?.();
        return auth.passwords.get(email) === password
          ? { data: { session: { access_token: "t" }, user: { email } }, error: null }
          : { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
      },
      signOut: async () => {
        auth.signOuts++;
        return { error: null };
      },
    },
  }),
}));
vi.mock("@/lib/admin-audit.server", () => ({ auditAdminAction: vi.fn(async () => {}) }));
vi.mock("@/lib/platform-email.server", () => ({
  sendPlatformEmail: vi.fn(async (input: { to: string; subject: string; html: string }) => {
    emails.sent.push(input);
  }),
}));
vi.mock("@/lib/tenant-domains.server", () => ({
  refreshTenantDomain: domains.refreshTenantDomain,
}));

import {
  activateOwnProviderFor,
  deactivateOwnProviderFor,
  getOwnProviderStateFor,
  removeOwnProviderAccountFor,
  requireHouseAdmin,
  requirePasswordReauth,
  saveOwnProviderAccountFor,
  testOwnProviderAccountFor,
} from "./own-provider.server";
import { __resetCallbackTokensForTests } from "./provider-callback-tokens.server";
import { __resetProviderAccountsCacheForTests } from "./provider-accounts.server";
import { saveOwnProviderAccountInput } from "./own-provider.shared";
import { decryptProviderCredentials } from "./secret-box.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const HOUSE_ADMIN = "00000000-0000-4000-8000-00000000000a";
const OTHER_ADMIN = "00000000-0000-4000-8000-00000000000b";
const GESTOR = "00000000-0000-4000-8000-00000000000c";
const SUPER = "00000000-0000-4000-8000-0000000000ad";
const PASSWORD = "senha-certa";
const SECRET = "segredo-da-casa-4321";

const ctx = (userId = HOUSE_ADMIN, tenantId = TENANT) => ({ userId, tenantId });

const save = (data: Record<string, unknown>, context = ctx()) =>
  saveOwnProviderAccountFor(context, saveOwnProviderAccountInput.parse({ password: PASSWORD, ...data }));

const infobipSms = {
  channel: "sms",
  provider: "infobip",
  label: "Infobip da casa",
  config: { base_url: "https://casa.api.infobip.com", sms_from: "CasaUm" },
  credentials: { api_key: SECRET },
  ownUnitCost: 0.045,
};

function grant(channel = "sms", overrides: Record<string, unknown> = {}) {
  fake.db.rows("tenant_own_provider_grants").push({
    tenant_id: TENANT,
    channel,
    allowed: true,
    monthly_fee_cents: 5000,
    revoked_at: null,
    pending_decision: false,
    ...overrides,
  });
}

const owned = () => fake.db.rows("provider_accounts").filter((r) => r.owner_tenant_id === TENANT);
const tenantAudits = () => fake.db.rows("tenant_audit_logs");

beforeEach(() => {
  fake.db.reset();
  emails.sent = [];
  domains.refreshTenantDomain.mockReset();
  auth.users = new Map([
    [HOUSE_ADMIN, "admin@casa.com"],
    [OTHER_ADMIN, "outro@casa.com"],
    [GESTOR, "gestor@casa.com"],
    [SUPER, "super@betleads.io"],
  ]);
  auth.passwords = new Map([
    ["admin@casa.com", PASSWORD],
    ["super@betleads.io", PASSWORD],
  ]);
  auth.signIns = [];
  auth.signOuts = 0;
  auth.onSignIn = null;
  __resetProviderAccountsCacheForTests();
  __resetCallbackTokensForTests();
  fake.db.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER, error: null }));
  fake.db.onRpc("is_tenant_admin", () => ({ data: true, error: null }));
  fake.db.rows("tenants").push({ id: TENANT, nome: "Casa Um" }, { id: OTHER_TENANT, nome: "Casa Dois" });
  fake.db.rows("user_roles").push(
    { user_id: HOUSE_ADMIN, tenant_id: TENANT, role: "admin" },
    { user_id: OTHER_ADMIN, tenant_id: TENANT, role: "admin" },
    { user_id: GESTOR, tenant_id: TENANT, role: "gestor" },
    // Admin of another house: never e-mailed about this one.
    { user_id: SUPER, tenant_id: OTHER_TENANT, role: "admin" },
  );
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "anon-key");
  vi.stubEnv("PUBLIC_APP_URL", "https://app.betleads.io");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("requireHouseAdmin / requirePasswordReauth", () => {
  it("only a user_roles admin row of that house passes", async () => {
    await expect(requireHouseAdmin(HOUSE_ADMIN, TENANT)).resolves.toBeUndefined();
    await expect(requireHouseAdmin(GESTOR, TENANT)).rejects.toThrow("Só o admin da casa pode fazer isso.");
    // Super admin (is_tenant_admin is true for it) without an admin row here.
    await expect(requireHouseAdmin(SUPER, TENANT)).rejects.toThrow("Só o admin da casa pode fazer isso.");
    await expect(requireHouseAdmin(HOUSE_ADMIN, OTHER_TENANT)).rejects.toThrow(
      "Só o admin da casa pode fazer isso.",
    );
  });

  it("wrong password is refused; a successful sign-in is signed out right away", async () => {
    await expect(requirePasswordReauth("admin@casa.com", "errada")).rejects.toThrow("Senha incorreta.");
    await expect(requirePasswordReauth("admin@casa.com", PASSWORD)).resolves.toBeUndefined();
    expect(auth.signOuts).toBe(1);
  });

  it("falls back to VITE_SUPABASE_PUBLISHABLE_KEY", async () => {
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", undefined);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-key");
    await expect(requirePasswordReauth("admin@casa.com", PASSWORD)).resolves.toBeUndefined();
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", undefined);
    await expect(requirePasswordReauth("admin@casa.com", PASSWORD)).rejects.toThrow(
      "Não foi possível confirmar a senha agora.",
    );
  });
});

describe("authorization of every house function (Review Focus 2)", () => {
  beforeEach(() => grant());

  it("super admin without an admin row, and a gestor, are refused; nothing is written", async () => {
    for (const userId of [SUPER, GESTOR]) {
      await expect(save(infobipSms, ctx(userId))).rejects.toThrow("Só o admin da casa pode fazer isso.");
      await expect(getOwnProviderStateFor(ctx(userId))).rejects.toThrow("Só o admin da casa pode fazer isso.");
      await expect(testOwnProviderAccountFor(ctx(userId), { channel: "sms" })).rejects.toThrow(
        "Só o admin da casa pode fazer isso.",
      );
      await expect(
        activateOwnProviderFor(ctx(userId), { channel: "sms", password: PASSWORD }),
      ).rejects.toThrow("Só o admin da casa pode fazer isso.");
      await expect(deactivateOwnProviderFor(ctx(userId), { channel: "sms" })).rejects.toThrow(
        "Só o admin da casa pode fazer isso.",
      );
      await expect(
        removeOwnProviderAccountFor(ctx(userId), { channel: "sms", password: PASSWORD }),
      ).rejects.toThrow("Só o admin da casa pode fazer isso.");
    }
    expect(fake.db.rows("provider_accounts")).toHaveLength(0);
    expect(tenantAudits()).toHaveLength(0);
    expect(auth.signIns).toHaveLength(0);
  });

  it("a channel without an allowed grant is refused", async () => {
    await expect(save({ ...infobipSms, channel: "voice" })).rejects.toThrow(/não liberada/);
    fake.db.rows("tenant_own_provider_grants")[0].allowed = false;
    await expect(save(infobipSms)).rejects.toThrow(/não liberada/);
    expect(owned()).toHaveLength(0);
  });

  it("wrong password: 'Senha incorreta.' and nothing is written", async () => {
    await expect(save({ ...infobipSms, password: "errada" })).rejects.toThrow("Senha incorreta.");
    expect(owned()).toHaveLength(0);
    expect(tenantAudits()).toHaveLength(0);
    expect(emails.sent).toHaveLength(0);
  });

  it("a provider the channel does not support is refused", async () => {
    grant("email");
    await expect(
      save({ channel: "email", provider: "short_brasil", label: "x", credentials: { shortcode_token: "t" } }),
    ).rejects.toThrow(/não atende/);
  });
});

describe("saveOwnProviderAccountFor", () => {
  beforeEach(() => grant());

  it("creates the house's account (db credentials, one channel, owner) and never returns the secret", async () => {
    const result = await save(infobipSms);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const [row] = owned();
    expect(row).toMatchObject({
      provider: "infobip",
      channels: ["sms"],
      credentials_source: "db",
      owner_tenant_id: TENANT,
      own_unit_cost: 0.045,
      config: { base_url: "https://casa.api.infobip.com", sms_from: "CasaUm" },
    });
    expect(row.callback_token_encrypted).toBeTruthy();
    expect(await decryptProviderCredentials(String(row.credentials_encrypted))).toEqual({ api_key: SECRET });
    expect(tenantAudits().map((r) => r.action)).toEqual(["own_provider.save"]);
    expect(JSON.stringify(tenantAudits())).not.toContain(SECRET);

    const state = await getOwnProviderStateFor(ctx());
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(state).toEqual([
      expect.objectContaining({
        channel: "sms",
        monthlyFeeCents: 5000,
        usingOwnAccount: false,
        callbackUrl: null,
        account: expect.objectContaining({
          provider: "infobip",
          ownUnitCost: 0.045,
          smsFrom: "CasaUm",
          baseUrl: "https://casa.api.infobip.com",
          credentialsSet: ["api_key"],
        }),
      }),
    ]);
  });

  it("a blank field keeps the stored value", async () => {
    await save({ ...infobipSms, channel: "sms" });
    await save({ ...infobipSms, label: "Renomeada", credentials: {}, ownUnitCost: undefined });
    const [row] = owned();
    expect(owned()).toHaveLength(1);
    expect(row.label).toBe("Renomeada");
    expect(row.own_unit_cost).toBe(0.045);
    expect(await decryptProviderCredentials(String(row.credentials_encrypted))).toEqual({ api_key: SECRET });
  });

  it("switching the provider of an existing account is refused", async () => {
    await save(infobipSms);
    await expect(
      save({ channel: "sms", provider: "short_brasil", label: "x", credentials: { shortcode_token: "t" } }),
    ).rejects.toThrow("Não é possível trocar o provedor de uma conta existente.");
    expect(owned()[0].provider).toBe("infobip");
  });

  it("Short Brasil: no URL is accepted; the state has the callback URL with the account token", async () => {
    await save({
      channel: "sms",
      provider: "short_brasil",
      label: "Short da casa",
      config: { shortcode_url: "https://evil.example.com" },
      credentials: { shortcode_token: SECRET },
    });
    expect(owned()[0].config).toEqual({});
    const [state] = await getOwnProviderStateFor(ctx());
    const { token } = await decryptProviderCredentials(String(owned()[0].callback_token_encrypted));
    expect(token).toMatch(/^pa_/);
    expect(state.callbackUrl).toBe(
      `https://app.betleads.io/api/public/sms-webhook?token=${encodeURIComponent(token)}`,
    );
    expect(state.account!.credentialsSet).toEqual(["shortcode_token"]);
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it("e-mails the other admins of the house, never the actor nor other houses", async () => {
    await save(infobipSms);
    expect(emails.sent.map((e) => e.to)).toEqual(["outro@casa.com"]);
    expect(emails.sent[0].subject).toBe("Conta de provedor alterada na sua casa");
    expect(emails.sent[0].html).not.toContain(SECRET);
  });

  it("a concurrent create (unique violation) becomes a reload message", async () => {
    fake.db.failNext("provider_accounts", "insert", "duplicate key value", "23505");
    await expect(save(infobipSms)).rejects.toThrow(
      "Já existe uma conta para este canal. Recarregue a página.",
    );
  });

  it("an e-mail failure does not fail the save", async () => {
    const { sendPlatformEmail } = await import("@/lib/platform-email.server");
    vi.mocked(sendPlatformEmail).mockRejectedValueOnce(new Error("infobip fora"));
    await expect(save(infobipSms)).resolves.toMatchObject({ id: expect.any(String) });
    expect(owned()).toHaveLength(1);
  });
});

describe("getOwnProviderStateFor after a revocation", () => {
  it("shows the paused channel (revoked, pendingDecision) while the house still has the account/link", async () => {
    grant();
    const { id } = await save(infobipSms);
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    Object.assign(fake.db.rows("tenant_own_provider_grants")[0], { allowed: false, pending_decision: true });
    owned()[0].status = "disabled";
    owned()[0].disabled_reason = "revoked";
    const [state] = await getOwnProviderStateFor(ctx());
    expect(state).toMatchObject({
      channel: "sms",
      revoked: true,
      pendingDecision: true,
      usingOwnAccount: true,
      account: { id, status: "disabled", disabledReason: "revoked" },
    });
    // And the house can go back to the BetLeads route on its own.
    await deactivateOwnProviderFor(ctx(), { channel: "sms" });
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
  });

  it("hides a revoked channel where the house never registered an account; allowed ones say revoked: false", async () => {
    grant("sms", { allowed: false, pending_decision: true });
    grant("email");
    const state = await getOwnProviderStateFor(ctx());
    expect(state).toEqual([
      expect.objectContaining({ channel: "email", revoked: false, pendingDecision: false, account: null }),
    ]);
  });
});

describe("testOwnProviderAccountFor", () => {
  beforeEach(() => grant());

  it("runs the same test as the admin (generic failure, no raw status)", async () => {
    await save(infobipSms);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const result = await testOwnProviderAccountFor(ctx(), { channel: "sms" });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("401");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ balance: 12.5, currency: "BRL" })),
    );
    expect(await testOwnProviderAccountFor(ctx(), { channel: "sms" })).toMatchObject({ ok: true });
  });

  it("refuses when the house has no account in the channel", async () => {
    await expect(testOwnProviderAccountFor(ctx(), { channel: "sms" })).rejects.toThrow(/Cadastre/);
  });
});

describe("activate / deactivate / remove", () => {
  beforeEach(() => grant());

  it("activate writes the link, audits and e-mails the other admins", async () => {
    const { id } = await save(infobipSms);
    emails.sent = [];
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    expect(fake.db.rows("tenant_channel_providers")).toEqual([
      expect.objectContaining({ tenant_id: TENANT, channel: "sms", provider_account_id: id }),
    ]);
    expect(tenantAudits().map((r) => r.action)).toEqual(["own_provider.save", "own_provider.activate"]);
    expect(emails.sent.map((e) => e.to)).toEqual(["outro@casa.com"]);
    const [state] = await getOwnProviderStateFor(ctx());
    expect(state.usingOwnAccount).toBe(true);
  });

  it("activate with a wrong password writes nothing", async () => {
    await save(infobipSms);
    await expect(activateOwnProviderFor(ctx(), { channel: "sms", password: "x" })).rejects.toThrow(
      "Senha incorreta.",
    );
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
  });

  it("activate re-enables an account disabled by a revocation once the grant is back", async () => {
    await save(infobipSms);
    owned()[0].status = "disabled";
    owned()[0].disabled_reason = "revoked";
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    expect(owned()[0]).toMatchObject({ status: "active", disabled_reason: null });
  });

  it("an account the BetLeads disabled: activate, save and test refuse; nothing changes", async () => {
    await save(infobipSms);
    owned()[0].status = "disabled";
    owned()[0].disabled_reason = "platform";
    const message = "Esta conta foi desativada pela BetLeads. Fale com o suporte.";
    await expect(activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD })).rejects.toThrow(
      message,
    );
    await expect(save({ ...infobipSms, label: "outra" })).rejects.toThrow(message);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(testOwnProviderAccountFor(ctx(), { channel: "sms" })).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(owned()[0]).toMatchObject({ status: "disabled", label: "Infobip da casa" });
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
  });

  it("a disabled account with no recorded reason is treated like 'platform' (activate, save, test)", async () => {
    await save(infobipSms);
    owned()[0].status = "disabled";
    await expect(activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD })).rejects.toThrow(
      /desativada pela BetLeads/,
    );
    await expect(save({ ...infobipSms, label: "outra" })).rejects.toThrow(/desativada pela BetLeads/);
    await expect(testOwnProviderAccountFor(ctx(), { channel: "sms" })).rejects.toThrow(
      /desativada pela BetLeads/,
    );
  });

  it("a 'platform' disable cannot be bypassed by deactivate → remove → save → activate", async () => {
    const { id } = await save(infobipSms);
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    owned()[0].status = "disabled";
    owned()[0].disabled_reason = "platform";

    // Going back to the BetLeads route stays allowed.
    await deactivateOwnProviderFor(ctx(), { channel: "sms" });
    await expect(
      removeOwnProviderAccountFor(ctx(), { channel: "sms", password: PASSWORD }),
    ).rejects.toThrow("Esta conta foi desativada pela BetLeads. Fale com o suporte.");
    await expect(save({ ...infobipSms, label: "nova" })).rejects.toThrow(/desativada pela BetLeads/);
    await expect(activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD })).rejects.toThrow(
      /desativada pela BetLeads/,
    );
    expect(owned()).toEqual([expect.objectContaining({ id, status: "disabled", disabled_reason: "platform" })]);
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
  });

  it("activate refuses when the reactivation matches no row (reason changed meanwhile): no link, no audit, no e-mail", async () => {
    await save(infobipSms);
    owned()[0].status = "disabled";
    owned()[0].disabled_reason = "revoked";
    emails.sent = [];
    auth.onSignIn = () => {
      owned()[0].disabled_reason = "platform";
    };
    await expect(activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD })).rejects.toThrow(
      /desativada pela BetLeads/,
    );
    expect(owned()[0].status).toBe("disabled");
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
    expect(tenantAudits().map((r) => r.action)).toEqual(["own_provider.save"]);
    expect(emails.sent).toHaveLength(0);
  });

  it("activate on e-mail refreshes the house's e-mail domains", async () => {
    grant("email");
    await save({ ...infobipSms, channel: "email", config: { base_url: "https://casa.api.infobip.com" } });
    fake.db.rows("tenant_domains").push({
      id: "d1",
      tenant_id: TENANT,
      hostname: "mail.casa.com",
      kind: "email",
      removed_at: null,
      provider_account_id: null,
    });
    domains.refreshTenantDomain.mockResolvedValue({ hostname: "mail.casa.com", status: "pending", last_error: null });
    const result = await activateOwnProviderFor(ctx(), { channel: "email", password: PASSWORD });
    expect(domains.refreshTenantDomain).toHaveBeenCalledWith("d1", { requestVerify: true });
    expect(result.emailDomains).toEqual([{ hostname: "mail.casa.com", status: "pending", error: null }]);
  });

  it("deactivate removes only the house's own link, even without a grant", async () => {
    await save(infobipSms);
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    fake.db.rows("tenant_own_provider_grants")[0].allowed = false;
    await deactivateOwnProviderFor(ctx(), { channel: "sms" });
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(0);
    expect(tenantAudits().at(-1)!.action).toBe("own_provider.deactivate");
  });

  it("deactivate never removes a platform account the super admin linked", async () => {
    fake.db.rows("tenant_channel_providers").push({
      tenant_id: TENANT,
      channel: "sms",
      provider_account_id: "77777777-7777-4777-8777-777777777777",
    });
    await expect(deactivateOwnProviderFor(ctx(), { channel: "sms" })).rejects.toThrow();
    expect(fake.db.rows("tenant_channel_providers")).toHaveLength(1);
  });

  it("remove refuses an active account, then deletes it once inactive", async () => {
    await save(infobipSms);
    await activateOwnProviderFor(ctx(), { channel: "sms", password: PASSWORD });
    await expect(
      removeOwnProviderAccountFor(ctx(), { channel: "sms", password: PASSWORD }),
    ).rejects.toThrow(/Volte para a rota da BetLeads/);
    await deactivateOwnProviderFor(ctx(), { channel: "sms" });
    emails.sent = [];
    await removeOwnProviderAccountFor(ctx(), { channel: "sms", password: PASSWORD });
    expect(owned()).toHaveLength(0);
    expect(tenantAudits().at(-1)!.action).toBe("own_provider.remove");
    expect(emails.sent.map((e) => e.to)).toEqual(["outro@casa.com"]);
  });
});
