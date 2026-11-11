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
  adminAddTenantSmsAccountOptionFor,
  adminDeleteProviderAccountFor,
  adminListProviderAccountsFor,
  adminRemoveTenantSmsAccountOptionFor,
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
  listSmsSendChoices,
  resolveOneSignalAccount,
} from "./provider-accounts.server";
import {
  addTenantSmsAccountOptionInput,
  removeTenantSmsAccountOptionInput,
  saveProviderAccountInput,
} from "./provider-accounts.shared";
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
        smsOptions: [],
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
      channels: ["email", "voice"],
      config: { base_url: "https://attempted.test" },
      credentials: { api_key: "attempted-key" },
    });
    expect(id).toBe(DEFAULT_INFOBIP_ACCOUNT_ID);

    const after = fake.db.rows("provider_accounts").find((r) => r.id === DEFAULT_INFOBIP_ACCOUNT_ID)!;
    expect(after).toMatchObject({
      label: "Infobip (ambiente)",
      channels: ["email", "voice"],
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
    // Troca a padrão de voz para outra conta primeiro, para que o bloqueio
    // seja o de "casa em uso" (não o de "é a padrão").
    const otherVoice = await create(
      {
        provider: "infobip",
        label: "Infobip Betleads Voz",
        channels: ["voice"],
        config: { base_url: "https://voz.api.infobip.test", voice_from: "5511300000000" },
        credentials: { api_key: "k" },
      },
      "e0e0e0e0-0000-4000-8000-000000000000",
    );
    await adminSetPlatformDefaultFor(ADMIN, { channel: "voice", accountId: otherVoice });
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

  it("refuses to remove a channel an env account is the default of, even with no house override", async () => {
    // Sem linha em platform_channel_defaults, a conta env Infobip é a
    // padrão hoje de e-mail e voz (fallback); nenhuma casa usa a conta, mas
    // removê-la do canal ainda deixaria todo mundo sem padrão nesse canal.
    await expect(
      save({
        id: DEFAULT_INFOBIP_ACCOUNT_ID,
        provider: "infobip",
        label: "Infobip (ambiente)",
        channels: ["voice"],
      }),
    ).rejects.toThrow("Esta conta é a padrão de E-mail. Escolha outra padrão antes.");
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

  it("refuses to drop a channel a db account is the chosen platform default of, with no house override", async () => {
    const id = await create(
      {
        provider: "infobip",
        label: "Infobip Betleads",
        channels: ["email", "voice"],
        config: { base_url: "https://nova.api.infobip.test", voice_from: "5511300000000" },
        credentials: { api_key: "k" },
      },
      "d0d0d0d0-0000-4000-8000-000000000000",
    );
    await adminSetPlatformDefaultFor(ADMIN, { channel: "email", accountId: id });

    await expect(
      save({
        id,
        provider: "infobip",
        label: "Infobip Betleads",
        channels: ["voice"],
        config: { base_url: "https://nova.api.infobip.test", voice_from: "5511300000000" },
      }),
    ).rejects.toThrow("Esta conta é a padrão de E-mail. Escolha outra padrão antes.");
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

      async function ownInfobip(apiKey = "ib-key-1") {
        const { id } = await save({
          provider: "infobip",
          label: "Infobip Casa Um",
          channels: ["sms"],
          config: { base_url: "https://x.api.infobip.com" },
          credentials: { api_key: apiKey },
        });
        return id;
      }

      it("Infobip 403 says the key lacks the balance scope, not that it is wrong", async () => {
        const id = await ownInfobip();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("{}", { status: 403 })),
        );
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/aceita, mas não tem permissão para consultar o saldo \(403\)/);
      });

      it("Infobip 401 carries the provider's error text", async () => {
        const id = await ownInfobip();
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({ requestError: { serviceException: { text: "Invalid login details" } } }),
                { status: 401 },
              ),
          ),
        );
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result.message).toMatch(/^A Infobip recusou a API key \(401: Invalid login details\)/);
      });

      it("Infobip key pasted with the 'App ' prefix is sent once", async () => {
        const id = await ownInfobip("App ib-key-2");
        const fetchMock = vi.fn(async () => new Response('{"balance":1}', { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const result = await adminTestProviderAccountFor(ADMIN, { id });
        expect(result.ok).toBe(true);
        const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe("App ib-key-2");
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

    it("saving the same e-mail default again resumes the move: only domains not yet on it are moved", async () => {
      const HOUSE_A = "cccccccc-1111-4ccc-8ccc-cccccccccccc";
      const HOUSE_B = "dddddddd-1111-4ddd-8ddd-dddddddddddd";
      const HOUSE_C = "eeeeeeee-1111-4eee-8eee-eeeeeeeeeeee";
      fake.db
        .rows("tenants")
        .push({ id: HOUSE_A, nome: "Casa A" }, { id: HOUSE_B, nome: "Casa B" }, { id: HOUSE_C, nome: "Casa C" });
      const newDefault = await create(
        {
          provider: "infobip",
          label: "Infobip Betleads",
          channels: ["email"],
          config: { base_url: "https://nova.api.infobip.test" },
          credentials: { api_key: "k-nova" },
        },
        "ffffffff-1111-4fff-8fff-ffffffffffff",
      );
      const ownAccount = await create(
        {
          provider: "infobip",
          label: "Infobip Casa C",
          channels: ["email"],
          config: { base_url: "https://c.api.infobip.test" },
          credentials: { api_key: "k-c" },
        },
        "abababab-1111-4aba-8aba-abababababab",
      );
      // The default was already switched; the earlier move died midway:
      // Casa A's domain moved, Casa B's is still on the old (env) account.
      fake.db.rows("platform_channel_defaults").push({ channel: "email", provider_account_id: newDefault });
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: HOUSE_C, channel: "email", provider_account_id: ownAccount });
      fake.db.rows("tenant_domains").push(
        { id: "da", tenant_id: HOUSE_A, kind: "email", hostname: "mail.a.bet", removed_at: null, provider_account_id: newDefault },
        { id: "db", tenant_id: HOUSE_B, kind: "email", hostname: "mail.b.bet", removed_at: null, provider_account_id: DEFAULT_INFOBIP_ACCOUNT_ID },
        { id: "dc", tenant_id: HOUSE_C, kind: "email", hostname: "mail.c.bet", removed_at: null, provider_account_id: ownAccount },
      );
      domains.refreshTenantDomain.mockResolvedValue({
        hostname: "mail.b.bet",
        status: "pending",
        last_error: null,
      });
      const auditsBefore = audit.calls.length;

      const result = await adminSetPlatformDefaultFor(ADMIN, { channel: "email", accountId: newDefault });

      expect(domains.refreshTenantDomain).toHaveBeenCalledTimes(1);
      expect(domains.refreshTenantDomain).toHaveBeenCalledWith("db", { requestVerify: true });
      expect(result.emailDomains).toEqual([
        { tenantId: HOUSE_B, tenantNome: "Casa B", hostname: "mail.b.bet", status: "pending", error: null },
      ]);
      // Nothing changed in the default itself: no new audit entry.
      expect(audit.calls.length).toBe(auditsBefore);
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

    it("deletes an account referenced only by an already-removed domain, clearing its provider_account_id", async () => {
      const id = await create(
        {
          provider: "infobip",
          label: "Infobip Casa Um",
          channels: ["email"],
          config: { base_url: "https://own.api.infobip.test" },
          credentials: { api_key: "k" },
        },
        "a1a1a1a1-2222-4333-8444-555555555555",
      );
      fake.db.rows("tenant_domains").push({
        id: "dom-removed",
        tenant_id: TENANT,
        kind: "email",
        hostname: "old.casa.bet",
        removed_at: "2026-10-01T00:00:00Z",
        provider_account_id: id,
      });

      await adminDeleteProviderAccountFor(ADMIN, { id });

      expect(fake.db.rows("provider_accounts").find((r) => r.id === id)).toBeUndefined();
      expect(fake.db.rows("tenant_domains").find((r) => r.id === "dom-removed")).toMatchObject({
        provider_account_id: null,
      });
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

describe("contas extras de SMS por casa (tenant_channel_account_options)", () => {
  const EXTRA = "abababab-1111-4222-8333-444444444444";
  const add = (data: Record<string, unknown>) =>
    adminAddTenantSmsAccountOptionFor(ADMIN, addTenantSmsAccountOptionInput.parse(data));
  const remove = (data: Record<string, unknown>) =>
    adminRemoveTenantSmsAccountOptionFor(ADMIN, removeTenantSmsAccountOptionInput.parse(data));

  async function extraSmsAccount() {
    return create(
      {
        provider: "short_brasil",
        label: "Short Brasil rota 2 (interno)",
        channels: ["sms"],
        credentials: { shortcode_token: "token-rota-2" },
      },
      EXTRA,
    );
  }

  it("only the super admin can add or remove", async () => {
    await extraSmsAccount();
    await expect(
      adminAddTenantSmsAccountOptionFor(NOT_ADMIN, {
        tenantId: TENANT,
        accountId: EXTRA,
        displayName: "Rota principal",
      }),
    ).rejects.toThrow();
    await expect(
      adminRemoveTenantSmsAccountOptionFor(NOT_ADMIN, { tenantId: TENANT, accountId: EXTRA }),
    ).rejects.toThrow();
  });

  it("adds an option: audited, listed in smsOptions, and offered to the house by its name only", async () => {
    await extraSmsAccount();
    await add({ tenantId: TENANT, accountId: EXTRA, displayName: "  Rota principal " });

    expect(fake.db.rows("tenant_channel_account_options")).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        channel: "sms",
        provider_account_id: EXTRA,
        display_name: "Rota principal",
        created_by: ADMIN.userId,
      }),
    ]);
    expect(audit.calls.at(-1)).toMatchObject({
      action: "tenant_sms_account_option.add",
      tenantId: TENANT,
    });
    const listing = await adminListProviderAccountsFor(ADMIN);
    expect(listing.tenants.find((t) => t.id === TENANT)?.smsOptions).toEqual([
      { accountId: EXTRA, displayName: "Rota principal" },
    ]);
    // The resolver sees it right away (cache invalidated).
    const choices = await listSmsSendChoices(TENANT);
    expect(choices).toEqual([
      { id: null, name: "Padrão da casa", available: true },
      { id: EXTRA, name: "Rota principal", available: true },
    ]);
    expect(JSON.stringify(choices)).not.toMatch(/Short Brasil|interno/);
  });

  it("refuses: disabled account, no sms, the house default, duplicates and reserved name", async () => {
    await extraSmsAccount();
    // Default of the house (platform default).
    await expect(
      add({ tenantId: TENANT, accountId: DEFAULT_SHORT_BRASIL_ACCOUNT_ID, displayName: "Rota" }),
    ).rejects.toThrow(/já é a padrão de SMS/);
    // Account that does not serve sms.
    await expect(
      add({ tenantId: TENANT, accountId: DEFAULT_INFOBIP_ACCOUNT_ID, displayName: "Rota" }),
    ).rejects.toThrow(/não atende SMS/);
    await expect(
      add({ tenantId: TENANT, accountId: EXTRA, displayName: "padrão da casa" }),
    ).rejects.toThrow(/reservado/);

    await add({ tenantId: TENANT, accountId: EXTRA, displayName: "Rota principal" });
    await expect(
      add({ tenantId: TENANT, accountId: EXTRA, displayName: "Outra" }),
    ).rejects.toThrow(/já é uma conta extra/);

    const OTHER_EXTRA = "cdcdcdcd-1111-4222-8333-444444444444";
    await create(
      {
        provider: "short_brasil",
        label: "Rota 3",
        channels: ["sms"],
        credentials: { shortcode_token: "t3" },
      },
      OTHER_EXTRA,
    );
    await expect(
      add({ tenantId: TENANT, accountId: OTHER_EXTRA, displayName: "ROTA PRINCIPAL" }),
    ).rejects.toThrow(/mesmo nome|com este nome/);

    fake.db.rows("provider_accounts").find((r) => r.id === OTHER_EXTRA)!.status = "disabled";
    await expect(
      add({ tenantId: TENANT, accountId: OTHER_EXTRA, displayName: "Rota 3" }),
    ).rejects.toThrow(/desativada/);
  });

  it("removal is blocked while live campaigns use it (with the count); allowed afterwards", async () => {
    await extraSmsAccount();
    await add({ tenantId: TENANT, accountId: EXTRA, displayName: "Rota principal" });
    fake.db.rows("sms_campaigns").push(
      { id: "c1", tenant_id: TENANT, provider_account_id: EXTRA, status: "agendada" },
      { id: "c2", tenant_id: TENANT, provider_account_id: EXTRA, status: "pausada" },
      { id: "c3", tenant_id: TENANT, provider_account_id: EXTRA, status: "enviado" },
    );
    await expect(remove({ tenantId: TENANT, accountId: EXTRA })).rejects.toThrow(
      /2 campanha\(s\) de SMS/,
    );
    for (const c of fake.db.rows("sms_campaigns")) c.status = "enviado";
    await remove({ tenantId: TENANT, accountId: EXTRA });
    expect(fake.db.rows("tenant_channel_account_options")).toEqual([]);
    expect(audit.calls.at(-1)).toMatchObject({ action: "tenant_sms_account_option.remove" });
    await expect(remove({ tenantId: TENANT, accountId: EXTRA })).rejects.toThrow(
      /não é uma conta extra/,
    );
  });

  it("an account that is an option cannot be deleted; disabling it reports the houses", async () => {
    await extraSmsAccount();
    await add({ tenantId: TENANT, accountId: EXTRA, displayName: "Rota principal" });
    await expect(adminDeleteProviderAccountFor(ADMIN, { id: EXTRA })).rejects.toThrow(
      /conta extra de 1 casa/,
    );
    expect(await adminSetProviderAccountStatusFor(ADMIN, { id: EXTRA, status: "disabled" })).toEqual(
      { ok: true, smsOptionTenants: 1 },
    );
    // The house still sees the option, now unavailable.
    expect(await listSmsSendChoices(TENANT)).toContainEqual({
      id: EXTRA,
      name: "Rota principal",
      available: false,
    });
  });

  it("cannot drop sms from an account that is a house option", async () => {
    const INFOBIP_EXTRA = "efefefef-1111-4222-8333-444444444444";
    const account = {
      provider: "infobip",
      label: "Infobip rota",
      config: { base_url: "https://own.api.infobip.test" },
      credentials: { api_key: "k" },
    };
    await create({ ...account, channels: ["sms", "email"] }, INFOBIP_EXTRA);
    await add({ tenantId: TENANT, accountId: INFOBIP_EXTRA, displayName: "Rota Infobip" });
    await expect(save({ ...account, id: INFOBIP_EXTRA, channels: ["email"] })).rejects.toThrow(
      /conta extra de 1 casa/,
    );
  });
});
