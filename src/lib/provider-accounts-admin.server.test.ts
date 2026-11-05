// Provedores por casa (Fase 3): super admin management of provider accounts
// and of each house's account per channel.
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
  adminDeleteProviderAccountFor,
  adminListProviderAccountsFor,
  adminSaveProviderAccountFor,
  adminSetPlatformDefaultFor,
  adminSetProviderAccountStatusFor,
  adminSetTenantChannelProviderFor,
  adminTestProviderAccountFor,
} from "./provider-accounts-admin.server";
import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_ONESIGNAL_ACCOUNT_ID,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  resolveOneSignalAccount,
} from "./provider-accounts.server";
import { saveProviderAccountInput } from "./provider-accounts.shared";
import { decryptProviderCredentials, encryptProviderCredentials } from "./secret-box.server";

const ADMIN = { userId: "00000000-0000-4000-8000-0000000000ad" };
const NOT_ADMIN = { userId: "00000000-0000-4000-8000-0000000000ee" };
const TENANT = "00000000-0000-4000-8000-000000000001";
const OWN = "55555555-5555-4555-8555-555555555555";

function platformAccounts() {
  fake.db.rows("provider_accounts").push(
    {
      id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
      provider: "short_brasil",
      label: "Short Brasil (padrão)",
      channels: ["sms"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
      status: "active",
      created_at: "2026-10-28T00:00:00Z",
    },
    {
      id: DEFAULT_INFOBIP_ACCOUNT_ID,
      provider: "infobip",
      label: "Infobip (padrão)",
      channels: ["email", "voice"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
      status: "active",
      created_at: "2026-10-28T00:00:01Z",
    },
    {
      id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
      provider: "onesignal",
      label: "OneSignal (padrão)",
      channels: ["webpush"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
      status: "active",
      created_at: "2026-10-28T00:00:02Z",
    },
  );
}

const save = (data: Record<string, unknown>) =>
  adminSaveProviderAccountFor(ADMIN, saveProviderAccountInput.parse(data));

/** The fake DB generates non-UUID ids; give the new row a real one. */
async function create(data: Record<string, unknown>, uuid: string) {
  const { id } = await save(data);
  fake.db.rows("provider_accounts").find((r) => r.id === id)!.id = uuid;
  return uuid;
}

beforeEach(() => {
  fake.db.reset();
  audit.calls = [];
  domains.refreshTenantDomain.mockReset();
  __resetProviderAccountsCacheForTests();
  fake.db.onRpc("is_super_admin", (args) => ({
    data: args._user_id === ADMIN.userId,
    error: null,
  }));
  fake.db.rows("tenants").push({ id: TENANT, nome: "Casa Um" });
  platformAccounts();
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  vi.stubEnv("INFOBIP_API_KEY", "platform-infobip-key");
  vi.stubEnv("INFOBIP_BASE_URL", "https://platform.api.infobip.test");
});

afterEach(() => vi.unstubAllEnvs());

describe("provider accounts admin", () => {
  it("only the super admin gets in", async () => {
    await expect(adminListProviderAccountsFor(NOT_ADMIN)).rejects.toThrow(/plataforma/);
    await expect(
      adminSetTenantChannelProviderFor(NOT_ADMIN, {
        tenantId: TENANT,
        channel: "sms",
        accountId: null,
      }),
    ).rejects.toThrow();
  });

  it("creates an account with encrypted credentials; the listing only shows masked hints", async () => {
    const { id } = await save({
      provider: "infobip",
      label: "Infobip Casa Um",
      channels: ["email", "voice"],
      config: { base_url: "https://own.api.infobip.test", voice_from: "+55 (11) 3000-0000" },
      credentials: { api_key: "segredo-da-casa-1234" },
    });

    const row = fake.db.rows("provider_accounts").find((r) => r.id === id)!;
    expect(row).toMatchObject({
      credentials_source: "db",
      status: "active",
      config: { voice_from: "551130000000" },
    });
    expect(JSON.stringify(row)).not.toContain("segredo-da-casa");
    expect(await decryptProviderCredentials(String(row.credentials_encrypted))).toEqual({
      api_key: "segredo-da-casa-1234",
    });
    expect(JSON.stringify(audit.calls)).not.toContain("segredo-da-casa");

    const listing = await adminListProviderAccountsFor(ADMIN);
    const view = listing.accounts.find((a) => a.id === id)!;
    expect(view).toMatchObject({ configured: true, credentialHints: { api_key: "••••1234" } });
    expect(JSON.stringify(listing)).not.toContain("segredo-da-casa");
    expect(JSON.stringify(listing)).not.toContain("platform-infobip-key");
    expect(listing.tenants).toEqual([
      {
        id: TENANT,
        nome: "Casa Um",
        accounts: { sms: null, email: null, voice: null, webpush: null },
        channels: { sms: true, email: true, voice: true, webpush: false },
      },
    ]);
  });

  it("an Infobip account can send SMS, with an optional sender", async () => {
    const { id } = await save({
      provider: "infobip",
      label: "Infobip SMS",
      channels: ["sms"],
      config: { base_url: "https://a.test", sms_from: "CasaUm" },
      credentials: { api_key: "k" },
    });
    expect(fake.db.rows("provider_accounts").find((r) => r.id === id)).toMatchObject({
      channels: ["sms"],
      config: { base_url: "https://a.test", sms_from: "CasaUm" },
    });
  });

  it("rejects unsupported channels and missing credentials", async () => {
    await expect(
      save({
        provider: "short_brasil",
        label: "x",
        channels: ["email"],
        credentials: { usuario: "u", chave: "c" },
      }),
    ).rejects.toThrow(/só atende SMS/);
    await expect(
      save({
        provider: "short_brasil",
        label: "x",
        channels: ["sms"],
        credentials: { usuario: "só usuário" },
      }),
    ).rejects.toThrow(/token da API Short Code/);
    await expect(
      save({
        provider: "infobip",
        label: "x",
        channels: ["voice"],
        config: { base_url: "https://a.test" },
        credentials: { api_key: "k" },
      }),
    ).rejects.toThrow(/número de origem/);
  });

  it("an env account's save only changes label and channels; credentials and credentials_source stay intact", async () => {
    const before = fake.db.rows("provider_accounts").find((r) => r.id === DEFAULT_INFOBIP_ACCOUNT_ID)!;
    expect(before.credentials_source).toBe("env");

    const { id } = await save({
      id: DEFAULT_INFOBIP_ACCOUNT_ID,
      provider: "infobip",
      label: "Infobip (ambiente)",
      channels: ["email"],
      config: { base_url: "https://attempted.test" },
      credentials: { api_key: "attempted-key" },
    });
    expect(id).toBe(DEFAULT_INFOBIP_ACCOUNT_ID);

    const after = fake.db.rows("provider_accounts").find((r) => r.id === DEFAULT_INFOBIP_ACCOUNT_ID)!;
    expect(after).toMatchObject({
      label: "Infobip (ambiente)",
      channels: ["email"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
    });

    const listing = await adminListProviderAccountsFor(ADMIN);
    const view = listing.accounts.find((a) => a.id === DEFAULT_INFOBIP_ACCOUNT_ID)!;
    expect(view.envAccount).toBe(true);
    expect(JSON.stringify(view)).not.toContain("attempted-key");
  });

  it("refuses to remove a channel from an env account that a house still uses", async () => {
    fake.db
      .rows("tenant_channel_providers")
      .push({ tenant_id: TENANT, channel: "voice", provider_account_id: DEFAULT_INFOBIP_ACCOUNT_ID });
    await expect(
      save({
        id: DEFAULT_INFOBIP_ACCOUNT_ID,
        provider: "infobip",
        label: "Infobip (ambiente)",
        channels: ["email"],
      }),
    ).rejects.toThrow(/Há casas usando esta conta/);
  });

  it("editing keeps credentials left blank and refuses to drop a channel a house still uses", async () => {
    const id = await create(
      {
        provider: "short_brasil",
        label: "Short Casa Um",
        channels: ["sms"],
        credentials: { usuario: "user-1", chave: "chave-1" },
      },
      "66666666-6666-4666-8666-666666666666",
    );
    await save({
      id,
      provider: "short_brasil",
      label: "Short Casa Um (novo nome)",
      channels: ["sms"],
      credentials: { chave: "chave-2" },
    });
    const row = fake.db.rows("provider_accounts").find((r) => r.id === id)!;
    expect(row.label).toBe("Short Casa Um (novo nome)");
    expect(await decryptProviderCredentials(String(row.credentials_encrypted))).toEqual({
      usuario: "user-1",
      chave: "chave-2",
    });

    const infobip = await create(
      {
        provider: "infobip",
        label: "Infobip Casa Um",
        channels: ["email", "voice"],
        config: { base_url: "https://own.api.infobip.test", voice_from: "5511300000000" },
        credentials: { api_key: "k-1" },
      },
      "77777777-7777-4777-8777-777777777777",
    );
    fake.db
      .rows("tenant_channel_providers")
      .push({ tenant_id: TENANT, channel: "voice", provider_account_id: infobip });
    await expect(
      save({
        id: infobip,
        provider: "infobip",
        label: "Infobip Casa Um",
        channels: ["email"],
        config: { base_url: "https://own.api.infobip.test" },
      }),
    ).rejects.toThrow(/Há casas usando esta conta/);
  });

  describe("a house's account per channel", () => {
    async function ownInfobip(status = "active") {
      fake.db.rows("provider_accounts").push({
        id: OWN,
        provider: "infobip",
        label: "Infobip Casa Um",
        channels: ["email"],
        credentials_source: "env",
        credentials_encrypted: null,
        config: {},
        status,
      });
    }

    it("assigns an account, audits it, and moves the house's e-mail domains to it", async () => {
      await ownInfobip();
      fake.db.rows("tenant_domains").push(
        {
          id: "d1",
          tenant_id: TENANT,
          kind: "email",
          hostname: "mail.casa.bet",
          removed_at: null,
        },
        {
          id: "d2",
          tenant_id: TENANT,
          kind: "shortener",
          hostname: "go.casa.bet",
          removed_at: null,
        },
        {
          id: "d3",
          tenant_id: TENANT,
          kind: "email",
          hostname: "old.casa.bet",
          removed_at: "2026-10-01T00:00:00Z",
        },
      );
      domains.refreshTenantDomain.mockResolvedValue({
        hostname: "mail.casa.bet",
        status: "pending",
        last_error: null,
      });

      const result = await adminSetTenantChannelProviderFor(ADMIN, {
        tenantId: TENANT,
        channel: "email",
        accountId: OWN,
      });

      expect(fake.db.rows("tenant_channel_providers")).toEqual([
        expect.objectContaining({ tenant_id: TENANT, channel: "email", provider_account_id: OWN }),
      ]);
      expect(domains.refreshTenantDomain).toHaveBeenCalledTimes(1);
      expect(domains.refreshTenantDomain).toHaveBeenCalledWith("d1", { requestVerify: true });
      expect(result.emailDomains).toEqual([
        { hostname: "mail.casa.bet", status: "pending", error: null },
      ]);
      expect(audit.calls.at(-1)).toMatchObject({
        action: "tenant_channel_provider.set",
        tenantId: TENANT,
        before: { channel: "email", provider_account_id: null },
        after: { channel: "email", provider_account_id: OWN },
      });
    });

    it("null (the only way back to the platform default) removes the row", async () => {
      await ownInfobip();
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: TENANT, channel: "email", provider_account_id: OWN });

      await adminSetTenantChannelProviderFor(ADMIN, {
        tenantId: TENANT,
        channel: "email",
        accountId: null,
      });

      expect(fake.db.rows("tenant_channel_providers")).toEqual([]);
    });

    it("an env account chosen explicitly is just another account (no longer normalized to null)", async () => {
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: TENANT, channel: "email", provider_account_id: OWN });
      await ownInfobip();

      await adminSetTenantChannelProviderFor(ADMIN, {
        tenantId: TENANT,
        channel: "email",
        accountId: DEFAULT_INFOBIP_ACCOUNT_ID,
      });

      expect(fake.db.rows("tenant_channel_providers")).toEqual([
        expect.objectContaining({
          tenant_id: TENANT,
          channel: "email",
          provider_account_id: DEFAULT_INFOBIP_ACCOUNT_ID,
        }),
      ]);
    });

    it("refuses a disabled account and a channel the account does not serve", async () => {
      await ownInfobip("disabled");
      await expect(
        adminSetTenantChannelProviderFor(ADMIN, {
          tenantId: TENANT,
          channel: "email",
          accountId: OWN,
        }),
      ).rejects.toThrow(/desativada/);
      fake.db.rows("provider_accounts").find((r) => r.id === OWN)!.status = "active";
      await expect(
        adminSetTenantChannelProviderFor(ADMIN, {
          tenantId: TENANT,
          channel: "sms",
          accountId: OWN,
        }),
      ).rejects.toThrow(/não atende este canal/);
      expect(fake.db.rows("tenant_channel_providers")).toEqual([]);
    });
  });

  describe("OneSignal accounts", () => {
    it("creates an account with encrypted credentials; config carries org_id, not credentials", async () => {
      const { id } = await save({
        provider: "onesignal",
        label: "OneSignal Casa Um",
        channels: ["webpush"],
        config: { org_id: "org-casa-1" },
        credentials: { org_api_key: "segredo-onesignal-1234" },
      });

      const row = fake.db.rows("provider_accounts").find((r) => r.id === id)!;
      expect(row).toMatchObject({
        credentials_source: "db",
        status: "active",
        config: { org_id: "org-casa-1" },
      });
      expect(JSON.stringify(row)).not.toContain("segredo-onesignal");
      expect(await decryptProviderCredentials(String(row.credentials_encrypted))).toEqual({
        org_api_key: "segredo-onesignal-1234",
      });

      const listing = await adminListProviderAccountsFor(ADMIN);
      const view = listing.accounts.find((a) => a.id === id)!;
      expect(view).toMatchObject({
        provider: "onesignal",
        configured: true,
        credentialHints: { org_api_key: "••••1234" },
      });
    });

    it("rejects a channel other than webpush and missing credentials", async () => {
      await expect(
        save({
          provider: "onesignal",
          label: "x",
          channels: ["sms"],
          credentials: { org_api_key: "k" },
        }),
      ).rejects.toThrow(/não atende/);
      await expect(
        save({ provider: "onesignal", label: "x", channels: ["webpush"], credentials: {} }),
      ).rejects.toThrow(/chave da organização/);
    });

    it("edits an env account's label (credentials stay in the env); cannot disable it while it is the default", async () => {
      await save({
        id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
        provider: "onesignal",
        label: "OneSignal (ambiente)",
        channels: ["webpush"],
        credentials: { org_api_key: "attempted" },
      });
      const row = fake.db.rows("provider_accounts").find((r) => r.id === DEFAULT_ONESIGNAL_ACCOUNT_ID)!;
      expect(row).toMatchObject({ label: "OneSignal (ambiente)", credentials_source: "env" });

      await expect(
        adminSetProviderAccountStatusFor(ADMIN, {
          id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
          status: "disabled",
        }),
      ).rejects.toThrow(/Esta conta é a padrão de Web push/);
    });

    it("assigns a house's webpush channel to its own account", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal Casa Um",
          channels: ["webpush"],
          config: { org_id: "org-casa-1" },
          credentials: { org_api_key: "k-1" },
        },
        "88888888-8888-4888-8888-888888888888",
      );

      await adminSetTenantChannelProviderFor(ADMIN, {
        tenantId: TENANT,
        channel: "webpush",
        accountId: id,
      });

      expect(fake.db.rows("tenant_channel_providers")).toEqual([
        expect.objectContaining({ tenant_id: TENANT, channel: "webpush", provider_account_id: id }),
      ]);
    });

    describe("adminTestProviderAccountFor", () => {
      async function ownOneSignal(status = "active") {
        const { id } = await save({
          provider: "onesignal",
          label: "OneSignal Casa Um",
          channels: ["webpush"],
          credentials: { org_api_key: "org-key-1" },
        });
        if (status !== "active") {
          fake.db.rows("provider_accounts").find((r) => r.id === id)!.status = status;
        }
        return id;
      }

      it("200 reports the key accepted", async () => {
        const id = await ownOneSignal();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("{}", { status: 200 })),
        );
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result).toEqual({ ok: true, message: "Chave da organização aceita." });
      });

      it("401/403 reports the key refused", async () => {
        const id = await ownOneSignal();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("{}", { status: 401 })),
        );
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result).toEqual({ ok: false, message: "Chave recusada pela OneSignal." });
      });

      it("other statuses report the HTTP status", async () => {
        const id = await ownOneSignal();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("{}", { status: 500 })),
        );
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result).toEqual({ ok: false, message: "A OneSignal respondeu HTTP 500." });
      });

      it("never calls the real OneSignal API when unconfigured", async () => {
        fake.db.rows("provider_accounts").push({
          id: "99999999-9999-4999-8999-999999999999",
          provider: "onesignal",
          label: "OneSignal vazia",
          channels: ["webpush"],
          credentials_source: "db",
          credentials_encrypted: await encryptProviderCredentials({}),
          config: {},
          status: "active",
        });
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = await adminTestProviderAccountFor(ADMIN, {
          id: "99999999-9999-4999-8999-999999999999",
        });
        expect(result.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("platform default per channel", () => {
    it("sets a chosen db account as the default; audits before/after; invalidates the cache", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal Betleads",
          channels: ["webpush"],
          credentials: { org_api_key: "org-key-nova" },
        },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );

      const result = await adminSetPlatformDefaultFor(ADMIN, { channel: "webpush", accountId: id });

      expect(result.emailDomains).toEqual([]);
      const listing = await adminListProviderAccountsFor(ADMIN);
      expect(listing.defaults.webpush).toBe(id);
      expect(audit.calls.at(-1)).toMatchObject({
        action: "provider_account.set_default",
        before: { channel: "webpush", provider_account_id: DEFAULT_ONESIGNAL_ACCOUNT_ID },
        after: { channel: "webpush", provider_account_id: id },
      });

      const account = await resolveOneSignalAccount(TENANT);
      expect(account.id).toBe(id);
      expect(account.orgApiKey).toBe("org-key-nova");
    });

    it("refuses a disabled account or one that does not serve the channel", async () => {
      const disabled = await create(
        {
          provider: "onesignal",
          label: "OneSignal desativada",
          channels: ["webpush"],
          credentials: { org_api_key: "k" },
        },
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      fake.db.rows("provider_accounts").find((r) => r.id === disabled)!.status = "disabled";
      await expect(
        adminSetPlatformDefaultFor(ADMIN, { channel: "webpush", accountId: disabled }),
      ).rejects.toThrow(/Esta conta está desativada\./);

      await expect(
        adminSetPlatformDefaultFor(ADMIN, { channel: "voice", accountId: DEFAULT_SHORT_BRASIL_ACCOUNT_ID }),
      ).rejects.toThrow(/Esta conta não atende este canal\./);
    });

    it("switching the e-mail default moves domains of houses without their own account only", async () => {
      const HOUSE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const HOUSE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      fake.db.rows("tenants").push({ id: HOUSE_A, nome: "Casa A" }, { id: HOUSE_B, nome: "Casa B" });
      fake.db.rows("tenant_domains").push(
        { id: "da", tenant_id: HOUSE_A, kind: "email", hostname: "mail.a.bet", removed_at: null },
        { id: "db", tenant_id: HOUSE_B, kind: "email", hostname: "mail.b.bet", removed_at: null },
      );
      const ownAccount = await create(
        {
          provider: "infobip",
          label: "Infobip Casa B",
          channels: ["email"],
          config: { base_url: "https://b.api.infobip.test" },
          credentials: { api_key: "k-b" },
        },
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      );
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: HOUSE_B, channel: "email", provider_account_id: ownAccount });

      const newDefault = await create(
        {
          provider: "infobip",
          label: "Infobip Betleads",
          channels: ["email"],
          config: { base_url: "https://nova.api.infobip.test" },
          credentials: { api_key: "k-nova" },
        },
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      );
      domains.refreshTenantDomain.mockResolvedValue({
        hostname: "mail.a.bet",
        status: "pending",
        last_error: null,
      });

      const result = await adminSetPlatformDefaultFor(ADMIN, { channel: "email", accountId: newDefault });

      expect(domains.refreshTenantDomain).toHaveBeenCalledTimes(1);
      expect(domains.refreshTenantDomain).toHaveBeenCalledWith("da", { requestVerify: true });
      expect(result.emailDomains).toEqual([
        { tenantId: HOUSE_A, tenantNome: "Casa A", hostname: "mail.a.bet", status: "pending", error: null },
      ]);
    });

    it("cannot disable an account while it is the default of some channel", async () => {
      await expect(
        adminSetProviderAccountStatusFor(ADMIN, { id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID, status: "disabled" }),
      ).rejects.toThrow("Esta conta é a padrão de SMS. Escolha outra padrão antes.");
    });

    it("an env account can be disabled once it is no longer the default", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal Betleads",
          channels: ["webpush"],
          credentials: { org_api_key: "k" },
        },
        "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
      );
      await adminSetPlatformDefaultFor(ADMIN, { channel: "webpush", accountId: id });

      await adminSetProviderAccountStatusFor(ADMIN, {
        id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
        status: "disabled",
      });

      expect(
        fake.db.rows("provider_accounts").find((r) => r.id === DEFAULT_ONESIGNAL_ACCOUNT_ID)!.status,
      ).toBe("disabled");
    });
  });

  describe("delete", () => {
    it("deletes a free account; audits provider_account.delete", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal livre",
          channels: ["webpush"],
          credentials: { org_api_key: "k" },
        },
        "11111111-2222-4333-8444-555555555555",
      );

      await adminDeleteProviderAccountFor(ADMIN, { id });

      expect(fake.db.rows("provider_accounts").find((r) => r.id === id)).toBeUndefined();
      expect(audit.calls.at(-1)).toMatchObject({ action: "provider_account.delete" });
    });

    it("never deletes an env account", async () => {
      await expect(
        adminDeleteProviderAccountFor(ADMIN, { id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID }),
      ).rejects.toThrow("Contas do ambiente não podem ser excluídas.");
    });

    it("never deletes the default of a channel", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal padrão",
          channels: ["webpush"],
          credentials: { org_api_key: "k" },
        },
        "66666666-2222-4333-8444-555555555555",
      );
      await adminSetPlatformDefaultFor(ADMIN, { channel: "webpush", accountId: id });

      await expect(adminDeleteProviderAccountFor(ADMIN, { id })).rejects.toThrow(/é a padrão de/);
    });

    it("never deletes an account a house uses in tenant_channel_providers", async () => {
      const id = await create(
        {
          provider: "infobip",
          label: "Infobip Casa Um",
          channels: ["email"],
          config: { base_url: "https://own.api.infobip.test" },
          credentials: { api_key: "k" },
        },
        "77777777-2222-4333-8444-555555555555",
      );
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: TENANT, channel: "email", provider_account_id: id });

      await expect(adminDeleteProviderAccountFor(ADMIN, { id })).rejects.toThrow(
        /Uma ou mais casas usam esta conta/,
      );
    });

    it("never deletes an account with a live e-mail domain", async () => {
      const id = await create(
        {
          provider: "infobip",
          label: "Infobip Casa Um",
          channels: ["email"],
          config: { base_url: "https://own.api.infobip.test" },
          credentials: { api_key: "k" },
        },
        "88888888-2222-4333-8444-555555555555",
      );
      fake.db.rows("tenant_domains").push({
        id: "dom-1",
        tenant_id: TENANT,
        kind: "email",
        hostname: "mail.casa.bet",
        removed_at: null,
        provider_account_id: id,
      });

      await expect(adminDeleteProviderAccountFor(ADMIN, { id })).rejects.toThrow(
        /domínios de e-mail/,
      );
    });

    it("never deletes an account with a live webpush app", async () => {
      const id = await create(
        {
          provider: "onesignal",
          label: "OneSignal Casa Um",
          channels: ["webpush"],
          credentials: { org_api_key: "k" },
        },
        "99999999-2222-4333-8444-555555555555",
      );
      fake.db.rows("tenant_webpush_apps").push({
        id: "app-1",
        tenant_id: TENANT,
        provider_account_id: id,
      });

      await expect(adminDeleteProviderAccountFor(ADMIN, { id })).rejects.toThrow(
        /apps de web push/,
      );
    });
  });
});
