// Shared PGlite stub schema + seed for the PG1 billing tests (Tasks 2 and 3).
// Keeps the production stub pattern (see aquisicao-ltv.db.test.ts): auth.role()
// from test.role, has_tenant_access from test.access, is_super_admin from
// test.super, auth.uid() from test.uid, accessible_tenant_ids from test.access
// too (empty array; RLS is not exercised directly by these functional tests).
// current_tenant_id() is a minimal stub (test.tenant, else null): the real
// function resolves the active tenant from request headers, which the wallet
// RPCs never rely on directly in these tests (they always pass _tenant).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

const root = resolve(__dirname, "../../..");

export function readMigration(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

export const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql as $$
  select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;
create function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('test.uid', true), '')::uuid $$;
-- Minimal stub so FK columns like "updated_by uuid references auth.users(id)"
-- in legacy migrations (e.g. 20260922193000_create_sms_credit_billing.sql)
-- can be applied. Unused by Tasks 2/3.
create table auth.users (id uuid primary key);
create table public.tenants (
  id uuid primary key,
  slug text unique,
  plano text not null default 'starter'
    constraint tenants_plano_check check (plano in ('starter', 'pro', 'enterprise', 'interno')),
  is_demo boolean not null default false
);
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$
  select coalesce(nullif(current_setting('test.access', true), ''), 'on') = 'on' $$;
create function public.is_super_admin() returns boolean language sql as $$
  select coalesce(nullif(current_setting('test.super', true), ''), 'off') = 'on' $$;
create function public.accessible_tenant_ids() returns uuid[] language sql as $$
  select array[]::uuid[] $$;
create function public.current_tenant_id() returns uuid language sql as $$
  select nullif(current_setting('test.tenant', true), '')::uuid $$;
`;

export const NORMAL = "00000000-0000-4000-8000-000000000001";
export const INTERNO = "00000000-0000-4000-8000-0000000000d1";
export const LEGACY_INTERNO = "00000000-0000-4000-8000-0000000000e1";

export const SEED = `
insert into public.tenants (id, slug, plano, is_demo) values
  ('${NORMAL}', 'casa-normal', 'starter', false),
  ('${INTERNO}', 'minha-demo', 'starter', true),
  ('00000000-0000-4000-8000-0000000000f1', 'pixpgf', 'starter', false),
  ('00000000-0000-4000-8000-0000000000f2', 'pixreals', 'starter', false),
  ('00000000-0000-4000-8000-0000000000f3', 'forrandobet', 'starter', false),
  ('${LEGACY_INTERNO}', 'ja-era-interno', 'interno', false);
`;

export async function resetSession(db: PGlite) {
  await db.exec(`
    set test.role = '';
    set test.access = 'on';
    set test.super = 'off';
    set test.uid = '';
    set test.tenant = '';
    set test.now = '';
    set app.allow_test_clock = '';
  `);
}
