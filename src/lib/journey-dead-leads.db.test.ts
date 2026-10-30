// Leads mortos — SQL tests for
// supabase/migrations/20261117100000_journey_dead_leads.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261117100000_journey_dead_leads.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema if not exists auth;
create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$ select false $$;
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.accessible_tenant_ids() returns uuid[] language sql as $$ select '{}'::uuid[] $$;
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
create function public.journey_requires_phone(_journey uuid) returns boolean language sql as $$ select false $$;

create type public.journey_enrollment_status as enum
  ('active', 'waiting', 'paused', 'completed', 'exited', 'failed', 'paused_by_priority');
create type public.journey_execution_status as enum
  ('pending', 'claimed', 'sent', 'delivered', 'skipped', 'retrying', 'failed', 'cancelled');

create table public.tenants (id uuid primary key, is_demo boolean not null default false);
create function public.is_demo_tenant(_tenant uuid) returns boolean language sql stable as $$
  select coalesce((select is_demo from public.tenants where id = _tenant), false) $$;
create table public.players (
  id uuid primary key, tenant_id uuid references public.tenants(id), telefone text, email text,
  ultimo_deposito timestamptz, ftd_em timestamptz, ultimo_login timestamptz, ultimo_jogo timestamptz,
  total_depositado numeric, total_sacado numeric, last_cashback_paid_at timestamptz,
  created_at timestamptz not null default now() - interval '100 days');
create table public.journeys (
  id uuid primary key, tenant_id uuid, express boolean, ends_at timestamptz);
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid, player_id uuid,
  entry_key text not null default 'default',
  status public.journey_enrollment_status not null default 'active',
  exited_at timestamptz, exit_reason text, claimed_at timestamptz, claimed_by text,
  lease_expires_at timestamptz, is_holdout boolean not null default false,
  updated_at timestamptz not null default now());
create table public.journey_step_executions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid,
  enrollment_id uuid, channel text, status public.journey_execution_status, completed_at timestamptz);
create table public.journey_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid,
  enrollment_id uuid, event_type text, detail jsonb, created_at timestamptz default now());
create table public.journey_contact_limits (
  tenant_id uuid primary key references public.tenants(id), max_messages_24h integer,
  max_messages_7d integer, updated_at timestamptz not null default now());
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  status text, metodo text, created_at timestamptz);
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  status text, created_at timestamptz);
create table public.link_dispatches (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, recipient_player_id uuid,
  first_party_last_clicked_at timestamptz);
create table public.gamification_settings (
  tenant_id uuid primary key, level_thresholds jsonb, cooling_after_days int, sleeping_after_days int);

create function public.enforce_single_open_journey_enrollment() returns trigger
language plpgsql as $$ begin return new; end; $$;
create trigger trg_enforce_single_open before insert on public.journey_enrollments
for each row execute function public.enforce_single_open_journey_enrollment();
`;

const T = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const J1 = "00000000-0000-4000-8000-0000000000a1";
const J2 = "00000000-0000-4000-8000-0000000000a2";
const EXPRESS = "00000000-0000-4000-8000-0000000000a3";
const P = "00000000-0000-4000-8000-0000000000b1";
const P2 = "00000000-0000-4000-8000-0000000000b2";
const P3 = "00000000-0000-4000-8000-0000000000b3";

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
    truncate journey_dead_leads, journey_events, journey_step_executions, journey_enrollments,
      journeys, deposits, withdrawals, link_dispatches, journey_contact_limits, players, tenants cascade;
    insert into tenants (id, is_demo) values ('${T}', false), ('${DEMO}', true);
    insert into journey_contact_limits (tenant_id, dead_lead_enabled, dead_lead_threshold)
      values ('${T}', true, 3), ('${DEMO}', true, 3);
    insert into players (id, tenant_id, telefone, ultimo_login) values
      ('${P}', '${T}', '+5511999999999', now() - interval '30 days'),
      ('${P2}', '${T}', '+5511999999998', now() - interval '30 days'),
      ('${P3}', '${DEMO}', '+5511999999997', now() - interval '30 days');
    insert into journeys (id, tenant_id, express) values
      ('${J1}', '${T}', false), ('${J2}', '${T}', false), ('${EXPRESS}', '${T}', true);
  `);
});

async function enroll(player: string, journey: string, extra = "") {
  const { rows } = await db.query<{ id: string }>(
    `insert into journey_enrollments (tenant_id, journey_id, player_id, entry_key${extra ? ", claimed_at, claimed_by, lease_expires_at" : ""})
     values ((select tenant_id from players where id = $1), $2, $1, gen_random_uuid()::text${extra})
     returning id`,
    [player, journey],
  );
  return rows[0]?.id ?? null;
}

/** `count` sent messages for the enrollment, the latest `minutesAgo` minutes ago. */
async function sent(
  enrollmentId: string,
  count: number,
  opts: { channel?: string; daysAgo?: number } = {},
) {
  await db.query(
    `insert into journey_step_executions (tenant_id, journey_id, enrollment_id, channel, status, completed_at)
     select e.tenant_id, e.journey_id, e.id, $2, 'sent', now() - make_interval(days => $3) - make_interval(mins => g)
     from journey_enrollments e, generate_series(1, $4) g where e.id = $1`,
    [enrollmentId, opts.channel ?? "sms", opts.daysAgo ?? 0, count],
  );
}

async function check(player: string, enrollment: string | null = null, tenant = T) {
  const { rows } = await db.query<{ dead: boolean }>(
    `select public.journey_dead_lead_check($1, $2, $3) as dead`,
    [tenant, player, enrollment],
  );
  return rows[0].dead;
}

async function deadRow(player: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from journey_dead_leads where player_id = $1`,
    [player],
  );
  return rows[0] ?? null;
}

async function enrollment(id: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `select status::text as status, exit_reason, claimed_by from journey_enrollments where id = $1`,
    [id],
  );
  return rows[0];
}

describe("journey_dead_lead_check", () => {
  it("does nothing while the rule is off", async () => {
    await db.exec(`update journey_contact_limits set dead_lead_enabled = false`);
    const e = (await enroll(P, J1))!;
    await sent(e, 5);
    expect(await check(P, e)).toBe(false);
    expect(await deadRow(P)).toBeNull();
  });

  it("below the threshold the lead stays alive", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 2);
    expect(await check(P, e)).toBe(false);
    expect(await deadRow(P)).toBeNull();
  });

  it("at the threshold (all journeys combined) marks the lead and exits every open non-express enrollment", async () => {
    const e1 = (await enroll(P, J1, `, now(), 'worker-me', now() + interval '2 minutes'`))!;
    const e2 = (await enroll(P, J2))!;
    const ex = (await enroll(P, EXPRESS))!;
    await sent(e1, 2);
    await sent(e2, 1, { channel: "email" });
    expect(await check(P, e1)).toBe(true);
    const row = await deadRow(P);
    expect(row).toMatchObject({ messages_count: 3, exited_enrollments: 2, revived_at: null });
    expect(row?.last_action_type).toBe("login");
    // The caller's own enrollment exits but keeps its lease for the fenced release.
    expect(await enrollment(e1)).toMatchObject({
      status: "exited",
      exit_reason: "dead_lead",
      claimed_by: "worker-me",
    });
    expect(await enrollment(e2)).toMatchObject({ status: "exited", exit_reason: "dead_lead" });
    expect(await enrollment(ex)).toMatchObject({ status: "active" });
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int n from journey_events where event_type = 'exited' and detail->>'reason' = 'dead_lead'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it("only counts messages after the last action, ignores holdout and skipped rows", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 5, { daysAgo: 40 }); // before ultimo_login (30 days ago)
    await sent(e, 2);
    await db.exec(
      `update journey_step_executions set status = 'skipped' where completed_at > now() - interval '1 day' and ctid = (select min(ctid) from journey_step_executions where completed_at > now() - interval '1 day')`,
    );
    const h = (await enroll(P, J2))!;
    await db.query(`update journey_enrollments set is_holdout = true where id = $1`, [h]);
    await sent(h, 5);
    expect(await check(P, e)).toBe(false);
  });

  it("an action after the messages (click) keeps the lead alive", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 4);
    await db.query(
      `insert into link_dispatches (tenant_id, recipient_player_id, first_party_last_clicked_at) values ($1, $2, now())`,
      [T, P],
    );
    expect(await check(P, e)).toBe(false);
  });

  it("does not touch an enrollment leased by another worker; its own post-send check closes it", async () => {
    const mine = (await enroll(P, J1))!;
    const other = (await enroll(P, J2, `, now(), 'worker-other', now() + interval '2 minutes'`))!;
    await sent(mine, 3);
    expect(await check(P, mine)).toBe(true);
    expect(await enrollment(other)).toMatchObject({ status: "active", claimed_by: "worker-other" });
    // The other worker sends and checks: the lead is already dead.
    expect(await check(P, other)).toBe(true);
    expect(await enrollment(other)).toMatchObject({ status: "exited", exit_reason: "dead_lead" });
    expect((await deadRow(P))?.exited_enrollments).toBe(2);
  });

  it("a dead lead that acted is revived inline and not exited again", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 3);
    expect(await check(P, e)).toBe(true);
    await db.query(
      `insert into deposits (tenant_id, player_id, status, metodo, created_at) values ($1, $2, 'pendente', 'pix', now() + interval '1 second')`,
      [T, P],
    );
    const ex = (await enroll(P, EXPRESS))!;
    await sent(ex, 1);
    expect(await check(P, ex)).toBe(false);
    expect(await deadRow(P)).toMatchObject({ revived_reason: "activity" });
  });
});

describe("enforce_single_open_journey_enrollment", () => {
  it("blocks non-express entries of a dead lead, allows express ones, and stops blocking when the rule is off", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 3);
    expect(await check(P, e)).toBe(true);
    expect(await enroll(P, J2)).toBeNull();
    expect(await enroll(P, EXPRESS)).not.toBeNull();
    expect(await enroll(P2, J2)).not.toBeNull();
    await db.exec(`update journey_contact_limits set dead_lead_enabled = false`);
    expect(await enroll(P, J2)).not.toBeNull();
  });

  it("a revived lead can enter again", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 3);
    await check(P, e);
    const { rows } = await db.query<{ ok: boolean }>(`select public.revive_dead_lead($1, $2) ok`, [
      T,
      P,
    ]);
    expect(rows[0].ok).toBe(true);
    expect(await deadRow(P)).toMatchObject({ revived_reason: "manual" });
    expect(await enroll(P, J2)).not.toBeNull();
    // Manual revival restarts the count: old messages do not kill it again.
    expect(await check(P, e)).toBe(false);
  });
});

describe("sweep_dead_lead_revivals", () => {
  it("revives leads with an action after marked_at, skipping demo houses", async () => {
    const e = (await enroll(P, J1))!;
    const d = (await enroll(P3, J1))!;
    await sent(e, 3);
    await sent(d, 3);
    expect(await check(P, e)).toBe(true);
    expect(await check(P3, d, DEMO)).toBe(true);
    await db.exec(`update players set ultimo_jogo = now() + interval '1 minute'`);
    const { rows } = await db.query<{ n: number }>(`select public.sweep_dead_lead_revivals() n`);
    expect(rows[0].n).toBe(1);
    expect(await deadRow(P)).toMatchObject({ revived_reason: "activity" });
    expect((await deadRow(P3))?.revived_at).toBeNull();
  });
});

describe("backfill_dead_leads", () => {
  it("marks over-threshold players in bounded batches and terminates", async () => {
    const e1 = (await enroll(P, J1))!;
    const e2 = (await enroll(P2, J1))!;
    await sent(e1, 4);
    await sent(e2, 3);
    const first = (
      await db.query<{ r: Record<string, unknown> }>(`select public.backfill_dead_leads($1, 1) r`, [
        T,
      ])
    ).rows[0].r;
    expect(first).toEqual({ evaluated: 2, marked: 1, remaining: true });
    const second = (
      await db.query<{ r: Record<string, unknown> }>(`select public.backfill_dead_leads($1, 1) r`, [
        T,
      ])
    ).rows[0].r;
    expect(second).toEqual({ evaluated: 1, marked: 1, remaining: false });
    expect(await enrollment(e1)).toMatchObject({ status: "exited", exit_reason: "dead_lead" });
    expect((await deadRow(P2))?.exited_enrollments).toBe(1);
    const third = (
      await db.query<{ r: Record<string, unknown> }>(`select public.backfill_dead_leads($1) r`, [T])
    ).rows[0].r;
    expect(third).toEqual({ evaluated: 0, marked: 0, remaining: false });
  });

  it("does nothing while the rule is off", async () => {
    await db.exec(`update journey_contact_limits set dead_lead_enabled = false`);
    const e = (await enroll(P, J1))!;
    await sent(e, 5);
    const r = (
      await db.query<{ r: Record<string, unknown> }>(`select public.backfill_dead_leads($1) r`, [T])
    ).rows[0].r;
    expect(r).toEqual({ evaluated: 0, marked: 0, remaining: false });
  });
});

describe("resolve_sms_audience_v2 deadLeads", () => {
  it("returns only active dead leads and flags the filter", async () => {
    const e = (await enroll(P, J1))!;
    await sent(e, 3);
    await check(P, e);
    const { rows } = await db.query<{
      r: { total: number; phones: string[]; deadLeadsFilter: boolean };
    }>(`select public.resolve_sms_audience_v2($1, '{"deadLeads": true}'::jsonb) r`, [T]);
    expect(rows[0].r).toMatchObject({ total: 1, phones: ["5511999999999"], deadLeadsFilter: true });
    const all = (
      await db.query<{ r: { total: number; deadLeadsFilter: boolean } }>(
        `select public.resolve_sms_audience_v2($1, '{}'::jsonb) r`,
        [T],
      )
    ).rows[0].r;
    expect(all).toMatchObject({ total: 2, deadLeadsFilter: false });
  });
});
