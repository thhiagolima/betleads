// SQL test for supabase/migrations/20261114100100_finance_other_costs_dated.sql:
// tenant_finance_other_costs gains cost_date (backfilled from month),
// repeat_monthly and series_id; finance_materialize_recurring_costs copies a
// repeating cost into the next month on the same day (clamped to the month's
// last day), once, and is scheduled with pg_cron. Same stub schema as
// finance-monthly-ggr.db.test.ts, plus a pg_cron stand-in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(resolve(__dirname, "../..", "supabase/migrations", name), "utf8");
const MIGRATION_GROUPS = migration("20261101100000_tenant_groups.sql");
const MIGRATION_FINANCE = migration("20261101100100_tenant_finance.sql");
// pg_cron is a stand-in schema here, not an extension.
const MIGRATION_DATED = migration("20261114100100_finance_other_costs_dated.sql").replace(
  /create extension[^;]*;/gi,
  "",
);

const TENANT_A = "00000000-0000-4000-8000-00000000b0a1";
const LEGACY_ID = "00000000-0000-4000-8000-00000000c001";
const CREATOR = "00000000-0000-4000-8000-0000000000e2";

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

  -- pg_cron stand-in.
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
  CREATE FUNCTION cron.schedule(_name text, _schedule text, _command text) RETURNS bigint
    LANGUAGE sql AS $f$
      INSERT INTO cron.job (jobname, schedule, command) VALUES (_name, _schedule, _command)
      RETURNING jobid
    $f$;
  CREATE FUNCTION cron.unschedule(_jobid bigint) RETURNS boolean
    LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobid = _jobid RETURNING true $f$;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`ALTER ROLE service_role BYPASSRLS`);
  await db.exec(MIGRATION_GROUPS);
  await db.exec(MIGRATION_FINANCE);
  // categoria comes from 20261103100000_finance_dashboard.sql (whose other
  // functions need billing tables this stub schema does not have).
  await db.exec(`
    alter table public.tenant_finance_other_costs add column if not exists categoria text null;
    INSERT INTO public.tenants (id, nome, is_demo) VALUES ('${TENANT_A}', 'Casa A', false);
    -- A cost from before the migration: month only.
    INSERT INTO public.tenant_finance_other_costs (id, tenant_id, month, descricao, valor)
      VALUES ('${LEGACY_ID}', '${TENANT_A}', '2026-09-01', 'Legado', 10);
  `);
  await db.exec(MIGRATION_DATED);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION_DATED);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`delete from public.tenant_finance_other_costs where id <> '${LEGACY_ID}'`);
});

let seq = 0;
/** Inserts a cost; with `repeat`, it starts a series (series_id = id). */
async function addCost(costDate: string, options: { repeat?: boolean; seriesOf?: string } = {}) {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const repeat = options.repeat ?? false;
  const seriesId = options.seriesOf ?? (repeat ? id : null);
  await db.query(
    `insert into public.tenant_finance_other_costs
       (id, tenant_id, month, cost_date, descricao, valor, categoria, repeat_monthly, series_id, created_by)
     values ($1, $2, date_trunc('month', $3::date)::date, $3::date, 'Equipe', 1500, 'Equipe', $4, $5, $6)`,
    [id, TENANT_A, costDate, repeat, seriesId, CREATOR],
  );
  return id;
}

const materialize = async (today: string) => {
  const { rows } = await db.query<{ n: number }>(
    `select public.finance_materialize_recurring_costs($1::date) as n`,
    [today],
  );
  return rows[0].n;
};

async function series(seriesId: string) {
  const { rows } = await db.query<{
    cost_date: string;
    month: string;
    descricao: string;
    valor: string;
    categoria: string | null;
    repeat_monthly: boolean;
    created_by: string | null;
  }>(
    `select cost_date::text, month::text, descricao, valor::text, categoria, repeat_monthly, created_by
       from public.tenant_finance_other_costs where series_id = $1 order by cost_date`,
    [seriesId],
  );
  return rows;
}

describe("tenant_finance_other_costs dated", () => {
  it("backfill sets cost_date to month", async () => {
    const { rows } = await db.query<{
      cost_date: string;
      repeat_monthly: boolean;
      series_id: string | null;
    }>(
      `select cost_date::text, repeat_monthly, series_id
         from public.tenant_finance_other_costs where id = $1`,
      [LEGACY_ID],
    );
    expect(rows).toEqual([{ cost_date: "2026-09-01", repeat_monthly: false, series_id: null }]);
    // cost_date must fall inside month.
    await expect(
      db.query(
        `insert into public.tenant_finance_other_costs (tenant_id, month, cost_date, descricao, valor)
         values ('${TENANT_A}', '2026-09-01', '2026-10-05', 'x', 1)`,
      ),
    ).rejects.toThrow();
  });

  it("an insert or update that only knows month keeps cost_date in that month (app before deploy)", async () => {
    const { rows } = await db.query<{ id: string; cost_date: string }>(
      `insert into public.tenant_finance_other_costs (tenant_id, month, descricao, valor)
       values ('${TENANT_A}', '2026-08-01', 'Antigo', 5) returning id, cost_date::text`,
    );
    expect(rows[0].cost_date).toBe("2026-08-01");
    const { rows: moved } = await db.query<{ cost_date: string }>(
      `update public.tenant_finance_other_costs set month = '2026-07-01'
        where id = $1 returning cost_date::text`,
      [rows[0].id],
    );
    expect(moved[0].cost_date).toBe("2026-07-01");
  });

  it("materialize creates next month copy on the same day", async () => {
    const origin = await addCost("2026-09-15", { repeat: true });
    expect(await materialize("2026-10-20")).toBe(1);
    expect(await series(origin)).toEqual([
      expect.objectContaining({ cost_date: "2026-09-15", created_by: CREATOR }),
      {
        cost_date: "2026-10-15",
        month: "2026-10-01",
        descricao: "Equipe",
        valor: "1500.00",
        categoria: "Equipe",
        repeat_monthly: true,
        created_by: null,
      },
    ]);
    // A cost without repeat is never copied.
    await addCost("2026-10-03");
    expect(await materialize("2026-11-20")).toBe(1);
    expect((await series(origin)).map((row) => row.cost_date)).toEqual([
      "2026-09-15",
      "2026-10-15",
      "2026-11-15",
    ]);
  });

  it("day 31 clamps to 30 and to Feb 28/29", async () => {
    const origin = await addCost("2026-10-31", { repeat: true });
    expect(await materialize("2026-11-30")).toBe(1);
    expect(await materialize("2026-12-31")).toBe(1);
    expect(await materialize("2027-01-31")).toBe(1);
    expect(await materialize("2027-02-28")).toBe(1);
    expect((await series(origin)).map((row) => row.cost_date)).toEqual([
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);

    // (The first series would also get a 2028-02 copy: drop it.)
    await db.query(`delete from public.tenant_finance_other_costs where series_id = $1`, [origin]);
    const leap = await addCost("2028-01-31", { repeat: true });
    expect(await materialize("2028-02-29")).toBe(1);
    expect((await series(leap)).map((row) => row.cost_date)).toEqual(["2028-01-31", "2028-02-29"]);
  });

  it("a series anchored on the 31st yields Feb 28 then Mar 31 (no drift)", async () => {
    const origin = await addCost("2027-01-31", { repeat: true });
    expect(await materialize("2027-02-28")).toBe(1);
    // The anchor stays the series' earliest day (31), not February's 28.
    expect(await materialize("2027-03-30")).toBe(0);
    expect(await materialize("2027-03-31")).toBe(1);
    expect((await series(origin)).map((row) => row.cost_date)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
  });

  it("a back-dated series creates every missing month up to today's", async () => {
    const origin = await addCost("2026-08-12", { repeat: true });
    expect(await materialize("2026-10-12")).toBe(2);
    expect((await series(origin)).map((row) => row.cost_date)).toEqual([
      "2026-08-12",
      "2026-09-12",
      "2026-10-12",
    ]);
    // Before the current month's day, only the past months are created.
    const later = await addCost("2026-07-20", { repeat: true });
    expect(await materialize("2026-10-19")).toBe(2);
    expect((await series(later)).map((row) => row.cost_date)).toEqual([
      "2026-07-20",
      "2026-08-20",
      "2026-09-20",
    ]);
    expect(await materialize("2026-10-19")).toBe(0);
  });

  it("a skipped month (valor 0) does not carry 0 into the next copy", async () => {
    const origin = await addCost("2026-08-05", { repeat: true });
    expect(await materialize("2026-09-05")).toBe(1);
    await db.query(
      `update public.tenant_finance_other_costs set valor = 0 where series_id = $1 and month = '2026-09-01'`,
      [origin],
    );
    expect(await materialize("2026-10-05")).toBe(1);
    expect((await series(origin)).map((row) => [row.cost_date, row.valor])).toEqual([
      ["2026-08-05", "1500.00"],
      ["2026-09-05", "0.00"],
      ["2026-10-05", "1500.00"],
    ]);
  });

  it("running twice creates nothing new", async () => {
    const origin = await addCost("2026-09-10", { repeat: true });
    expect(await materialize("2026-10-10")).toBe(1);
    expect(await materialize("2026-10-10")).toBe(0);
    expect(await materialize("2026-10-25")).toBe(0);
    expect(await series(origin)).toHaveLength(2);
    // The unique (series_id, month) index refuses a second copy in a month.
    await expect(addCost("2026-10-20", { seriesOf: origin })).rejects.toThrow();
  });

  it("turning repeat off on the latest stops the series", async () => {
    const origin = await addCost("2026-09-10", { repeat: true });
    expect(await materialize("2026-10-12")).toBe(1);
    await db.query(
      `update public.tenant_finance_other_costs set repeat_monthly = false
        where series_id = $1 and month = '2026-10-01'`,
      [origin],
    );
    expect(await materialize("2026-11-12")).toBe(0);
    expect(await series(origin)).toHaveLength(2);
  });

  it("not before the target day", async () => {
    const origin = await addCost("2026-09-20", { repeat: true });
    expect(await materialize("2026-10-19")).toBe(0);
    expect(await series(origin)).toHaveLength(1);
    expect(await materialize("2026-10-20")).toBe(1);
  });

  it("is service_role only and scheduled daily with pg_cron", async () => {
    const { rows: grants } = await db.query<{ role: string; allowed: boolean }>(
      `select r as role,
              has_function_privilege(r, 'public.finance_materialize_recurring_costs(date)', 'execute') as allowed
         from unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(grants).toEqual([
      { role: "anon", allowed: false },
      { role: "authenticated", allowed: false },
      { role: "service_role", allowed: true },
    ]);
    const { rows: jobs } = await db.query<{ schedule: string; command: string }>(
      `select schedule, command from cron.job where jobname = 'finance-recurring-costs'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBe("10 3 * * *");
    expect(jobs[0].command).toContain("public.finance_materialize_recurring_costs()");
  });
});
