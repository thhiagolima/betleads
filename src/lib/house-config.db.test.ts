// House onboarding/configuration data model — SQL tests for
// supabase/migrations/20261021100000_tenant_house_config.sql
//
// Runs the migration inside an in-memory Postgres (PGlite) against a minimal
// schema (tenants, shortio_settings, email_senders, sms_campaigns,
// email_campaigns) and asserts the new tables, constraints, FKs and the
// one-time backfill behave as specified.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261021100000_tenant_house_config.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.accessible_tenant_ids() returns uuid[] language sql as $$ select '{}'::uuid[] $$;
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Casa',
  onboarding_completed_at timestamptz,
  onboarding_skipped_at timestamptz,
  site_url text
);
create table public.shortio_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  domain text,
  domain_id bigint,
  updated_at timestamptz not null default now()
);
create table public.email_senders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  from_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  content text not null,
  scheduled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

const EXISTING_TENANT = "00000000-0000-4000-8000-000000000001";
const BACKFILL_TENANT = "00000000-0000-4000-8000-000000000002";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);

  // Pre-existing data, as it would be on the day the migration runs.
  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa Existente')`, [
    EXISTING_TENANT,
  ]);
  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa Com Encurtador')`, [
    BACKFILL_TENANT,
  ]);
  await db.query(
    `insert into public.shortio_settings (tenant_id, domain, domain_id) values ($1, 'bmkt.click', 42)`,
    [BACKFILL_TENANT],
  );

  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe("tenant_domains uniqueness and defaults", () => {
  it("rejects a second domain whose hostname only differs by case", async () => {
    await db.query(
      `insert into public.tenant_domains (tenant_id, kind, hostname) values ($1, 'shortener', 'Go.X.com')`,
      [EXISTING_TENANT],
    );

    await expect(
      db.query(
        `insert into public.tenant_domains (tenant_id, kind, hostname) values ($1, 'shortener', 'go.x.com')`,
        [EXISTING_TENANT],
      ),
    ).rejects.toThrow();
  });

  it("rejects a second active default for the same tenant and kind", async () => {
    await db.query(
      `insert into public.tenant_domains (tenant_id, kind, hostname, is_default)
       values ($1, 'email', 'mail1.x.com', true)`,
      [EXISTING_TENANT],
    );

    await expect(
      db.query(
        `insert into public.tenant_domains (tenant_id, kind, hostname, is_default)
         values ($1, 'email', 'mail2.x.com', true)`,
        [EXISTING_TENANT],
      ),
    ).rejects.toThrow();
  });

  it("allows a removed default alongside a new active default", async () => {
    // mail1.x.com was set as the active default in the previous test; remove
    // it so a new active default for the same tenant/kind can take its place.
    await db.query(
      `update public.tenant_domains set removed_at = now()
       where tenant_id = $1 and kind = 'email' and hostname = 'mail1.x.com'`,
      [EXISTING_TENANT],
    );

    await expect(
      db.query(
        `insert into public.tenant_domains (tenant_id, kind, hostname, is_default)
         values ($1, 'email', 'mail4.x.com', true)`,
        [EXISTING_TENANT],
      ),
    ).resolves.toBeTruthy();
  });
});

describe("tenant_quick_links key format", () => {
  it("rejects an uppercase key", async () => {
    await expect(
      db.query(
        `insert into public.tenant_quick_links (tenant_id, key, label, path)
         values ($1, 'Login', 'Login', '/login')`,
        [EXISTING_TENANT],
      ),
    ).rejects.toThrow();
  });

  it("accepts a lowercase key", async () => {
    await expect(
      db.query(
        `insert into public.tenant_quick_links (tenant_id, key, label, path)
         values ($1, 'login', 'Login', '/login')`,
        [EXISTING_TENANT],
      ),
    ).resolves.toBeTruthy();
  });
});

describe("backfill from shortio_settings", () => {
  it("creates a verified default shortener domain for a tenant with a configured domain", async () => {
    const { rows } = await db.query<{
      kind: string;
      hostname: string;
      status: string;
      is_default: boolean;
      verified_at: string | null;
      last_checked_at: string | null;
      verified_notice_seen_at: string | null;
      provider_domain_id: string | null;
    }>(
      `select kind, hostname, status, is_default, verified_at, last_checked_at,
              verified_notice_seen_at, provider_domain_id
       from public.tenant_domains where tenant_id = $1`,
      [BACKFILL_TENANT],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "shortener",
      hostname: "bmkt.click",
      status: "verified",
      is_default: true,
      provider_domain_id: "42",
    });
    expect(rows[0].verified_at).not.toBeNull();
    // Not re-checked by the cron right away, and no "verified" notice for a
    // domain the house has been using all along.
    expect(rows[0].last_checked_at).not.toBeNull();
    expect(rows[0].verified_notice_seen_at).not.toBeNull();
  });
});

describe("onboarding backfill", () => {
  it("marks existing tenants as having completed onboarding", async () => {
    const { rows } = await db.query<{ onboarding_completed_at: string | null }>(
      `select onboarding_completed_at from public.tenants where id = $1`,
      [EXISTING_TENANT],
    );

    expect(rows[0].onboarding_completed_at).not.toBeNull();
  });
});
