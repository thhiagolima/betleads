// Central de Resultados F3 — SQL tests for
// supabase/migrations/20261016140000_journey_holdout.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261016140000_journey_holdout.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists auth;
create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select false $$;
create table public.tenants (id uuid primary key);
create table public.journeys (id uuid primary key, tenant_id uuid);
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid,
  player_id uuid, entered_at timestamptz not null default now());
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const J = "00000000-0000-4000-8000-0000000000a1";
const OFF = "00000000-0000-4000-8000-0000000000a2";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate deposits, journey_enrollments, journeys, tenants;
    insert into tenants values ('${T}');
    insert into journeys (id, tenant_id, holdout_percent) values ('${J}', '${T}', 10), ('${OFF}', '${T}', 0);
  `);
});

async function enroll(journey: string, count: number, enteredAt = "now() - interval '10 days'") {
  await db.exec(`
    insert into journey_enrollments (tenant_id, journey_id, player_id, entered_at)
    select '${T}', '${journey}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${enteredAt}
    from generate_series(1, ${count}) g;
  `);
}

describe("holdout assignment", () => {
  it("puts about the configured share of players in the control group", async () => {
    await enroll(J, 2000);
    const [{ share }] = (
      await db.query<{ share: number }>(
        `select avg(case when is_holdout then 1 else 0 end)::float share from journey_enrollments where journey_id = $1`,
        [J],
      )
    ).rows;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
  });

  it("never assigns control players when the journey has no holdout", async () => {
    await enroll(OFF, 500);
    const { rows } = await db.query(
      `select 1 from journey_enrollments where journey_id = $1 and is_holdout`,
      [OFF],
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps the same player in the same group on re-entry", async () => {
    await enroll(J, 300);
    const first = (
      await db.query<{ player_id: string; is_holdout: boolean }>(
        `select player_id, is_holdout from journey_enrollments where journey_id = $1 order by player_id`,
        [J],
      )
    ).rows;
    await db.exec(`delete from journey_enrollments`);
    await enroll(J, 300, "now()");
    const second = (
      await db.query<{ player_id: string; is_holdout: boolean }>(
        `select player_id, is_holdout from journey_enrollments where journey_id = $1 order by player_id`,
        [J],
      )
    ).rows;
    expect(second).toEqual(first);
  });
});

describe("journey_holdout_results", () => {
  it("compares the 7-day return of treated and control players", async () => {
    await enroll(J, 1000);
    // Every player number divisible by 4 deposits 3 days after entering.
    await db.exec(`
      insert into deposits (tenant_id, player_id, valor, status, created_at)
      select '${T}', player_id, 50, 'aprovado', entered_at + interval '3 days'
      from journey_enrollments where right(player_id::text, 4)::int % 4 = 0;
      insert into deposits (tenant_id, player_id, valor, status, created_at)
      select '${T}', player_id, 999, 'aprovado', entered_at + interval '9 days'
      from journey_enrollments;
    `);
    const { rows } = await db.query<{
      is_holdout: boolean;
      players: string;
      returned: string;
      revenue: string;
    }>(`select * from journey_holdout_results($1, now() - interval '30 days', now())`, [T]);
    const total = rows.reduce((sum, row) => sum + Number(row.players), 0);
    const returned = rows.reduce((sum, row) => sum + Number(row.returned), 0);
    expect(total).toBe(1000);
    expect(returned).toBe(250);
    // Deposits after the 7-day window never count.
    expect(rows.reduce((sum, row) => sum + Number(row.revenue), 0)).toBe(250 * 50);
    expect(rows.map((row) => row.is_holdout).sort()).toEqual([false, true]);
  });

  it("leaves out entries whose window has not closed yet", async () => {
    await enroll(J, 200, "now() - interval '2 days'");
    const { rows } = await db.query(
      `select * from journey_holdout_results($1, now() - interval '30 days', now())`,
      [T],
    );
    expect(rows).toHaveLength(0);
  });

  it("ignores journeys without control players", async () => {
    await enroll(OFF, 200);
    const { rows } = await db.query(
      `select * from journey_holdout_results($1, now() - interval '30 days', now())`,
      [T],
    );
    expect(rows).toHaveLength(0);
  });

  it("returns nothing to a user of another tenant", async () => {
    await db.exec(
      `create or replace function auth.role() returns text language sql as $$ select 'authenticated'::text $$;`,
    );
    await enroll(J, 200);
    const { rows } = await db.query(
      `select * from journey_holdout_results($1, now() - interval '30 days', now())`,
      [T],
    );
    expect(rows).toHaveLength(0);
    await db.exec(
      `create or replace function auth.role() returns text language sql as $$ select 'service_role'::text $$;`,
    );
  });
});
