// SQL test for supabase/migrations/20261104100000_finance_monthly_ggr.sql:
// tenant_finance_monthly_ggr (one accumulated GGR per house x month, valid
// up to valid_through inside that month), its checks and RLS. Same stub
// schema as tenant-finance.db.test.ts, on top of the groups and finance
// migrations (finance_can_view).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(resolve(__dirname, "../..", "supabase/migrations", name), "utf8");
const MIGRATION_GROUPS = migration("20261101100000_tenant_groups.sql");
const MIGRATION_FINANCE = migration("20261101100100_tenant_finance.sql");
const MIGRATION_MONTHLY_GGR = migration("20261104100000_finance_monthly_ggr.sql");

const TENANT_A = "00000000-0000-4000-8000-00000000b0a1";
const TENANT_B = "00000000-0000-4000-8000-00000000b0a2";
const ADMIN_A = "00000000-0000-4000-8000-0000000000e2";
const GESTOR_A_NO_GRANT = "00000000-0000-4000-8000-0000000000e3";

const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    raw_app_meta_data jsonb
  );

  -- Stub matching prod auth.uid(): reads the sub claim from request.jwt.claims.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $$;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    nome text NOT NULL,
    is_demo boolean NOT NULL DEFAULT false
  );

  CREATE TYPE public.app_role AS ENUM ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    tenant_id uuid,
    role public.app_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Stub matching prod is_super_admin: super_admin role with no tenant_id.
  CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = 'super_admin' AND tenant_id IS NULL
    )
  $$;

  -- Stubs for the real tables finance_days/finance_goal_days read from.
  CREATE TABLE public.players (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    ftd_em timestamptz
  );

  CREATE TABLE public.deposits (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    player_id uuid NOT NULL REFERENCES public.players(id),
    valor numeric NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );

  CREATE TABLE public.tenant_daily_metrics (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    metric_date date NOT NULL,
    registrations integer NOT NULL DEFAULT 0,
    ftds integer NOT NULL DEFAULT 0,
    approved_deposit_count integer NOT NULL DEFAULT 0,
    approved_depositor_count integer NOT NULL DEFAULT 0,
    approved_deposit_amount numeric NOT NULL DEFAULT 0,
    approved_withdrawal_count integer NOT NULL DEFAULT 0,
    approved_withdrawal_amount numeric NOT NULL DEFAULT 0,
    generated_pix_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, metric_date)
  );

  CREATE TABLE public.marketing_ad_metrics_daily (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    provider text NOT NULL,
    metric_date date NOT NULL,
    spend numeric NOT NULL DEFAULT 0
  );

  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE ON public.tenants TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE ON public.user_roles TO anon, authenticated, service_role;
  GRANT SELECT ON public.players, public.deposits, public.tenant_daily_metrics,
    public.marketing_ad_metrics_daily TO anon, authenticated, service_role;
`;

let db: PGlite;

/** Runs `sql` inside a rolled-back transaction as `role` with the given JWT claims. */
async function asRole(
  role: "anon" | "authenticated" | "service_role",
  claims: Record<string, unknown> | undefined,
  sql: string,
) {
  await db.query("BEGIN");
  try {
    if (claims !== undefined) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
    }
    await db.exec(`SET LOCAL ROLE ${role}`);
    return await db.query(sql);
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // As in Supabase, service_role bypasses RLS.
  await db.exec(`ALTER ROLE service_role BYPASSRLS`);
  await db.exec(MIGRATION_GROUPS);
  await db.exec(MIGRATION_FINANCE);
  await db.exec(MIGRATION_MONTHLY_GGR);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION_MONTHLY_GGR);
  await db.exec(`
    INSERT INTO public.tenants (id, nome, is_demo) VALUES
      ('${TENANT_A}', 'Casa A', false),
      ('${TENANT_B}', 'Casa B', false);
    INSERT INTO public.user_roles (id, user_id, tenant_id, role) VALUES
      ('00000000-0000-4000-8000-0000000101a2', '${ADMIN_A}', '${TENANT_A}', 'admin'),
      ('00000000-0000-4000-8000-0000000101a3', '${GESTOR_A_NO_GRANT}', '${TENANT_A}', 'gestor');
    INSERT INTO public.tenant_finance_monthly_ggr (tenant_id, month, ggr, valid_through) VALUES
      ('${TENANT_A}', '2026-10-01', 1497.15, '2026-10-20'),
      ('${TENANT_B}', '2026-10-01', -50, '2026-10-01');
  `);
});

afterAll(async () => {
  await db.close();
});

const insert = (month: string, validThrough: string, tenant = TENANT_A) =>
  db.query(
    `insert into public.tenant_finance_monthly_ggr (tenant_id, month, ggr, valid_through)
     values ('${tenant}', '${month}', 10, '${validThrough}')`,
  );

describe("tenant_finance_monthly_ggr", () => {
  it("keeps one row per house and month, negative values allowed", async () => {
    const { rows } = await db.query<{ ggr: string }>(
      `select ggr::text from public.tenant_finance_monthly_ggr order by tenant_id`,
    );
    expect(rows.map((row) => row.ggr)).toEqual(["1497.15", "-50.00"]);
    await expect(insert("2026-10-01", "2026-10-05")).rejects.toThrow();
  });

  it("month must be a 1st and valid_through must fall inside that month", async () => {
    await expect(insert("2026-09-02", "2026-09-10")).rejects.toThrow();
    await expect(insert("2026-09-01", "2026-08-31")).rejects.toThrow();
    await expect(insert("2026-09-01", "2026-10-01")).rejects.toThrow();
    await db.query("BEGIN");
    try {
      await insert("2026-09-01", "2026-09-30");
      await insert("2026-08-01", "2026-08-01");
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("is removed with its house", async () => {
    await db.query("BEGIN");
    try {
      await db.query(`delete from public.tenants where id = '${TENANT_B}'`);
      const { rows } = await db.query(
        `select 1 from public.tenant_finance_monthly_ggr where tenant_id = '${TENANT_B}'`,
      );
      expect(rows).toEqual([]);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

describe("RLS", () => {
  it("finance viewers read it; a gestor without grant and anon read nothing", async () => {
    const { rows: adminRows } = await asRole(
      "authenticated",
      { sub: ADMIN_A, role: "authenticated" },
      `select * from public.tenant_finance_monthly_ggr`,
    );
    expect(adminRows).toHaveLength(1);

    const { rows: gestorRows } = await asRole(
      "authenticated",
      { sub: GESTOR_A_NO_GRANT, role: "authenticated" },
      `select * from public.tenant_finance_monthly_ggr`,
    );
    expect(gestorRows).toEqual([]);

    await expect(
      asRole("anon", undefined, `select * from public.tenant_finance_monthly_ggr`),
    ).rejects.toThrow();
  });

  it("authenticated cannot write; service_role can", async () => {
    await expect(
      asRole(
        "authenticated",
        { sub: ADMIN_A, role: "authenticated" },
        `insert into public.tenant_finance_monthly_ggr (tenant_id, month, ggr, valid_through)
         values ('${TENANT_A}', '2026-09-01', 1, '2026-09-02')`,
      ),
    ).rejects.toThrow();

    const { affectedRows } = await asRole(
      "service_role",
      undefined,
      `insert into public.tenant_finance_monthly_ggr (tenant_id, month, ggr, valid_through)
       values ('${TENANT_A}', '2026-09-01', 1, '2026-09-02')`,
    );
    expect(affectedRows).toBe(1);
  });
});
