// Express ("Envio imediato — fura fila") journeys — SQL regression tests for
// supabase/migrations/20261015122000_express_journeys.sql
//
// Runs 20261015110000 (claim/leases) and then the express migration inside an
// in-memory Postgres (PGlite) on a minimal schema with only the columns the
// functions touch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, "supabase/migrations", file), "utf8");
const LEASES = read("20261015110000_journey_dispatch_leases_fairness_rate_limits.sql");
const EXPRESS = read("20261015122000_express_journeys.sql");

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create table public.tenants (id uuid primary key);
create type public.journey_status as enum ('draft','active','paused','archived');
create type public.journey_enrollment_status as enum
  ('active','waiting','paused','completed','exited','failed','paused_by_priority');
create type public.journey_step_type as enum
  ('wait','sms','email','voice','condition','split','update_player','end');
create type public.journey_execution_status as enum
  ('pending','claimed','sent','delivered','skipped','retrying','failed','cancelled');
create table public.journeys (
  id uuid primary key, tenant_id uuid not null references public.tenants(id),
  status public.journey_status not null default 'active',
  journey_priority integer not null default 4,
  conflict_policy text not null default 'coexist');
create table public.journey_steps (
  id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.journeys(id),
  position integer not null, step_type public.journey_step_type not null,
  is_enabled boolean not null default true, unique (journey_id, position));
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  journey_id uuid not null references public.journeys(id),
  player_id uuid,
  status public.journey_enrollment_status not null default 'active',
  current_position integer not null default 0,
  loop_iteration integer not null default 0,
  next_run_at timestamptz not null default now(),
  attempts integer not null default 0,
  claimed_at timestamptz, claimed_by text,
  priority_paused_at timestamptz, priority_pause_reason text, priority_paused_by_journey_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create table public.journey_step_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid, journey_id uuid, step_id uuid, step_position integer,
  loop_iteration integer not null default 0, channel text, attempt integer not null default 1,
  idempotency_key uuid not null default gen_random_uuid(),
  enrollment_id uuid not null references public.journey_enrollments(id),
  status public.journey_execution_status not null default 'claimed',
  error text, completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create table public.journey_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, journey_id uuid,
  enrollment_id uuid, event_type text not null, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp());
create table public.journey_contact_limits (
  tenant_id uuid primary key, max_messages_24h integer, max_messages_7d integer);
create table public.sms_send_logs (
  tenant_id uuid, player_id uuid, status text, created_at timestamptz not null default now());
create table public.email_send_logs (
  tenant_id uuid, player_id uuid, status text, created_at timestamptz not null default now());
create table public.dispatch_pause_state (
  channel text not null, tenant_id uuid not null, paused boolean not null default false,
  primary key (channel, tenant_id));
`;

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const SAQUE = "00000000-0000-4000-8000-0000000000a1"; // will be express
const OTHER = "00000000-0000-4000-8000-0000000000a2"; // regular, same tenant
const T2J = "00000000-0000-4000-8000-0000000000a3"; // regular, other tenant
const P1 = "00000000-0000-4000-8000-0000000000f1";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function enroll(journey: string, opts: { tenant?: string; ageSeconds?: number } = {}) {
  const [row] = await rows<{ id: string }>(
    `insert into journey_enrollments (tenant_id, journey_id, player_id, next_run_at, created_at)
     values ($1, $2, $3, now() - make_interval(secs => $4), now() - make_interval(secs => $4))
     returning id`,
    [opts.tenant ?? T1, journey, P1, opts.ageSeconds ?? 1],
  );
  return row.id;
}

async function reserve(journey: string, enrollment: string, cooldownHours = 72) {
  const [step] = await rows<{ id: string }>(
    `select id from journey_steps where journey_id = $1 and position = 0`,
    [journey],
  );
  const [row] = await rows<{ execution_id: string | null; blocked_reason: string | null }>(
    `select * from reserve_journey_delivery_with_contact_limits($1,$2,$3,$4,0,$5,'sms',1000,$6)`,
    [T1, journey, enrollment, step.id, P1, cooldownHours],
  );
  return row;
}

async function recentSmsFromOtherJourney() {
  const other = await enroll(OTHER);
  await db.query(
    `insert into journey_step_executions (tenant_id, journey_id, enrollment_id, step_position, channel, status, completed_at)
     values ($1, $2, $3, 0, 'sms', 'sent', now() - interval '1 hour')`,
    [T1, OTHER, other],
  );
  await db.query(`update journey_enrollments set status = 'completed' where id = $1`, [other]);
}

async function setExpress(journey: string, value: boolean) {
  await db.query(`update journeys set express = $2 where id = $1`, [journey, value]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LEASES);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${EXPRESS}; commit;`);
  await db.exec(`begin; ${EXPRESS}; commit;`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate journey_events, journey_step_executions, journey_enrollments, journey_steps, journeys,
      journey_contact_limits, sms_send_logs, email_send_logs, dispatch_pause_state, tenants cascade;
    insert into tenants values ('${T1}'), ('${T2}');
    insert into journeys (id, tenant_id) values ('${SAQUE}', '${T1}'), ('${OTHER}', '${T1}'),
      ('${T2J}', '${T2}');
    insert into journey_steps (journey_id, position, step_type) values
      ('${SAQUE}', 0, 'sms'), ('${OTHER}', 0, 'sms'), ('${T2J}', 0, 'sms');
  `);
});

describe("journeys.express column", () => {
  it("defaults to false", async () => {
    const [row] = await rows<{ express: boolean }>(`select express from journeys where id = $1`, [
      SAQUE,
    ]);
    expect(row.express).toBe(false);
  });
});

describe("reservation", () => {
  it("regular journey is still deferred by cross-journey cooldown", async () => {
    await recentSmsFromOtherJourney();
    const result = await reserve(SAQUE, await enroll(SAQUE));
    expect(result.blocked_reason).toBe("cooldown");
    expect(result.execution_id).toBeNull();
  });

  it("express journey skips the cross-journey cooldown", async () => {
    await recentSmsFromOtherJourney();
    await setExpress(SAQUE, true);
    const result = await reserve(SAQUE, await enroll(SAQUE));
    expect(result.blocked_reason).toBeNull();
    expect(result.execution_id).toBeTruthy();
  });

  it("express journey skips global 24h/7d contact limits; regular does not", async () => {
    await db.query(`insert into journey_contact_limits values ($1, 1, 1)`, [T1]);
    await db.query(
      `insert into sms_send_logs (tenant_id, player_id, status) values ($1, $2, 'sent')`,
      [T1, P1],
    );
    expect((await reserve(SAQUE, await enroll(SAQUE), 0)).blocked_reason).toBe("global_limit_24h");
    await db.exec(`truncate journey_enrollments, journey_step_executions, journey_events cascade`);
    await setExpress(SAQUE, true);
    expect((await reserve(SAQUE, await enroll(SAQUE), 0)).blocked_reason).toBeNull();
  });

  it("express journey keeps idempotency (already_sent / in_flight)", async () => {
    await setExpress(SAQUE, true);
    const enrollment = await enroll(SAQUE);
    const first = await reserve(SAQUE, enrollment);
    expect(first.execution_id).toBeTruthy();
    expect((await reserve(SAQUE, enrollment)).blocked_reason).toBe("in_flight");
    await db.query(`update journey_step_executions set status = 'sent' where id = $1`, [
      first.execution_id,
    ]);
    expect((await reserve(SAQUE, enrollment)).blocked_reason).toBe("already_sent");
  });

  it("express journey keeps its own daily_limit", async () => {
    await setExpress(SAQUE, true);
    const [step] = await rows<{ id: string }>(
      `select id from journey_steps where journey_id = $1`,
      [SAQUE],
    );
    const a = await enroll(SAQUE);
    await db.query(
      `select * from reserve_journey_delivery_with_contact_limits($1,$2,$3,$4,0,$5,'sms',1,0)`,
      [T1, SAQUE, a, step.id, P1],
    );
    const b = await enroll(SAQUE);
    const [row] = await rows<{ blocked_reason: string }>(
      `select * from reserve_journey_delivery_with_contact_limits($1,$2,$3,$4,0,$5,'sms',1,0)`,
      [T1, SAQUE, b, step.id, P1],
    );
    expect(row.blocked_reason).toBe("daily_limit");
  });
});

describe("priority arbitration", () => {
  beforeEach(async () => {
    // OTHER has the highest priority and pauses lower-priority journeys.
    await db.exec(`update journeys set journey_priority = 1, conflict_policy = 'pause_lower_priority'
      where id = '${OTHER}'`);
  });

  it("regular lower-priority journey is paused by a due higher-priority competitor", async () => {
    await enroll(OTHER);
    const mine = await enroll(SAQUE);
    expect((await reserve(SAQUE, mine, 0)).blocked_reason).toBe("priority_paused");
  });

  it("express journey is never paused and does not pause the competitor", async () => {
    await setExpress(SAQUE, true);
    const competitor = await enroll(OTHER);
    const mine = await enroll(SAQUE);
    expect((await reserve(SAQUE, mine, 0)).blocked_reason).toBeNull();
    const states = await rows<{ id: string; status: string }>(
      `select id, status::text from journey_enrollments`,
    );
    expect(states.find((s) => s.id === mine)?.status).toBe("active");
    expect(states.find((s) => s.id === competitor)?.status).toBe("active");
  });

  it("a regular journey cannot pause a due express enrollment", async () => {
    await setExpress(SAQUE, true);
    // SAQUE (express) has a due enrollment; OTHER reserves and would win.
    const express = await enroll(SAQUE);
    const regular = await enroll(OTHER);
    expect((await reserve(OTHER, regular, 0)).blocked_reason).toBeNull();
    const [row] = await rows<{ status: string }>(
      `select status::text from journey_enrollments where id = $1`,
      [express],
    );
    expect(row.status).toBe("active");
  });
});

describe("claim order", () => {
  async function claim(limit: number) {
    return rows<{ id: string; tenant_id: string }>(
      `select * from claim_journey_enrollments_leased($1, 'w', 120, '{}'::uuid[], '{}'::uuid[], null)`,
      [limit],
    );
  }

  it("claims due express items before older regular items of the same tenant", async () => {
    await setExpress(SAQUE, true);
    for (let i = 0; i < 5; i++) await enroll(OTHER, { ageSeconds: 3600 + i });
    const express = await enroll(SAQUE, { ageSeconds: 1 });
    const claimed = await claim(1);
    expect(claimed.map((r) => r.id)).toEqual([express]);
  });

  it("keeps round-robin fairness across tenants", async () => {
    await setExpress(SAQUE, true);
    const e1 = await enroll(SAQUE, { ageSeconds: 1 });
    const e2 = await enroll(SAQUE, { ageSeconds: 2 });
    const t2 = await enroll(T2J, { tenant: T2, ageSeconds: 7200 });
    const claimed = await claim(2);
    expect(new Set(claimed.map((r) => r.id))).toEqual(new Set([e2, t2]));
    expect(claimed.map((r) => r.id)).not.toContain(e1);
  });

  it("regular behavior is unchanged without express journeys", async () => {
    const old = await enroll(OTHER, { ageSeconds: 3600 });
    await enroll(SAQUE, { ageSeconds: 1 });
    expect((await claim(1)).map((r) => r.id)).toEqual([old]);
  });

  it("does not claim express items of paused journeys", async () => {
    await setExpress(SAQUE, true);
    await db.exec(`update journeys set status = 'paused' where id = '${SAQUE}'`);
    await enroll(SAQUE);
    expect(await claim(10)).toHaveLength(0);
  });
});

describe("requeue_express_journey_enrollments", () => {
  it("pulls cooldown-deferred and priority-paused items forward, leaves real waits", async () => {
    const deferred = await enroll(SAQUE);
    const waitStep = await enroll(SAQUE);
    const paused = await enroll(SAQUE);
    await db.query(
      `update journey_enrollments set status = 'waiting', next_run_at = now() + interval '2 days'
       where id in ($1, $2)`,
      [deferred, waitStep],
    );
    await db.query(
      `update journey_enrollments set status = 'paused_by_priority', priority_paused_at = now(),
         priority_paused_by_journey_id = $2 where id = $1`,
      [paused, OTHER],
    );
    await db.query(
      `insert into journey_events (tenant_id, journey_id, enrollment_id, event_type, detail, created_at) values
       ($1, $2, $3, 'step_deferred', '{"reason":"cooldown","step_position":0}', now() - interval '1 hour'),
       ($1, $2, $4, 'step_deferred', '{"reason":"cooldown","step_position":0}', now() - interval '1 hour'),
       ($1, $2, $4, 'step_waiting', '{}', now() - interval '1 minute')`,
      [T1, SAQUE, deferred, waitStep],
    );
    const [none] = await rows<{ n: number }>(
      `select requeue_express_journey_enrollments($1, $2) n`,
      [T1, SAQUE],
    );
    expect(none.n).toBe(0); // journey not express yet
    await setExpress(SAQUE, true);
    const [result] = await rows<{ n: number }>(
      `select requeue_express_journey_enrollments($1, $2) n`,
      [T1, SAQUE],
    );
    expect(result.n).toBe(2);
    const states = await rows<{ id: string; status: string; due: boolean }>(
      `select id, status::text, next_run_at <= now() due from journey_enrollments`,
    );
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get(deferred)).toMatchObject({ status: "waiting", due: true });
    expect(byId.get(waitStep)).toMatchObject({ status: "waiting", due: false });
    expect(byId.get(paused)).toMatchObject({ status: "waiting", due: true });
  });
});
