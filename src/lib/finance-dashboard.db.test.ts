// Task 1 — SQL test for
// supabase/migrations/20261103100000_finance_dashboard.sql:
// finance_betleads_usage, finance_betleads_fees, finance_betleads_since,
// and the categoria column on tenant_finance_other_costs.
//
// Builds on the real tenant_finance migration (20261101100100), whose
// tenant_finance_other_costs table this migration alters.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_GROUPS = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261101100000_tenant_groups.sql"),
  "utf8",
);
const MIGRATION_FINANCE = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261101100100_tenant_finance.sql"),
  "utf8",
);
const MIGRATION_DASHBOARD = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261103100000_finance_dashboard.sql"),
  "utf8",
);

const TENANT_A = "00000000-0000-4000-8000-00000000c0a1";
const TENANT_B = "00000000-0000-4000-8000-00000000c0a2";
const TENANT_NONE = "00000000-0000-4000-8000-00000000c0a3";

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

  -- Stubs for tables finance_days (loaded as part of the real tenant_finance
  -- migration) reads from. Not used by this task's own tests.
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

  -- Minimal wallet_ledger (real columns are in 20261022100100_billing_wallet.sql).
  CREATE TABLE public.wallet_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    entry_type text NOT NULL CHECK (
      entry_type IN ('purchase', 'manual_adjustment', 'usage_reservation', 'usage_refund', 'migration')
    ),
    amount numeric(14,4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Minimal billing_invoices (real columns are in 20261023100000_billing_invoices.sql).
  CREATE TABLE public.billing_invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    period_start date NOT NULL,
    amount_cents bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('open', 'paid', 'canceled'))
  );

  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE ON public.tenants TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE ON public.user_roles TO anon, authenticated, service_role;
  GRANT SELECT ON public.players, public.deposits, public.tenant_daily_metrics,
    public.marketing_ad_metrics_daily TO anon, authenticated, service_role;
  GRANT SELECT ON public.wallet_ledger, public.billing_invoices TO anon, authenticated, service_role;
`;

let db: PGlite;

async function seed() {
  await db.exec(`
    INSERT INTO public.tenants (id, nome, is_demo) VALUES
      ('${TENANT_A}', 'Casa A', false),
      ('${TENANT_B}', 'Casa B', false),
      ('${TENANT_NONE}', 'Casa Sem Uso', false);
  `);
}

function isoDay(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function usageRows(tenants: string[], from: string, to: string) {
  const { rows } = await db.query<{ tenant_id: string; metric_date: string | Date; amount: string }>(
    `select * from public.finance_betleads_usage(array[${tenants
      .map((t) => `'${t}'`)
      .join(",")}]::uuid[], '${from}', '${to}') order by tenant_id, metric_date`,
  );
  return rows;
}

// All `it` cases below share one db and its rows: nothing is rolled back
// between cases, so a row inserted for TENANT_A in an earlier case (e.g. the
// 2026-05-10 usage row or the 2026-03-01 paid invoice in the
// finance_betleads_usage/fees cases above) is still present and can shift
// what a later finance_betleads_since assertion for TENANT_A expects.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION_GROUPS);
  await db.exec(MIGRATION_FINANCE);
  await db.exec(MIGRATION_DASHBOARD);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION_DASHBOARD);
  await seed();
});

afterAll(async () => {
  await db.close();
});

describe("finance_betleads_usage", () => {
  it("sums reservations minus refunds per Sao Paulo day", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, amount, created_at) values
        ('${TENANT_A}', 'usage_reservation', -10.00, '2026-10-05T02:30:00Z'),
        ('${TENANT_A}', 'usage_reservation', -5.00, '2026-10-05T15:00:00Z'),
        ('${TENANT_A}', 'usage_refund', 2.00, '2026-10-05T15:00:00Z')
    `);

    const rows = await usageRows([TENANT_A], "2026-10-04", "2026-10-05");
    expect(rows).toHaveLength(2);
    expect(isoDay(rows[0].metric_date)).toBe("2026-10-04");
    expect(Number(rows[0].amount)).toBe(10.0);
    expect(isoDay(rows[1].metric_date)).toBe("2026-10-05");
    expect(Number(rows[1].amount)).toBe(3.0);
  });

  it("a refund on a later day counts on its own day", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, amount, created_at) values
        ('${TENANT_A}', 'usage_reservation', -8, '2026-10-06T15:00:00Z'),
        ('${TENANT_A}', 'usage_refund', 8, '2026-10-07T15:00:00Z')
    `);

    const rows = await usageRows([TENANT_A], "2026-10-06", "2026-10-07");
    expect(rows).toHaveLength(2);
    const day6 = rows.find((r) => isoDay(r.metric_date) === "2026-10-06");
    const day7 = rows.find((r) => isoDay(r.metric_date) === "2026-10-07");
    expect(Number(day6!.amount)).toBe(8);
    expect(Number(day7!.amount)).toBe(-8);
  });

  it("purchase and manual_adjustment rows are ignored", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, amount, created_at) values
        ('${TENANT_B}', 'purchase', 100, '2026-10-08T15:00:00Z'),
        ('${TENANT_B}', 'manual_adjustment', -50, '2026-10-08T15:00:00Z')
    `);

    const rows = await usageRows([TENANT_B], "2026-10-08", "2026-10-08");
    expect(rows).toHaveLength(0);
  });
});

describe("finance_betleads_fees", () => {
  it("sums by month of period_start, open and paid only", async () => {
    await db.query(`
      insert into public.billing_invoices (tenant_id, period_start, amount_cents, status) values
        ('${TENANT_A}', '2026-09-15', 400000, 'paid'),
        ('${TENANT_A}', '2026-10-15', 400000, 'open'),
        ('${TENANT_A}', '2026-10-15', 400000, 'canceled')
    `);

    const { rows } = await db.query<{ tenant_id: string; month: string | Date; amount: string }>(
      `select * from public.finance_betleads_fees(array['${TENANT_A}']::uuid[], '2026-09-01', '2026-10-01') order by month`,
    );

    expect(rows).toHaveLength(2);
    expect(isoDay(rows[0].month)).toBe("2026-09-01");
    expect(Number(rows[0].amount)).toBe(4000);
    expect(isoDay(rows[1].month)).toBe("2026-10-01");
    expect(Number(rows[1].amount)).toBe(4000);
  });
});

describe("finance_betleads_since", () => {
  it("is the earliest usage or invoice date; absent house has no row", async () => {
    await db.exec(`
      insert into public.wallet_ledger (tenant_id, entry_type, amount, created_at) values
        ('${TENANT_A}', 'usage_reservation', -1, '2026-05-10T15:00:00Z');
      insert into public.billing_invoices (tenant_id, period_start, amount_cents, status) values
        ('${TENANT_A}', '2026-03-01', 400000, 'paid');
    `);

    const { rows } = await db.query<{ tenant_id: string; since: string | Date }>(
      `select * from public.finance_betleads_since(array['${TENANT_A}', '${TENANT_NONE}']::uuid[])`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(isoDay(rows[0].since)).toBe("2026-03-01");
  });

  it("a house whose only invoice is canceled and has no usage rows has no row", async () => {
    await db.query(`
      insert into public.billing_invoices (tenant_id, period_start, amount_cents, status) values
        ('${TENANT_B}', '2026-04-01', 400000, 'canceled')
    `);

    const { rows } = await db.query<{ tenant_id: string; since: string | Date }>(
      `select * from public.finance_betleads_since(array['${TENANT_B}']::uuid[])`,
    );

    expect(rows).toHaveLength(0);
  });
});

describe("tenant_finance_other_costs.categoria", () => {
  it("rejects blank and accepts null", async () => {
    await expect(
      db.query(
        `insert into public.tenant_finance_other_costs (tenant_id, month, descricao, valor, categoria) values ('${TENANT_A}', '2026-10-01', 'teste', 10, '   ')`,
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into public.tenant_finance_other_costs (tenant_id, month, descricao, valor, categoria) values ('${TENANT_A}', '2026-10-01', 'teste', 10, null)`,
      ),
    ).resolves.toBeDefined();
  });
});

describe("function grants", () => {
  it("authenticated cannot execute the functions", async () => {
    const { rows } = await db.query<{ ok: boolean }>(`
      select
        has_function_privilege('authenticated', 'public.finance_betleads_usage(uuid[], date, date)', 'execute')
        or has_function_privilege('authenticated', 'public.finance_betleads_fees(uuid[], date, date)', 'execute')
        or has_function_privilege('authenticated', 'public.finance_betleads_since(uuid[])', 'execute')
        as ok
    `);
    expect(rows[0].ok).toBe(false);
  });
});
