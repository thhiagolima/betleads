// Central de Resultados F4 — SQL tests for
// supabase/migrations/20261016150000_crm_retention_acquisition.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261016150000_crm_retention_acquisition.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists auth;
create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select false $$;
create table public.players (
  id uuid primary key, tenant_id uuid, created_at timestamptz, ftd_em timestamptz,
  ultimo_deposito timestamptz, utm_source text);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  const ftd = "date_trunc('week', now()) - interval '42 days' + interval '1 day'";
  await db.exec(`
    -- Cohort ~6 weeks ago: P1 deposits again 3 days later, P2 never does.
    insert into players values
      ('${id(1)}', '${T}', ${ftd} - interval '1 day', ${ftd}, ${ftd} + interval '3 days', null),
      ('${id(2)}', '${T}', ${ftd} - interval '1 day', ${ftd}, ${ftd}, null),
      -- Old depositor: first deposit in our history is not an FTD.
      ('${id(3)}', '${T}', now() - interval '200 days', now() - interval '100 days', now() - interval '20 days', null),
      -- Recent sign-ups for the funnel.
      ('${id(4)}', '${T}', now() - interval '5 days', now() - interval '4 days', now() - interval '1 hour', 'google'),
      ('${id(5)}', '${T}', now() - interval '5 days', now() - interval '5 days' + interval '2 hours', now() - interval '3 days', 'google'),
      ('${id(6)}', '${T}', now() - interval '2 days', null, null, ''),
      ('${id(7)}', '${T}', now() - interval '400 days', null, null, null);
    insert into deposits (tenant_id, player_id, valor, status, created_at) values
      ('${T}', '${id(1)}', 20, 'aprovado', ${ftd}),
      ('${T}', '${id(1)}', 30, 'aprovado', ${ftd} + interval '3 days'),
      ('${T}', '${id(2)}', 20, 'aprovado', ${ftd}),
      ('${T}', '${id(3)}', 50, 'aprovado', now() - interval '20 days'),
      ('${T}', '${id(4)}', 10, 'aprovado', now() - interval '4 days'),
      ('${T}', '${id(4)}', 10, 'aprovado', now() - interval '2 days'),
      ('${T}', '${id(4)}', 10, 'aprovado', now() - interval '1 hour'),
      ('${T}', '${id(5)}', 10, 'aprovado', now() - interval '5 days' + interval '2 hours'),
      ('${T}', '${id(5)}', 99, 'pendente', now() - interval '1 day');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("crm_retention_cohorts", () => {
  it("measures the second deposit of real first-time depositors", async () => {
    const { rows } = await db.query<{
      cohort_size: string;
      second_7d_pct: string;
      second_30d_pct: string | null;
      revenue_30d: string | null;
    }>(`select * from crm_retention_cohorts($1, 12) order by cohort_week`, [T]);
    const old = rows[0];
    expect(Number(old.cohort_size)).toBe(2);
    expect(Number(old.second_7d_pct)).toBe(50);
    expect(Number(old.second_30d_pct)).toBe(50);
    expect(Number(old.revenue_30d)).toBe(70);
    // The old depositor (id 3) is never a cohort member.
    const total = rows.reduce((sum, row) => sum + Number(row.cohort_size), 0);
    expect(total).toBe(4);
  });

  it("does not report a 30-day rate before the window closed", async () => {
    const { rows } = await db.query<{ second_30d_pct: string | null }>(
      `select * from crm_retention_cohorts($1, 12) order by cohort_week desc limit 1`,
      [T],
    );
    expect(rows[0].second_30d_pct).toBeNull();
  });
});

describe("crm_acquisition_funnel", () => {
  it("follows sign-ups to their first, second and third deposit", async () => {
    const { rows } = await db.query<{
      origin: string;
      signups: string;
      first_deposit: string;
      second_deposit: string;
      third_plus: string;
    }>(`select * from crm_acquisition_funnel($1, now() - interval '30 days', now())`, [T]);
    const counts = (origin: string) => {
      const row = rows.find((item) => item.origin === origin);
      return (
        row && [row.signups, row.first_deposit, row.second_deposit, row.third_plus].map(Number)
      );
    };
    expect(counts("__total__")).toEqual([3, 2, 1, 1]);
    expect(counts("google")).toEqual([2, 2, 1, 1]);
    expect(counts("(sem origem)")).toEqual([1, 0, 0, 0]);
  });
});

describe("crm_lifecycle_snapshot", () => {
  it("places every player of the tenant in one state", async () => {
    const { rows } = await db.query<{ state: string; players: string }>(
      `select * from crm_lifecycle_snapshot($1)`,
      [T],
    );
    const byState = Object.fromEntries(rows.map((row) => [row.state, Number(row.players)]));
    expect(byState).toMatchObject({ ativo: 1, esfriando: 1, dormindo: 1, perdido: 2, sem_ftd: 2 });
  });

  it("returns nothing to a user without access to the tenant", async () => {
    await db.exec(
      `create or replace function auth.role() returns text language sql as $$ select 'authenticated'::text $$;`,
    );
    const { rows } = await db.query(`select * from crm_lifecycle_snapshot($1)`, [T]);
    expect(rows).toHaveLength(0);
    await db.exec(
      `create or replace function auth.role() returns text language sql as $$ select 'service_role'::text $$;`,
    );
  });
});
