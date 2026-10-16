// P3 — SQL tests for supabase/migrations/20261016160000_journey_activation_estimate.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261016160000_journey_activation_estimate.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists auth;
create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select false $$;
create table public.journeys (
  id uuid primary key, tenant_id uuid, trigger_type text,
  trigger_config jsonb not null default '{}', exit_rules jsonb not null default '{}');
create table public.journey_steps (journey_id uuid, position integer, step_type text, is_enabled boolean default true);
create function public.journey_requires_phone(p_journey_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.journey_steps where journey_id = p_journey_id and is_enabled and step_type = 'sms')
     and not exists (select 1 from public.journey_steps where journey_id = p_journey_id and is_enabled and step_type in ('email','voice'));
$$;
create table public.players (
  id uuid primary key, tenant_id uuid, telefone text, ultimo_login timestamptz, ultimo_jogo timestamptz,
  ultimo_deposito timestamptz, ftd_em timestamptz, total_depositado numeric);
create table public.journey_enrollments (journey_id uuid, player_id uuid, status text);
create table public.deposits (tenant_id uuid, player_id uuid, status text, metodo text, created_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const COOLING = "00000000-0000-4000-8000-0000000000a1";
const SIGNUP = "00000000-0000-4000-8000-0000000000a2";
const PIX = "00000000-0000-4000-8000-0000000000a3";
const LEVEL = "00000000-0000-4000-8000-0000000000a4";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: PGlite;

async function estimate(journey: string) {
  const { rows } = await db.query<{ eligible: number | null; supported: boolean }>(
    `select * from journey_activation_estimate($1)`,
    [journey],
  );
  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`
    insert into journeys values
      ('${COOLING}', '${T}', 'inactivity', '{"field":"ultimo_deposito","hours":48}', '{"inactivity_over_hours":168}'),
      ('${SIGNUP}', '${T}', 'cadastrados_sem_deposito', '{}', '{}'),
      ('${PIX}', '${T}', 'pix_gerado_nao_pago', '{}', '{}'),
      ('${LEVEL}', '${T}', 'nivel_alterado', '{"level":"gold"}', '{}');
    insert into journey_steps values ('${COOLING}', 0, 'sms'), ('${SIGNUP}', 0, 'sms'), ('${PIX}', 0, 'sms');
    insert into players values
      ('${id(1)}', '${T}', '11999990001', null, null, now() - interval '72 hours', now() - interval '30 days', 50),
      ('${id(2)}', '${T}', '11999990002', null, null, now() - interval '100 hours', now() - interval '30 days', 50),
      ('${id(3)}', '${T}', null, null, null, now() - interval '72 hours', now() - interval '30 days', 50),
      ('${id(4)}', '${T}', '11999990004', null, null, now() - interval '10 days', now() - interval '30 days', 50),
      ('${id(5)}', '${T}', '11999990005', null, null, now() - interval '5 hours', now() - interval '30 days', 50),
      ('${id(6)}', '${T}', '11999990006', null, null, null, null, 0),
      ('${id(7)}', '${T}', '11999990007', null, null, null, null, 0);
    insert into journey_enrollments values ('${COOLING}', '${id(2)}', 'waiting'), ('${SIGNUP}', '${id(7)}', 'exited');
    insert into deposits values
      ('${T}', '${id(6)}', 'pendente', 'pix', now() - interval '2 hours'),
      ('${T}', '${id(6)}', 'pendente', 'pix', now() - interval '1 hour'),
      ('${T}', '${id(4)}', 'pendente', 'pix', now() - interval '100 hours');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("journey_activation_estimate", () => {
  it("counts players inside the inactivity band, reachable and not already in the journey", async () => {
    // id 1 only: 2 is already open, 3 has no phone, 4 is past the band, 5 is active.
    expect(await estimate(COOLING)).toEqual({ eligible: 1, supported: true });
  });

  it("counts sign-ups without a first deposit that never entered the journey", async () => {
    expect(await estimate(SIGNUP)).toEqual({ eligible: 1, supported: true });
  });

  it("counts players with a pending PIX younger than 72 hours, once", async () => {
    expect(await estimate(PIX)).toEqual({ eligible: 1, supported: true });
  });

  it("does not estimate triggers that only take new cases", async () => {
    expect(await estimate(LEVEL)).toEqual({ eligible: null, supported: false });
  });
});
