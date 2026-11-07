// PGlite test for
// supabase/migrations/20261217100000_own_provider_accounts.sql:
// provider_accounts.owner_tenant_id/own_unit_cost/callback_token_encrypted/
// last_callback_at, tenant_own_provider_grants, and the owner checks added
// to tenant_channel_providers_check_channel and platform_channel_defaults_check.
// Uses the full migrated database (every migration in supabase/migrations
// applied) so the real checks/triggers/FKs are exercised.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT_A = "7a3f4d5c-0001-4000-9000-000000000001";
const TENANT_B = "7a3f4d5c-0001-4000-9000-000000000002";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());

  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa A (teste conta própria)', 'own-provider-teste-a', 'active', 'starter', false)`,
    [TENANT_A],
  );
  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa B (teste conta própria)', 'own-provider-teste-b', 'active', 'starter', false)`,
    [TENANT_B],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("provider_accounts com dono + tenant_channel_providers_check_channel", () => {
  it("liga conta com dono só à própria casa", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.provider_accounts
         (provider, label, channels, credentials_source, credentials_encrypted, owner_tenant_id)
       values ('short_brasil', 'Conta própria Casa A', array['sms'], 'db', 'x', $1)
       returning id`,
      [TENANT_A],
    );
    const conta = rows[0].id;

    await expect(
      db.query(
        `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
         values ($1, 'sms', $2)`,
        [TENANT_A, conta],
      ),
    ).resolves.toBeDefined();

    await expect(
      db.query(
        `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
         values ($1, 'sms', $2)`,
        [TENANT_B, conta],
      ),
    ).rejects.toThrow(/não pertence/);
  });
});

describe("provider_accounts com dono + platform_channel_defaults_check", () => {
  it("conta com dono nunca é padrão da plataforma", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.provider_accounts
         (provider, label, channels, credentials_source, credentials_encrypted, owner_tenant_id)
       values ('short_brasil', 'Conta própria Casa A (padrão?)', array['sms'], 'db', 'x', $1)
       returning id`,
      [TENANT_A],
    );
    const conta = rows[0].id;

    await expect(
      db.query(
        `update public.platform_channel_defaults set provider_account_id = $1 where channel = 'sms'`,
        [conta],
      ),
    ).rejects.toThrow();
  });
});

describe("exclusão da casa", () => {
  it("excluir a casa apaga a conta dela", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.provider_accounts
         (provider, label, channels, credentials_source, credentials_encrypted, owner_tenant_id)
       values ('short_brasil', 'Conta própria Casa A (exclusão)', array['sms'], 'db', 'x', $1)
       returning id`,
      [TENANT_A],
    );
    const conta = rows[0].id;

    // Liga a conta própria ao canal da própria casa antes de excluir — exercita
    // a ordem das duas cascatas de ON DELETE CASCADE a partir de tenants
    // (tenant_channel_providers.tenant_id e provider_accounts.owner_tenant_id)
    // na mesma exclusão, como o brief pede (Step 3). (A,'sms') pode já estar
    // ligado por um teste anterior nesta casa; substitui a ligação.
    await db.query(
      `insert into public.tenant_channel_providers (tenant_id, channel, provider_account_id)
       values ($1, 'sms', $2)
       on conflict (tenant_id, channel) do update set provider_account_id = excluded.provider_account_id`,
      [TENANT_A, conta],
    );

    await db.query(`delete from public.tenants where id = $1`, [TENANT_A]);

    const { rows: after } = await db.query<{ count: string }>(
      `select count(*) from public.provider_accounts where id = $1`,
      [conta],
    );
    expect(Number(after[0].count)).toBe(0);

    const { rows: link } = await db.query<{ count: string }>(
      `select count(*) from public.tenant_channel_providers where provider_account_id = $1`,
      [conta],
    );
    expect(Number(link[0].count)).toBe(0);
  });
});

describe("tenant_own_provider_grants", () => {
  it("concessão aceita só sms/email/voice e taxa >= 0", async () => {
    await expect(
      db.query(
        `insert into public.tenant_own_provider_grants (tenant_id, channel, allowed, monthly_fee_cents)
         values ($1, 'webpush', true, 0)`,
        [TENANT_B],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into public.tenant_own_provider_grants (tenant_id, channel, allowed, monthly_fee_cents)
         values ($1, 'sms', true, -1)`,
        [TENANT_B],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into public.tenant_own_provider_grants (tenant_id, channel, allowed, monthly_fee_cents)
         values ($1, 'sms', true, 0)`,
        [TENANT_B],
      ),
    ).resolves.toBeDefined();
  });

  it("tabela nova só para service_role", async () => {
    const { rows } = await db.query<{ has_priv: boolean }>(
      `select has_table_privilege('authenticated', 'public.tenant_own_provider_grants', 'select') as has_priv`,
    );
    expect(rows[0].has_priv).toBe(false);
  });
});
