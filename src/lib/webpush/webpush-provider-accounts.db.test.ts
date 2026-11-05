// OneSignal accounts per house — PGlite test for
// supabase/migrations/20261210100400_webpush_provider_accounts.sql: the
// provider/channel checks gain 'onesignal'/'webpush', the seeded default
// account, and tenant_webpush_apps.provider_account_id. Uses the full
// migrated database (every migration in supabase/migrations applied) so the
// real checks/trigger/FK are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const DEFAULT_ONESIGNAL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a003";

const TENANT = "7a3f4d5c-0000-4000-8000-000000000001";
const OWN_ONESIGNAL = "7a3f4d5c-0000-4000-8000-0000000000a1";
const APP = "7a3f4d5c-0000-4000-8000-0000000000b1";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Teste Provider Accounts Webpush', 'webpush-provider-accounts-teste', 'active', 'starter', false)`,
    [TENANT],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("provider_accounts seed", () => {
  it("has the default OneSignal account, provider='onesignal', channels={webpush}, credentials_source='env'", async () => {
    const { rows } = await db.query<{
      provider: string;
      label: string;
      channels: string[];
      credentials_source: string;
      status: string;
    }>(
      `select provider, label, channels, credentials_source, status
         from public.provider_accounts where id = $1`,
      [DEFAULT_ONESIGNAL_ACCOUNT_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "onesignal",
      label: "OneSignal (ambiente)",
      channels: ["webpush"],
      credentials_source: "env",
      status: "active",
    });
  });
});

describe("provider_accounts check constraints accept onesignal/webpush", () => {
  it("accepts provider='onesignal' and channels=['webpush']", async () => {
    await expect(
      db.query(
        `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
         values ($1, 'onesignal', 'OneSignal Casa Um', array['webpush'], 'env')`,
        [OWN_ONESIGNAL],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an unknown provider", async () => {
    await expect(
      db.query(
        `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
         values (gen_random_uuid(), 'mailgun', 'x', array['email'], 'env')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects an unknown channel", async () => {
    await expect(
      db.query(
        `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
         values (gen_random_uuid(), 'onesignal', 'x', array['push'], 'env')`,
      ),
    ).rejects.toThrow();
  });
});

describe("tenant_channel_providers accepts channel='webpush'", () => {
  beforeAll(async () => {
    await db.query(
      `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
       values ($1, 'onesignal', 'OneSignal Casa Um (assign)', array['webpush'], 'env')
       on conflict (id) do nothing`,
      [OWN_ONESIGNAL],
    );
  });

  it("assigns a house's webpush channel to a OneSignal account", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
         values ($1, 'webpush', $2)`,
        [TENANT, OWN_ONESIGNAL],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects channel='push'", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
         values ($1, 'push', $2)`,
        [TENANT, OWN_ONESIGNAL],
      ),
    ).rejects.toThrow();
  });

  it("the channel-matching trigger still refuses an account that does not serve the channel", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
       values (gen_random_uuid(), 'infobip', 'Infobip só e-mail', array['email'], 'env')
       returning id`,
    );
    await expect(
      db.query(
        `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
         values ($1, 'webpush', $2)`,
        [TENANT, rows[0].id],
      ),
    ).rejects.toThrow(/não atende o canal/);
  });
});

describe("tenant_webpush_apps.provider_account_id", () => {
  it("defaults to null (app created before/without this column)", async () => {
    await db.query(
      `insert into public.tenant_webpush_apps
         (id, tenant_id, origin, onesignal_app_id, api_key_encrypted, created_via, status)
       values ($1, $2, 'https://provider-accounts.example', 'os-app-pa', 'enc-1', 'manual', 'ativo')`,
      [APP, TENANT],
    );
    const { rows } = await db.query<{ provider_account_id: string | null }>(
      `select provider_account_id from public.tenant_webpush_apps where id = $1`,
      [APP],
    );
    expect(rows[0].provider_account_id).toBeNull();
  });

  it("accepts a real provider_accounts id and rejects an unknown one", async () => {
    await expect(
      db.query(`update public.tenant_webpush_apps set provider_account_id = $1 where id = $2`, [
        OWN_ONESIGNAL,
        APP,
      ]),
    ).resolves.toBeDefined();

    await expect(
      db.query(`update public.tenant_webpush_apps set provider_account_id = $1 where id = $2`, [
        "00000000-0000-4000-8000-000000009999",
        APP,
      ]),
    ).rejects.toThrow();
  });
});
