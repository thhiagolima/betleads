// PGlite test for
// supabase/migrations/20261215100000_platform_defaults_tenant_channels.sql:
// platform_channel_defaults (seed + trigger), tenant_channels (enabled/
// disabled_at check) and tenant_channel_notice_acks. Uses the full migrated
// database (every migration in supabase/migrations applied) so the real
// checks/trigger/FK are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const DEFAULT_SHORT_BRASIL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a001";
const DEFAULT_INFOBIP_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a002";
const DEFAULT_ONESIGNAL_ACCOUNT_ID = "00000000-0000-4000-a000-00000000a003";

const TENANT = "7a3f4d5c-0000-4000-9000-000000000001";
const EMAIL_ONLY_ACCOUNT = "7a3f4d5c-0000-4000-9000-0000000000a1";
const DISABLED_SMS_ACCOUNT = "7a3f4d5c-0000-4000-9000-0000000000a2";
const USER_A = "7a3f4d5c-0000-4000-9000-0000000000b1";
const USER_B = "7a3f4d5c-0000-4000-9000-0000000000b2";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Teste Canais', 'tenant-channels-teste', 'active', 'starter', false)`,
    [TENANT],
  );
  await db.query(
    `insert into public.provider_accounts (id, provider, label, channels, credentials_source)
     values ($1, 'infobip', 'Infobip só e-mail (teste)', array['email'], 'env')`,
    [EMAIL_ONLY_ACCOUNT],
  );
  await db.query(
    `insert into public.provider_accounts (id, provider, label, channels, credentials_source, status)
     values ($1, 'short_brasil', 'Short Brasil desativada (teste)', array['sms'], 'env', 'disabled')`,
    [DISABLED_SMS_ACCOUNT],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("platform_channel_defaults seed", () => {
  it("has exactly 4 rows: sms, email, voice, webpush with today's env account ids", async () => {
    const { rows } = await db.query<{ channel: string; provider_account_id: string }>(
      `select channel, provider_account_id from public.platform_channel_defaults order by channel`,
    );
    expect(rows).toHaveLength(4);
    expect(rows).toEqual([
      { channel: "email", provider_account_id: DEFAULT_INFOBIP_ACCOUNT_ID },
      { channel: "sms", provider_account_id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID },
      { channel: "voice", provider_account_id: DEFAULT_INFOBIP_ACCOUNT_ID },
      { channel: "webpush", provider_account_id: DEFAULT_ONESIGNAL_ACCOUNT_ID },
    ]);
  });

  it("renamed the env accounts' labels from '(padrão)' to '(ambiente)'", async () => {
    const { rows } = await db.query<{ id: string; label: string }>(
      `select id, label from public.provider_accounts
         where id in ($1, $2, $3) order by id`,
      [DEFAULT_SHORT_BRASIL_ACCOUNT_ID, DEFAULT_INFOBIP_ACCOUNT_ID, DEFAULT_ONESIGNAL_ACCOUNT_ID],
    );
    expect(rows.map((r) => r.label)).toEqual([
      "Short Brasil (ambiente)",
      "Infobip (ambiente)",
      "OneSignal (ambiente)",
    ]);
  });
});

describe("platform_channel_defaults_check trigger", () => {
  it("rejects an account that does not serve the channel", async () => {
    await expect(
      db.query(
        `update public.platform_channel_defaults set provider_account_id = $1 where channel = 'sms'`,
        [EMAIL_ONLY_ACCOUNT],
      ),
    ).rejects.toThrow(/não atende o canal/);
  });

  it("rejects a disabled account even though it serves the channel", async () => {
    await expect(
      db.query(
        `update public.platform_channel_defaults set provider_account_id = $1 where channel = 'sms'`,
        [DISABLED_SMS_ACCOUNT],
      ),
    ).rejects.toThrow(/não atende o canal|não está ativa/);
  });

  it("accepts an active account that serves the channel and bumps updated_at", async () => {
    const before = await db.query<{ updated_at: string }>(
      `select updated_at from public.platform_channel_defaults where channel = 'email'`,
    );
    await db.query(
      `update public.platform_channel_defaults set provider_account_id = $1 where channel = 'email'`,
      [EMAIL_ONLY_ACCOUNT],
    );
    const after = await db.query<{ provider_account_id: string; updated_at: string }>(
      `select provider_account_id, updated_at from public.platform_channel_defaults where channel = 'email'`,
    );
    expect(after.rows[0].provider_account_id).toBe(EMAIL_ONLY_ACCOUNT);
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    );
    // restore for any later test in this file
    await db.query(
      `update public.platform_channel_defaults set provider_account_id = $1 where channel = 'email'`,
      [DEFAULT_INFOBIP_ACCOUNT_ID],
    );
  });

  it("rejects an unknown channel", async () => {
    await expect(
      db.query(
        `insert into public.platform_channel_defaults (channel, provider_account_id)
         values ('push', $1)`,
        [DEFAULT_ONESIGNAL_ACCOUNT_ID],
      ),
    ).rejects.toThrow();
  });
});

describe("tenant_channels", () => {
  it("accepts enabled=true with no disabled_at (channel turned on)", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channels (tenant_id, channel, enabled)
         values ($1, 'sms', true)`,
        [TENANT],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects enabled=false with no disabled_at", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channels (tenant_id, channel, enabled)
         values ($1, 'voice', false)`,
        [TENANT],
      ),
    ).rejects.toThrow();
  });

  it("accepts enabled=false with disabled_at set (channel turned off)", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channels (tenant_id, channel, enabled, disabled_at)
         values ($1, 'webpush', false, now())`,
        [TENANT],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an unknown channel", async () => {
    await expect(
      db.query(
        `insert into public.tenant_channels (tenant_id, channel, enabled)
         values ($1, 'push', true)`,
        [TENANT],
      ),
    ).rejects.toThrow();
  });
});

describe("tenant_channel_notice_acks", () => {
  it("records a user's ack for a specific disabled_at and allows two users to ack the same one", async () => {
    const disabledAt = "2026-11-10T12:00:00Z";
    await db.query(
      `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
       values ($1, $2, 'voice', $3)`,
      [USER_A, TENANT, disabledAt],
    );
    await expect(
      db.query(
        `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
         values ($1, $2, 'voice', $3)`,
        [USER_B, TENANT, disabledAt],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects the same user acking the same disablement twice", async () => {
    const disabledAt = "2026-11-11T12:00:00Z";
    await db.query(
      `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
       values ($1, $2, 'email', $3)`,
      [USER_A, TENANT, disabledAt],
    );
    await expect(
      db.query(
        `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
         values ($1, $2, 'email', $3)`,
        [USER_A, TENANT, disabledAt],
      ),
    ).rejects.toThrow();
  });

  it("a new disabled_at for the same user/tenant/channel is a new ack row (re-disabling asks again)", async () => {
    const firstDisabledAt = "2026-11-12T12:00:00Z";
    const secondDisabledAt = "2026-11-13T12:00:00Z";
    await db.query(
      `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
       values ($1, $2, 'sms', $3)`,
      [USER_A, TENANT, firstDisabledAt],
    );
    await expect(
      db.query(
        `insert into public.tenant_channel_notice_acks (user_id, tenant_id, channel, disabled_at)
         values ($1, $2, 'sms', $3)`,
        [USER_A, TENANT, secondDisabledAt],
      ),
    ).resolves.toBeDefined();
  });
});
