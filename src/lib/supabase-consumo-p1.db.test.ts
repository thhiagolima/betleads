// Supabase consumption P1 — SQL tests for
// supabase/migrations/20261130100000_supabase_consumo_p1.sql
// (throttled journey sweeps, nightly retention, Short.io sync pick).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261130100000_supabase_consumo_p1.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.tenants (id uuid primary key, is_demo boolean not null default false);
create table public.players (
  id uuid primary key, tenant_id uuid, telefone text, ultimo_deposito timestamptz,
  ftd_em timestamptz, ultimo_login timestamptz, ultimo_jogo timestamptz);
create table public.journeys (
  id uuid primary key, tenant_id uuid, status text default 'active', ends_at timestamptz,
  exit_rules jsonb default '{}', trigger_config jsonb default '{}');
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid, player_id uuid,
  status text, entered_at timestamptz, claimed_at timestamptz, claimed_by text,
  lease_expires_at timestamptz, exited_at timestamptz, exit_reason text, entry_key text default 'k');
create function public.journey_requires_phone(p_journey_id uuid) returns boolean
  language sql stable as $$ select false $$;
create table public.journey_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid,
  enrollment_id uuid, event_type text, detail jsonb, created_at timestamptz not null default now());
create table public.journey_dead_leads (
  tenant_id uuid, player_id uuid, marked_at timestamptz, revived_at timestamptz,
  revived_reason text, primary key (tenant_id, player_id));
create function public.journey_player_last_action(p_tenant_id uuid, p_player_id uuid)
  returns table (action_at timestamptz, action_type text)
  language sql stable as $$ select now(), 'deposito'::text $$;
create table public.tracked_links (
  id uuid primary key, tenant_id uuid, shortio_link_id text, status text,
  last_synced_at timestamptz, created_at timestamptz);
create table public.link_dispatches (id uuid primary key, tracked_link_id uuid);
create table public.link_click_snapshots (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, tracked_link_id uuid not null,
  snapshot_at timestamptz not null, clicks integer not null default 0,
  payload jsonb not null default '{}', unique (tracked_link_id, snapshot_at));
create table public.webhook_logs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, created_at timestamptz);
create table public.financial_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  webhook_log_id uuid references public.webhook_logs (id) on delete set null,
  raw_payload jsonb not null, created_at timestamptz);
create table public.dispatcher_runs (id serial primary key, started_at timestamptz);
create table public.link_tracking_sync_runs (id serial primary key, started_at timestamptz);
`;

const T = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const J = "00000000-0000-4000-8000-0000000000a1";
const JD = "00000000-0000-4000-8000-0000000000a2";
const P1 = "00000000-0000-4000-8000-0000000000f1";
const P2 = "00000000-0000-4000-8000-0000000000f2";
const P3 = "00000000-0000-4000-8000-0000000000f3";
const LA = "00000000-0000-4000-8000-0000000000c1";
const LB = "00000000-0000-4000-8000-0000000000c2";

let db: PGlite;

const one = async <R>(sql: string, params: unknown[] = []) =>
  (await db.query<R>(sql, params)).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`begin; ${MIGRATION}; commit;`);
  await db.exec(`insert into tenants values ('${T}', false), ('${DEMO}', true), ('${OTHER}', false);`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from worker_throttle;`);
});

describe("worker_throttle_claim", () => {
  it("lets one run through per interval", async () => {
    const claim = () =>
      one<{ ok: boolean }>(`select worker_throttle_claim('t', interval '5 minutes') ok`);
    expect((await claim()).ok).toBe(true);
    expect((await claim()).ok).toBe(false);
    await db.exec(`update worker_throttle set last_run_at = now() - interval '6 minutes'`);
    expect((await claim()).ok).toBe(true);
  });
});

describe("sweep_journey_exits", () => {
  it("exits a depositor once per 5 minutes and never touches a demo house", async () => {
    await db.exec(`
      insert into journeys (id, tenant_id, exit_rules) values
        ('${J}', '${T}', '{"deposit": "true"}'), ('${JD}', '${DEMO}', '{"deposit": "true"}');
      insert into players (id, tenant_id, ultimo_deposito) values
        ('${P1}', '${T}', now()), ('${P2}', '${DEMO}', now()), ('${P3}', '${T}', now());
      insert into journey_enrollments (tenant_id, journey_id, player_id, status, entered_at) values
        ('${T}', '${J}', '${P1}', 'active', now() - interval '1 day'),
        ('${DEMO}', '${JD}', '${P2}', 'active', now() - interval '1 day');
    `);
    expect((await one<{ n: number }>(`select sweep_journey_exits(1000) n`)).n).toBe(1);
    await db.exec(`
      insert into journey_enrollments (tenant_id, journey_id, player_id, status, entered_at)
      values ('${T}', '${J}', '${P3}', 'active', now() - interval '1 day');
    `);
    // Within 5 minutes: nothing, the dispatcher re-checks exits before sending.
    expect((await one<{ n: number }>(`select sweep_journey_exits(1000) n`)).n).toBe(0);
    await db.exec(`update worker_throttle set last_run_at = now() - interval '6 minutes'`);
    expect((await one<{ n: number }>(`select sweep_journey_exits(1000) n`)).n).toBe(1);
    const demo = await one<{ status: string }>(
      `select status from journey_enrollments where tenant_id = $1`,
      [DEMO],
    );
    expect(demo.status).toBe("active");
  });
});

describe("sweep_dead_lead_revivals", () => {
  it("runs the all-houses sweep once per 15 minutes; a one-house call is not limited", async () => {
    await db.exec(`
      delete from journey_dead_leads;
      insert into journey_dead_leads (tenant_id, player_id, marked_at) values
        ('${T}', '${P1}', now() - interval '1 day'), ('${DEMO}', '${P2}', now() - interval '1 day');
    `);
    expect((await one<{ n: number }>(`select sweep_dead_lead_revivals() n`)).n).toBe(1);
    await db.exec(`
      insert into journey_dead_leads (tenant_id, player_id, marked_at)
      values ('${T}', '${P3}', now() - interval '1 day');
    `);
    expect((await one<{ n: number }>(`select sweep_dead_lead_revivals() n`)).n).toBe(0);
    expect((await one<{ n: number }>(`select sweep_dead_lead_revivals($1) n`, [T])).n).toBe(1);
    const demo = await one<{ revived_at: string | null }>(
      `select revived_at from journey_dead_leads where tenant_id = $1`,
      [DEMO],
    );
    expect(demo.revived_at).toBeNull();
  });
});

describe("purge_operational_history", () => {
  it("keeps only what the screens read and the decided windows", async () => {
    await db.exec(`
      insert into link_click_snapshots (tenant_id, tracked_link_id, snapshot_at, payload) values
        ('${T}', '${LA}', now() - interval '5 days', '{"big": true}'),
        ('${T}', '${LA}', now() - interval '3 days', '{}'),
        ('${T}', '${LA}', now() - interval '1 hour', '{}'),
        ('${T}', '${LB}', now() - interval '10 days', '{}');
      insert into webhook_logs (id, tenant_id, created_at) values
        ('00000000-0000-4000-8000-0000000000e1', '${T}', now() - interval '40 days'),
        ('00000000-0000-4000-8000-0000000000e2', '${OTHER}', now() - interval '10 days');
      insert into financial_webhook_attempts (webhook_log_id, raw_payload, created_at) values
        ('00000000-0000-4000-8000-0000000000e1', '{"pix": "a long raw payload"}', now() - interval '40 days'),
        ('00000000-0000-4000-8000-0000000000e2', '{"pix": "a long raw payload"}', now() - interval '10 days');
      insert into dispatcher_runs (started_at) values (now() - interval '20 days'), (now() - interval '3 days');
      insert into link_tracking_sync_runs (started_at) values (now() - interval '10 days'), (now() - interval '1 day');
      insert into journey_events (event_type, created_at) values
        ('old', now() - interval '100 days'), ('recent', now() - interval '10 days');
    `);
    // Small batches so every loop runs more than once.
    const out = await one<{ r: Record<string, unknown> }>(
      `select purge_operational_history(100, 60) r`,
    );
    expect(out.r).toMatchObject({
      link_click_snapshots: 2,
      webhook_logs: 1,
      financial_webhook_attempts_payload: 1,
      dispatcher_runs: 1,
      link_tracking_sync_runs: 1,
      finished: true,
    });

    const snaps = (
      await db.query<{ tracked_link_id: string; age: string }>(
        `select tracked_link_id, case when snapshot_at > now() - interval '1 day' then 'new' else 'old' end age
         from link_click_snapshots order by tracked_link_id`,
      )
    ).rows;
    // LA keeps its latest; LB keeps its only (latest) snapshot however old.
    expect(snaps).toEqual([
      { tracked_link_id: LA, age: "new" },
      { tracked_link_id: LB, age: "old" },
    ]);

    const attempts = (
      await db.query<{ webhook_log_id: string | null; raw_payload: unknown }>(
        `select webhook_log_id, raw_payload from financial_webhook_attempts order by created_at`,
      )
    ).rows;
    expect(attempts).toEqual([
      { webhook_log_id: null, raw_payload: {} },
      { webhook_log_id: "00000000-0000-4000-8000-0000000000e2", raw_payload: { pix: "a long raw payload" } },
    ]);
    expect((await one<{ n: number }>(`select count(*)::int n from journey_events where event_type = 'old'`)).n).toBe(0);
    expect((await one<{ n: number }>(`select count(*)::int n from journey_events where event_type = 'recent'`)).n).toBe(1);

    // A second pass finds nothing left.
    const again = await one<{ r: Record<string, number> }>(
      `select purge_operational_history(100, 60) r`,
    );
    expect(again.r.link_click_snapshots).toBe(0);
    expect(again.r.webhook_logs).toBe(0);
    expect(again.r.financial_webhook_attempts_payload).toBe(0);
  });
});

describe("shortio_sync_recent_links", () => {
  it("picks the house's active links created since, least recently synced first", async () => {
    await db.exec(`
      insert into tracked_links (id, tenant_id, shortio_link_id, status, last_synced_at, created_at) values
        ('00000000-0000-4000-8000-0000000000b1', '${T}', 's1', 'active', now() - interval '1 hour', now() - interval '2 hours'),
        ('00000000-0000-4000-8000-0000000000b2', '${T}', 's2', 'active', null, now() - interval '3 hours'),
        ('00000000-0000-4000-8000-0000000000b3', '${T}', 's3', 'active', now() - interval '5 hours', now() - interval '6 hours'),
        ('00000000-0000-4000-8000-0000000000b4', '${T}', 's4', 'active', null, now() - interval '3 days'),
        ('00000000-0000-4000-8000-0000000000b5', '${T}', 's5', 'paused', null, now() - interval '1 hour'),
        ('00000000-0000-4000-8000-0000000000b6', '${OTHER}', 's6', 'active', null, now() - interval '1 hour');
    `);
    const picked = (
      await db.query<{ shortio_link_id: string }>(
        `select shortio_link_id from shortio_sync_recent_links($1, now() - interval '1 day', 2)`,
        [T],
      )
    ).rows.map((r) => r.shortio_link_id);
    expect(picked).toEqual(["s2", "s3"]);
  });
});
