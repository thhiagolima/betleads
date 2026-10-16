// Central de Resultados F4 — SQL tests for
// supabase/migrations/20261016180000_player_lifecycle_daily.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261016180000_player_lifecycle_daily.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select true $$;
create table public.tenants (id uuid primary key);
create table public.players (id uuid primary key, tenant_id uuid, created_at timestamptz, ftd_em timestamptz);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  status text, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = "2026-10-10";
const END = "2026-10-11T00:00:00-03:00";

let db: PGlite;

async function states(day: string) {
  await db.query(`select refresh_player_lifecycle_day($1, $2::date)`, [T, day]);
  const { rows } = await db.query<{ state: string; players: number }>(
    `select state, players from player_lifecycle_daily where tenant_id = $1 and metric_date = $2`,
    [T, day],
  );
  return Object.fromEntries(rows.map((row) => [row.state, row.players]));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`
    insert into tenants values ('${T}');
    insert into players values
      ('${id(1)}', '${T}', '2026-09-01', '2026-09-02'),
      ('${id(2)}', '${T}', '2026-09-01', '2026-09-02'),
      ('${id(3)}', '${T}', '2026-09-01', '2026-09-02'),
      ('${id(4)}', '${T}', '2026-09-01', '2026-09-02'),
      ('${id(5)}', '${T}', '2026-09-01', null),
      ('${id(6)}', '${T}', '2026-09-01', '2026-08-01'),
      ('${id(7)}', '${T}', '2026-10-20', null);
    insert into deposits (tenant_id, player_id, status, created_at) values
      ('${T}', '${id(1)}', 'aprovado', '${END}'::timestamptz - interval '10 hours'),
      ('${T}', '${id(2)}', 'aprovado', '${END}'::timestamptz - interval '3 days'),
      ('${T}', '${id(3)}', 'aprovado', '${END}'::timestamptz - interval '10 days'),
      ('${T}', '${id(4)}', 'aprovado', '${END}'::timestamptz - interval '40 days'),
      ('${T}', '${id(4)}', 'pendente', '${END}'::timestamptz - interval '1 hour'),
      ('${T}', '${id(2)}', 'aprovado', '${END}'::timestamptz + interval '1 hour');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("player_lifecycle_daily", () => {
  it("places each player in the state they were at the end of the day", async () => {
    expect(await states(DAY)).toEqual({
      ativo: 1,
      esfriando: 1,
      dormindo: 1,
      perdido: 1,
      sem_ftd: 1,
      sem_historico: 1,
    });
  });

  it("ignores deposits after the day and players created later", async () => {
    // id 2 deposits one hour after the day ends: still cooling down that day.
    const result = await states(DAY);
    expect(result.esfriando).toBe(1);
    expect(Object.values(result).reduce((sum, value) => sum + value, 0)).toBe(6);
  });

  it("rebuilds an earlier day from the history", async () => {
    // The same players, rebuilt for an earlier day from the deposit history.
    const result = await states("2026-10-01");
    expect(Object.values(result).reduce((sum, value) => sum + value, 0)).toBe(6);
    expect(result.sem_ftd).toBe(1);
  });
});
