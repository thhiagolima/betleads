// Task 2 — SQL test for
// supabase/migrations/20261101100100_tenant_finance.sql:
// tenant_finance_daily, tenant_finance_other_costs, tenant_finance_rates,
// tenant_finance_viewers, tenant_goals, the finance_can_* permission
// functions and the finance_days / finance_goal_days data functions.
//
// Builds on Task 1's migration (tenant_groups) for group-manager access.

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

const TENANT_A = "00000000-0000-4000-8000-00000000b0a1";
const TENANT_B = "00000000-0000-4000-8000-00000000b0a2";

const GROUP_A = "00000000-0000-4000-9000-0000000000b1";
const GROUP_B = "00000000-0000-4000-9000-0000000000b2";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000e1";
const ADMIN_A = "00000000-0000-4000-8000-0000000000e2";
const GESTOR_A_NO_GRANT = "00000000-0000-4000-8000-0000000000e3";
const GESTOR_A_GRANT = "00000000-0000-4000-8000-0000000000e4";
const MEMBER_A_GRANT = "00000000-0000-4000-8000-0000000000e5";
const MANAGER_A = "00000000-0000-4000-8000-0000000000e6";

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

async function seed() {
  await db.exec(`
    INSERT INTO public.tenants (id, nome, is_demo) VALUES
      ('${TENANT_A}', 'Casa A', false),
      ('${TENANT_B}', 'Casa B', false);

    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${SUPER_ADMIN}', '{}'::jsonb),
      ('${ADMIN_A}', '{}'::jsonb),
      ('${GESTOR_A_NO_GRANT}', '{}'::jsonb),
      ('${GESTOR_A_GRANT}', '{}'::jsonb),
      ('${MEMBER_A_GRANT}', '{}'::jsonb),
      ('${MANAGER_A}', '{}'::jsonb);

    INSERT INTO public.user_roles (id, user_id, tenant_id, role) VALUES
      ('00000000-0000-4000-8000-0000000101a1', '${SUPER_ADMIN}', NULL, 'super_admin'),
      ('00000000-0000-4000-8000-0000000101a2', '${ADMIN_A}', '${TENANT_A}', 'admin'),
      ('00000000-0000-4000-8000-0000000101a3', '${GESTOR_A_NO_GRANT}', '${TENANT_A}', 'gestor'),
      ('00000000-0000-4000-8000-0000000101a4', '${GESTOR_A_GRANT}', '${TENANT_A}', 'gestor'),
      ('00000000-0000-4000-8000-0000000101a5', '${MEMBER_A_GRANT}', '${TENANT_A}', 'member');

    INSERT INTO public.tenant_finance_viewers (tenant_id, user_id, granted_by) VALUES
      ('${TENANT_A}', '${GESTOR_A_GRANT}', '${ADMIN_A}'),
      ('${TENANT_A}', '${MEMBER_A_GRANT}', '${ADMIN_A}');

    INSERT INTO public.tenant_groups (id, nome, is_demo) VALUES
      ('${GROUP_A}', 'Grupo A', false),
      ('${GROUP_B}', 'Grupo B', false);

    INSERT INTO public.tenant_group_tenants (group_id, tenant_id) VALUES
      ('${GROUP_A}', '${TENANT_A}'),
      ('${GROUP_B}', '${TENANT_B}');

    INSERT INTO public.tenant_group_managers (group_id, user_id) VALUES
      ('${GROUP_A}', '${MANAGER_A}');
  `);
}

/** Runs `sql` inside a rolled-back transaction, impersonating `role` with the
 * given JWT claims (or no claims at all when `claims` is omitted). */
async function asRole(
  role: "postgres" | "anon" | "authenticated" | "service_role",
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
    if (role !== "postgres") {
      await db.exec(`SET LOCAL ROLE ${role}`);
    }
    return await db.query(sql);
  } finally {
    await db.query("ROLLBACK");
  }
}

async function financeCanView(user: string, tenant: string) {
  const { rows } = await db.query<{ v: boolean }>(
    `select public.finance_can_view('${user}', '${tenant}') as v`,
  );
  return rows[0].v;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION_GROUPS);
  await db.exec(MIGRATION_FINANCE);
  // Idempotent: a second run of both migrations changes nothing and does not fail.
  await db.exec(MIGRATION_GROUPS);
  await db.exec(MIGRATION_FINANCE);
  await seed();
});

afterAll(async () => {
  await db.close();
});

describe("finance_can_view", () => {
  it("admin true; gestor sem liberação false; gestor com liberação true; gestor de grupo true; gestor do grupo G1 numa casa de G2 false; super admin true; member com liberação false", async () => {
    expect(await financeCanView(ADMIN_A, TENANT_A)).toBe(true);
    expect(await financeCanView(GESTOR_A_NO_GRANT, TENANT_A)).toBe(false);
    expect(await financeCanView(GESTOR_A_GRANT, TENANT_A)).toBe(true);
    expect(await financeCanView(MANAGER_A, TENANT_A)).toBe(true);
    expect(await financeCanView(MANAGER_A, TENANT_B)).toBe(false);
    expect(await financeCanView(SUPER_ADMIN, TENANT_A)).toBe(true);
    expect(await financeCanView(MEMBER_A_GRANT, TENANT_A)).toBe(false);
  });
});

describe("finance_can_edit_values", () => {
  it("group manager is false", async () => {
    const { rows } = await db.query<{ v: boolean }>(
      `select public.finance_can_edit_values('${MANAGER_A}', '${TENANT_A}') as v`,
    );
    expect(rows[0].v).toBe(false);
  });
});

describe("finance_can_manage_goals", () => {
  it("tenant admin is false, group manager true", async () => {
    const { rows: adminRows } = await db.query<{ v: boolean }>(
      `select public.finance_can_manage_goals('${ADMIN_A}', '${TENANT_A}') as v`,
    );
    expect(adminRows[0].v).toBe(false);

    const { rows: managerRows } = await db.query<{ v: boolean }>(
      `select public.finance_can_manage_goals('${MANAGER_A}', '${TENANT_A}') as v`,
    );
    expect(managerRows[0].v).toBe(true);
  });
});

type FinanceDayRow = {
  tenant_id: string;
  metric_date: string | Date;
  registrations: number;
  ftds: number;
  ftd_deposit_amount: string;
  deposit_amount: string;
  withdrawal_amount: string;
  ad_spend: string | null;
  ad_spend_suggested: string | null;
  ggr: string | null;
  ggr_fee_pct: string;
  movement_fee_pct: string;
};

function isoDay(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function financeDays(tenants: string[], from: string, to: string) {
  const { rows } = await db.query<FinanceDayRow>(
    `select * from public.finance_days(array[${tenants.map((t) => `'${t}'`).join(",")}]::uuid[], '${from}', '${to}') order by tenant_id, metric_date`,
  );
  return rows;
}

describe("finance_days", () => {
  it("returns one row per tenant-day with CRM zeros", async () => {
    const rows = await financeDays([TENANT_A, TENANT_B], "2026-01-01", "2026-01-03");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.registrations).toBe(0);
      expect(row.ftds).toBe(0);
      expect(Number(row.ftd_deposit_amount)).toBe(0);
      expect(Number(row.deposit_amount)).toBe(0);
      expect(Number(row.withdrawal_amount)).toBe(0);
      expect(row.ad_spend).toBeNull();
      expect(row.ggr).toBeNull();
    }
  });

  it("uses the rate valid on each day", async () => {
    await db.query(`
      insert into public.tenant_finance_rates (tenant_id, valid_from, ggr_fee_pct, movement_fee_pct) values
        ('${TENANT_A}', '2026-02-01', 16, 2.7),
        ('${TENANT_A}', '2026-02-10', 18, 3.0)
    `);

    const rows = await financeDays([TENANT_A, TENANT_B], "2026-02-09", "2026-02-10");
    const day9A = rows.find((r) => r.tenant_id === TENANT_A && isoDay(r.metric_date) === "2026-02-09");
    const day10A = rows.find((r) => r.tenant_id === TENANT_A && isoDay(r.metric_date) === "2026-02-10");
    const day9B = rows.find((r) => r.tenant_id === TENANT_B && isoDay(r.metric_date) === "2026-02-09");

    expect(Number(day9A!.ggr_fee_pct)).toBe(16);
    expect(Number(day9A!.movement_fee_pct)).toBe(2.7);
    expect(Number(day10A!.ggr_fee_pct)).toBe(18);
    expect(Number(day10A!.movement_fee_pct)).toBe(3.0);
    expect(Number(day9B!.ggr_fee_pct)).toBe(16);
    expect(Number(day9B!.movement_fee_pct)).toBe(2.7);
  });

  it("sums only the first approved deposit of players whose ftd_em is that day", async () => {
    const player = "00000000-0000-4000-8000-0000000202a1";
    await db.exec(`
      insert into public.players (id, tenant_id, ftd_em) values
        ('${player}', '${TENANT_A}', '2026-03-05 15:00:00Z');

      -- The pending deposit is EARLIEST in time: if the status='aprovado'
      -- filter were missing, it (999) would win instead of the first
      -- approved deposit (50).
      insert into public.deposits (id, tenant_id, player_id, valor, status, created_at) values
        ('00000000-0000-4000-8000-0000000202b3', '${TENANT_A}', '${player}', 999, 'pendente', '2026-03-05 15:00:00Z'),
        ('00000000-0000-4000-8000-0000000202b1', '${TENANT_A}', '${player}', 50, 'aprovado', '2026-03-05 15:05:00Z'),
        ('00000000-0000-4000-8000-0000000202b2', '${TENANT_A}', '${player}', 100, 'aprovado', '2026-03-05 16:00:00Z');
    `);

    const rows = await financeDays([TENANT_A], "2026-03-05", "2026-03-05");
    expect(Number(rows[0].ftd_deposit_amount)).toBe(50);
  });

  it("orders by coalesce(completed_at, created_at), not created_at alone", async () => {
    const player = "00000000-0000-4000-8000-0000000202c1";
    await db.exec(`
      insert into public.players (id, tenant_id, ftd_em) values
        ('${player}', '${TENANT_A}', '2026-03-06 15:00:00Z');

      -- Created earlier but completed later (200) vs created later but
      -- completed earlier (300): the first APPROVED deposit by completion
      -- time is 300, not 200 (which created_at alone would pick).
      insert into public.deposits (id, tenant_id, player_id, valor, status, created_at, completed_at) values
        ('00000000-0000-4000-8000-0000000202c2', '${TENANT_A}', '${player}', 200, 'aprovado', '2026-03-06 10:00:00Z', '2026-03-06 12:00:00Z'),
        ('00000000-0000-4000-8000-0000000202c3', '${TENANT_A}', '${player}', 300, 'aprovado', '2026-03-06 11:00:00Z', '2026-03-06 10:30:00Z');
    `);

    const rows = await financeDays([TENANT_A], "2026-03-06", "2026-03-06");
    expect(Number(rows[0].ftd_deposit_amount)).toBe(300);
  });

  it("ftd day boundary is Sao Paulo", async () => {
    const player = "00000000-0000-4000-8000-0000000303a1";
    await db.exec(`
      insert into public.players (id, tenant_id, ftd_em) values
        ('${player}', '${TENANT_A}', '2026-04-06 02:30:00Z');

      insert into public.deposits (id, tenant_id, player_id, valor, status, created_at) values
        ('00000000-0000-4000-8000-0000000303b1', '${TENANT_A}', '${player}', 77, 'aprovado', '2026-04-06 02:35:00Z');
    `);

    const rows = await financeDays([TENANT_A], "2026-04-05", "2026-04-06");
    const day5 = rows.find((r) => isoDay(r.metric_date) === "2026-04-05");
    const day6 = rows.find((r) => isoDay(r.metric_date) === "2026-04-06");
    expect(Number(day5!.ftd_deposit_amount)).toBe(77);
    expect(Number(day6!.ftd_deposit_amount)).toBe(0);
  });

  it("excludes an FTD outside the requested window and one in an unrequested house", async () => {
    const outsideWindowPlayer = "00000000-0000-4000-8000-0000000404a1";
    const otherHousePlayer = "00000000-0000-4000-8000-0000000404a2";
    await db.exec(`
      -- Player with an FTD day well outside the [_from, _to] window below.
      insert into public.players (id, tenant_id, ftd_em) values
        ('${outsideWindowPlayer}', '${TENANT_A}', '2026-04-20 15:00:00Z');
      insert into public.deposits (id, tenant_id, player_id, valor, status, created_at) values
        ('00000000-0000-4000-8000-0000000404b1', '${TENANT_A}', '${outsideWindowPlayer}', 500, 'aprovado', '2026-04-20 15:05:00Z');

      -- Player whose FTD falls inside the window but in a house (TENANT_B)
      -- that is not in the requested _tenants array.
      insert into public.players (id, tenant_id, ftd_em) values
        ('${otherHousePlayer}', '${TENANT_B}', '2026-04-10 15:00:00Z');
      insert into public.deposits (id, tenant_id, player_id, valor, status, created_at) values
        ('00000000-0000-4000-8000-0000000404b2', '${TENANT_B}', '${otherHousePlayer}', 700, 'aprovado', '2026-04-10 15:05:00Z');
    `);

    const rows = await financeDays([TENANT_A], "2026-04-10", "2026-04-10");
    expect(Number(rows[0].ftd_deposit_amount)).toBe(0);
  });
});

describe("finance_goal_days", () => {
  it("applies goal history and removal", async () => {
    await db.query(`
      insert into public.tenant_goals (tenant_id, metric, valid_from, direction, daily_value) values
        ('${TENANT_A}', 'ftds', '2026-05-01', 'gte', 100),
        ('${TENANT_A}', 'ftds', '2026-05-10', 'gte', 120),
        ('${TENANT_A}', 'ftds', '2026-05-20', 'gte', NULL)
    `);

    const { rows } = await db.query<{
      tenant_id: string;
      metric_date: string | Date;
      metric: string;
      direction: string;
      daily_value: string;
    }>(
      `select * from public.finance_goal_days(array['${TENANT_A}']::uuid[], '2026-05-09', '2026-05-20') where metric = 'ftds' order by metric_date`,
    );

    const byDay = new Map(rows.map((r) => [isoDay(r.metric_date), r]));
    expect(Number(byDay.get("2026-05-09")!.daily_value)).toBe(100);
    expect(Number(byDay.get("2026-05-10")!.daily_value)).toBe(120);
    expect(byDay.has("2026-05-20")).toBe(false);
  });
});

describe("RLS", () => {
  it("authenticated gestor without grant reads no tenant_finance_daily rows, but the admin (positive control) reads it", async () => {
    await db.query(`
      insert into public.tenant_finance_daily (tenant_id, metric_date, ad_spend, ggr) values
        ('${TENANT_A}', '2026-06-01', 100, 50)
    `);

    const { rows: noGrantRows } = await asRole(
      "authenticated",
      { sub: GESTOR_A_NO_GRANT, role: "authenticated" },
      `select * from public.tenant_finance_daily where tenant_id = '${TENANT_A}'`,
    );
    expect(noGrantRows).toEqual([]);

    const { rows: adminRows } = await asRole(
      "authenticated",
      { sub: ADMIN_A, role: "authenticated" },
      `select * from public.tenant_finance_daily where tenant_id = '${TENANT_A}' and metric_date = '2026-06-01'`,
    );
    expect(adminRows).toHaveLength(1);
  });
});

describe("function grants", () => {
  it("anon cannot execute finance_days", async () => {
    await expect(
      asRole(
        "anon",
        undefined,
        `select * from public.finance_days(array['${TENANT_A}']::uuid[], '2026-01-01', '2026-01-01')`,
      ),
    ).rejects.toThrow();
  });
});
