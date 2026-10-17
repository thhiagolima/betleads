// Task 10 — SQL test for
// supabase/migrations/20261018120000_demo_tenant_global_views.sql:
// `admin_platform_metrics` returns a single aggregated jsonb row (not
// per-tenant rows), so it cannot be filtered after the fact in TS — this
// exercises the migration for real against PGlite, with one demo tenant and
// one normal tenant, and asserts every total counts only the normal one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(resolve(__dirname, "../..", "supabase/migrations", name), "utf8");

const DEMO_FLAG = migration("20261018100000_demo_tenant_flag.sql");
const GLOBAL_VIEWS = migration("20261018120000_demo_tenant_global_views.sql");

const DEMO_TENANT = "00000000-0000-4000-8000-00000000d0d0";
const NORMAL_TENANT = "00000000-0000-4000-8000-00000000a0a0";

const DEMO_USER = "00000000-0000-4000-8000-0000000000d1";
const NORMAL_USER = "00000000-0000-4000-8000-0000000000a1";

// Only what the two migrations and `admin_platform_metrics` need. Function
// bodies elsewhere are not validated (check_function_bodies = off).
const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    last_sign_in_at timestamptz,
    raw_app_meta_data jsonb
  );

  CREATE TABLE public.tenants (id uuid PRIMARY KEY, nome text NOT NULL);
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid, role text NOT NULL
  );
  CREATE TABLE public.sms_send_logs (
    id uuid PRIMARY KEY, tenant_id uuid, status text NOT NULL, created_at timestamptz NOT NULL
  );
  CREATE TABLE public.call_history (
    id uuid PRIMARY KEY, tenant_id uuid, created_at timestamptz NOT NULL
  );
  CREATE TABLE public.email_send_logs (
    id uuid PRIMARY KEY, tenant_id uuid, status text NOT NULL, created_at timestamptz NOT NULL
  );

  -- Minimal stub: admin_platform_metrics calls public.is_super_admin() with
  -- no args; the real function (not loaded here) checks the caller's JWT.
  CREATE FUNCTION public.is_super_admin() RETURNS boolean
    LANGUAGE sql AS $f$ SELECT true $f$;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(DEMO_FLAG);
  await db.exec("SET check_function_bodies = off;");
  await db.exec(GLOBAL_VIEWS);
  await db.exec("SET check_function_bodies = on;");
  await db.exec(`
    INSERT INTO public.tenants (id, nome) VALUES
      ('${DEMO_TENANT}', 'Casa Demo'),
      ('${NORMAL_TENANT}', 'Casa Normal');
    UPDATE public.tenants SET is_demo = true WHERE id = '${DEMO_TENANT}';

    INSERT INTO auth.users (id, last_sign_in_at, raw_app_meta_data) VALUES
      ('${DEMO_USER}', now(), '{"is_demo_user": true}'::jsonb),
      ('${NORMAL_USER}', now(), '{}'::jsonb);

    INSERT INTO public.user_roles (id, user_id, tenant_id, role) VALUES
      (gen_random_uuid(), '${DEMO_USER}', '${DEMO_TENANT}', 'gestor'),
      (gen_random_uuid(), '${NORMAL_USER}', '${NORMAL_TENANT}', 'admin');

    INSERT INTO public.sms_send_logs (id, tenant_id, status, created_at) VALUES
      (gen_random_uuid(), '${DEMO_TENANT}', 'delivered', now()),
      (gen_random_uuid(), '${NORMAL_TENANT}', 'delivered', now());

    INSERT INTO public.call_history (id, tenant_id, created_at) VALUES
      (gen_random_uuid(), '${DEMO_TENANT}', now()),
      (gen_random_uuid(), '${NORMAL_TENANT}', now());

    INSERT INTO public.email_send_logs (id, tenant_id, status, created_at) VALUES
      (gen_random_uuid(), '${DEMO_TENANT}', 'delivered', now()),
      (gen_random_uuid(), '${NORMAL_TENANT}', 'delivered', now());
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("admin_platform_metrics", () => {
  it("counts only the normal tenant in every total, excluding the demo tenant", async () => {
    const { rows } = await db.query<{ metrics: Record<string, number> }>(
      "SELECT public.admin_platform_metrics() AS metrics",
    );
    const metrics = rows[0].metrics;

    expect(metrics.total_users).toBe(1);
    expect(metrics.active_users_30d).toBe(1);
    expect(metrics.sms_total).toBe(1);
    expect(metrics.sms_delivered).toBe(1);
    expect(metrics.call_total).toBe(1);
    expect(metrics.email_total).toBe(1);
    expect(metrics.email_delivered).toBe(1);
  });
});
