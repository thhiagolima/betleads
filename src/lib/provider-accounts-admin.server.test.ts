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
  adminListProviderAccountsFor,
  adminSaveProviderAccountFor,
  adminSetProviderAccountStatusFor,
  adminSetTenantChannelProviderFor,
} from "./provider-accounts-admin.server";
import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
} from "./provider-accounts.server";
import { saveProviderAccountInput } from "./provider-accounts.shared";
import { decryptProviderCredentials } from "./secret-box.server";

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
      { id: TENANT, nome: "Casa Um", accounts: { sms: null, email: null, voice: null } },
    ]);
  });

  it("rejects unsupported channels, missing credentials and edits of the platform accounts", async () => {
    await expect(
      save({
        provider: "infobip",
        label: "x",
        channels: ["sms"],
        config: { base_url: "https://a.test" },
        credentials: { api_key: "k" },
      }),
    ).rejects.toThrow(/SMS pela Infobip/);
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
    await expect(
      save({
        id: DEFAULT_INFOBIP_ACCOUNT_ID,
        provider: "infobip",
        label: "x",
        channels: ["email"],
        config: { base_url: "https://a.test" },
        credentials: { api_key: "k" },
      }),
    ).rejects.toThrow(/variáveis de ambiente/);
    await expect(
      adminSetProviderAccountStatusFor(ADMIN, {
        id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
        status: "disabled",
      }),
    ).rejects.toThrow(/não podem ser desativadas/);
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
      fake.db
        .rows("tenant_domains")
        .push(
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

    it("back to the platform account (null or its id) removes the row", async () => {
      await ownInfobip();
      fake.db
        .rows("tenant_channel_providers")
        .push({ tenant_id: TENANT, channel: "email", provider_account_id: OWN });

      await adminSetTenantChannelProviderFor(ADMIN, {
        tenantId: TENANT,
        channel: "email",
        accountId: DEFAULT_INFOBIP_ACCOUNT_ID,
      });

      expect(fake.db.rows("tenant_channel_providers")).toEqual([]);
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
});
