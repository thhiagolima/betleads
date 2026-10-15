// Journey P0 rules — SQL regression tests for
// supabase/migrations/20261015200000_journey_p0_rules.sql
// (single open enrollment, per-player caps, priority-paused sweep).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, "supabase/migrations", file), "utf8");
const LEASES = read("20261015110000_journey_dispatch_leases_fairness_rate_limits.sql");
const EXPRESS = read("20261015122000_express_journeys.sql");
const P0 = read("20261015200000_journey_p0_rules.sql");

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
  conflict_policy text not null default 'coexist',
  trigger_config jsonb not null default '{}'::jsonb,
  entry_rules jsonb not null default '{}'::jsonb,
  exit_rules jsonb not null default '{}'::jsonb);
create table public.journey_steps (
  id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.journeys(id),
  position integer not null, step_type public.journey_step_type not null,
  is_enabled boolean not null default true, unique (journey_id, position));
create table public.players (
  id uuid primary key, ultimo_deposito timestamptz, ftd_em timestamptz,
  ultimo_login timestamptz, ultimo_jogo timestamptz);
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  journey_id uuid not null references public.journeys(id),
  player_id uuid,
  entry_key text not null default 'once',
  status public.journey_enrollment_status not null default 'active',
  current_position integer not null default 0,
  loop_iteration integer not null default 0,
  next_run_at timestamptz not null default now(),
  entered_at timestamptz not null default now(),
  exited_at timestamptz, exit_reason text,
  attempts integer not null default 0,
  claimed_at timestamptz, claimed_by text,
  priority_paused_at timestamptz, priority_pause_reason text, priority_paused_by_journey_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, player_id, entry_key));
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
const PIX = "00000000-0000-4000-8000-0000000000b1";
const SAQUE = "00000000-0000-4000-8000-0000000000b2";
const ESFRIANDO = "00000000-0000-4000-8000-0000000000b3";
const P1 = "00000000-0000-4000-8000-0000000000f1";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function insertEnrollment(journey: string, entryKey: string, status = "active") {
  return rows<{ id: string }>(
    `insert into journey_enrollments (tenant_id, journey_id, player_id, entry_key, status)
     values ($1, $2, $3, $4, $5::journey_enrollment_status)
     on conflict (journey_id, player_id, entry_key) do nothing returning id`,
    [T1, journey, P1, entryKey, status],
  );
}

async function openCount(journey: string) {
  const [row] = await rows<{ n: number }>(
    `select count(*)::int n from journey_enrollments
     where journey_id = $1 and status in ('active','waiting','paused_by_priority')`,
    [journey],
  );
  return row.n;
}

async function reserve(journey: string, enrollment: string) {
  const [step] = await rows<{ id: string }>(
    `select id from journey_steps where journey_id = $1 and position = 0`,
    [journey],
  );
  const [row] = await rows<{
    execution_id: string | null;
    retry_at: string | null;
    blocked_reason: string | null;
  }>(`select * from reserve_journey_delivery_v2($1,$2,$3,$4,0,$5,'sms',1000,0)`, [
    T1,
    journey,
    enrollment,
    step.id,
    P1,
  ]);
  return row;
}

let pastSends = 0;

/** A finished saque send `minutesAgo` minutes ago, from another enrollment. */
async function pastSaqueSend(minutesAgo: number, status = "sent") {
  pastSends += 1;
  const [enrollment] = await insertEnrollment(SAQUE, `saque_pago:past-${pastSends}`, "completed");
  await db.query(
    `insert into journey_step_executions (tenant_id, journey_id, enrollment_id, step_position, channel, status, created_at)
     values ($1, $2, $3, 0, 'sms', $4::journey_execution_status, now() - make_interval(mins => $5))`,
    [T1, SAQUE, enrollment.id, status, minutesAgo],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LEASES);
  await db.exec(`begin; ${EXPRESS}; commit;`);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${P0}; commit;`);
  await db.exec(`begin; ${P0}; commit;`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate journey_events, journey_step_executions, journey_enrollments, journey_steps, journeys,
      players, journey_contact_limits, sms_send_logs, email_send_logs, dispatch_pause_state, tenants cascade;
    insert into tenants values ('${T1}');
    insert into players (id) values ('${P1}');
    insert into journeys (id, tenant_id, express, entry_rules, trigger_config, exit_rules) values
      ('${PIX}', '${T1}', false, '{"reentry":"per_occurrence"}', '{}', '{"deposit":true}'),
      ('${SAQUE}', '${T1}', true,
        '{"reentry":"per_occurrence","max_per_player_day":4,"min_interval_minutes":15}', '{}', '{}'),
      ('${ESFRIANDO}', '${T1}', false, '{}', '{"field":"ultimo_deposito","hours":48}',
        '{"deposit":true,"inactivity_over_hours":168}');
    insert into journey_steps (journey_id, position, step_type) values
      ('${PIX}', 0, 'sms'), ('${SAQUE}', 0, 'sms'), ('${ESFRIANDO}', 0, 'sms');
  `);
});

describe("single open enrollment (E-01)", () => {
  it("skips a second PIX enrollment while one is open", async () => {
    expect(await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-1")).toHaveLength(1);
    expect(await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-2")).toHaveLength(0);
    expect(await openCount(PIX)).toBe(1);
  });

  it("allows re-entry after the open enrollment ended", async () => {
    await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-1");
    await db.query(`update journey_enrollments set status = 'exited' where journey_id = $1`, [PIX]);
    expect(await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-2")).toHaveLength(1);
  });

  it("keeps one enrollment per occurrence on express journeys", async () => {
    await insertEnrollment(SAQUE, "saque_pago:w-1");
    await insertEnrollment(SAQUE, "saque_pago:w-2");
    expect(await openCount(SAQUE)).toBe(2);
  });

  it("does not block inserts of finished rows", async () => {
    await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-1");
    expect(await insertEnrollment(PIX, "pix_gerado_nao_pago:old", "completed")).toHaveLength(1);
  });
});

describe("per-player caps (D-8)", () => {
  it("reserves when the player is under both caps", async () => {
    await pastSaqueSend(60);
    const [enrollment] = await insertEnrollment(SAQUE, "saque_pago:w-new");
    const result = await reserve(SAQUE, enrollment.id);
    expect(result.blocked_reason).toBeNull();
    expect(result.execution_id).not.toBeNull();
  });

  it("enforces the minimum interval and returns when to retry", async () => {
    await pastSaqueSend(5);
    const [enrollment] = await insertEnrollment(SAQUE, "saque_pago:w-new");
    const result = await reserve(SAQUE, enrollment.id);
    expect(result.blocked_reason).toBe("journey_player_min_interval");
    const waitMinutes = (Date.parse(String(result.retry_at)) - Date.now()) / 60_000;
    expect(waitMinutes).toBeGreaterThan(9);
    expect(waitMinutes).toBeLessThanOrEqual(10.1);
  });

  it("stops at the daily cap", async () => {
    const [{ minutes }] = await rows<{ minutes: number }>(
      `select floor(extract(epoch from now() - (date_trunc('day', now() at time zone 'America/Sao_Paulo')
         at time zone 'America/Sao_Paulo')) / 60)::int minutes`,
    );
    if (minutes < 80) return; // too close to BRT midnight to place 4 sends today
    for (const ago of [80, 60, 40, 20]) await pastSaqueSend(ago);
    const [enrollment] = await insertEnrollment(SAQUE, "saque_pago:w-new");
    const result = await reserve(SAQUE, enrollment.id);
    expect(result.blocked_reason).toBe("journey_player_daily_cap");
    expect(result.retry_at).toBeNull();
  });

  it("ignores failed sends", async () => {
    await pastSaqueSend(5, "failed");
    const [enrollment] = await insertEnrollment(SAQUE, "saque_pago:w-new");
    expect((await reserve(SAQUE, enrollment.id)).blocked_reason).toBeNull();
  });

  it("leaves journeys without caps unchanged", async () => {
    const [enrollment] = await insertEnrollment(PIX, "pix_gerado_nao_pago:pix-1");
    expect((await reserve(PIX, enrollment.id)).execution_id).not.toBeNull();
  });
});

describe("priority-paused sweep (S-02)", () => {
  async function pausedEsfriando(lastDepositHoursAgo: number) {
    await db.query(`update players set ultimo_deposito = now() - make_interval(hours => $1)`, [
      lastDepositHoursAgo,
    ]);
    const [row] = await rows<{ id: string }>(
      `insert into journey_enrollments (tenant_id, journey_id, player_id, status, entered_at)
       values ($1, $2, $3, 'paused_by_priority', now() - interval '1 hour') returning id`,
      [T1, ESFRIANDO, P1],
    );
    return row.id;
  }

  it("exits a paused enrollment whose band is over", async () => {
    const id = await pausedEsfriando(200);
    const [{ swept }] = await rows<{ swept: number }>(
      `select sweep_priority_paused_enrollments(100) swept`,
    );
    expect(swept).toBe(1);
    const [row] = await rows<{ status: string; exit_reason: string }>(
      `select status, exit_reason from journey_enrollments where id = $1`,
      [id],
    );
    expect(row).toEqual({ status: "exited", exit_reason: "inactivity_threshold" });
    const events = await rows(`select 1 from journey_events where enrollment_id = $1`, [id]);
    expect(events).toHaveLength(1);
  });

  it("exits on a deposit after entry", async () => {
    const id = await pausedEsfriando(72);
    await db.query(`update players set ultimo_deposito = now()`);
    await rows(`select sweep_priority_paused_enrollments(100)`);
    const [row] = await rows<{ exit_reason: string }>(
      `select exit_reason from journey_enrollments where id = $1`,
      [id],
    );
    expect(row.exit_reason).toBe("deposit");
  });

  it("keeps a paused enrollment that is still valid", async () => {
    const id = await pausedEsfriando(72);
    const [{ swept }] = await rows<{ swept: number }>(
      `select sweep_priority_paused_enrollments(100) swept`,
    );
    expect(swept).toBe(0);
    const [row] = await rows<{ status: string }>(
      `select status from journey_enrollments where id = $1`,
      [id],
    );
    expect(row.status).toBe("paused_by_priority");
  });
});
