// "Sem trava" / "Com prioridade" — SQL regression tests for
// supabase/migrations/20261231102200_journey_sem_trava.sql
//
// Runs 20261015110000 (claim/leases), 20261015122000 (express) and then the
// Sem trava migration inside an in-memory Postgres (PGlite) on a minimal schema.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, "supabase/migrations", file), "utf8");
const LEASES = read("20261015110000_journey_dispatch_leases_fairness_rate_limits.sql");
const EXPRESS = read("20261015122000_express_journeys.sql");
const SEM_TRAVA = read("20261231102200_journey_sem_trava.sql");

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create table public.tenants (id uuid primary key);
create function public.is_demo_tenant(uuid) returns boolean language sql as $$ select false $$;
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
const HIGH = "00000000-0000-4000-8000-0000000000b1"; // priority 1
const LOW = "00000000-0000-4000-8000-0000000000b2"; // priority 3
const P1 = "00000000-0000-4000-8000-0000000000f1";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function enroll(journey: string) {
  const [row] = await rows<{ id: string }>(
    `insert into journey_enrollments (tenant_id, journey_id, player_id, next_run_at)
     values ($1, $2, $3, now() - interval '1 second') returning id`,
    [T1, journey, P1],
  );
  return row.id;
}

async function reserve(journey: string, enrollment: string) {
  const [step] = await rows<{ id: string }>(
    `select id from journey_steps where journey_id = $1 and position = 0`,
    [journey],
  );
  const [row] = await rows<{ blocked_reason: string | null }>(
    `select * from reserve_journey_delivery_with_contact_limits($1,$2,$3,$4,0,$5,'sms',1000,0)`,
    [T1, journey, enrollment, step.id, P1],
  );
  return row;
}

async function setPolicy(journey: string, policy: string) {
  await db.query(`update journeys set conflict_policy = $2 where id = $1`, [journey, policy]);
}

async function status(enrollment: string) {
  const [row] = await rows<{ status: string }>(
    `select status::text from journey_enrollments where id = $1`,
    [enrollment],
  );
  return row.status;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LEASES);
  await db.exec(`begin; ${EXPRESS}; commit;`);
  // Applied twice: the migration must be idempotent.
  await db.exec(`begin; ${SEM_TRAVA}; commit;`);
  await db.exec(`begin; ${SEM_TRAVA}; commit;`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate journey_events, journey_step_executions, journey_enrollments, journey_steps, journeys, tenants cascade;
    insert into tenants values ('${T1}');
    insert into journeys (id, tenant_id, journey_priority, conflict_policy) values
      ('${HIGH}', '${T1}', 1, 'pause_lower_priority'),
      ('${LOW}', '${T1}', 3, 'pause_lower_priority');
    insert into journey_steps (journey_id, position, step_type) values
      ('${HIGH}', 0, 'sms'), ('${LOW}', 0, 'sms');
  `);
});

describe("Com prioridade x Com prioridade", () => {
  it("the lower-numbered journey sends and the other is paused", async () => {
    await enroll(HIGH);
    const low = await enroll(LOW);
    expect((await reserve(LOW, low)).blocked_reason).toBe("priority_paused");
    expect(await status(low)).toBe("paused_by_priority");
  });

  it("stays paused while the winner is still running for the player", async () => {
    await enroll(HIGH);
    const low = await enroll(LOW);
    await reserve(LOW, low);
    await rows(`select resume_priority_paused_journeys(100)`);
    expect(await status(low)).toBe("paused_by_priority");
  });

  it("is released when the winner finishes", async () => {
    const high = await enroll(HIGH);
    const low = await enroll(LOW);
    await reserve(LOW, low);
    await db.query(`update journey_enrollments set status = 'completed' where id = $1`, [high]);
    await rows(`select resume_priority_paused_journeys(100)`);
    expect(await status(low)).toBe("waiting");
  });
});

describe("Sem trava", () => {
  it.each(["coexist", "exclusive"])(
    "a %s journey is never paused by a Com prioridade one",
    async (policy) => {
      await setPolicy(LOW, policy);
      await enroll(HIGH);
      const low = await enroll(LOW);
      expect((await reserve(LOW, low)).blocked_reason).toBeNull();
      expect(await status(low)).toBe("active");
    },
  );

  it("a Sem trava journey never pauses a Com prioridade one", async () => {
    await setPolicy(HIGH, "coexist");
    const low = await enroll(LOW);
    const high = await enroll(HIGH);
    expect((await reserve(HIGH, high)).blocked_reason).toBeNull();
    expect(await status(low)).toBe("active");
  });

  it("switching the paused journey to Sem trava releases its paused players", async () => {
    await enroll(HIGH);
    const low = await enroll(LOW);
    await reserve(LOW, low);
    await setPolicy(LOW, "coexist");
    expect(await rows(`select resume_priority_paused_journeys(100) n`)).toEqual([{ n: 1 }]);
    expect(await status(low)).toBe("waiting");
  });

  it("switching the winner to Sem trava releases the players it paused", async () => {
    await enroll(HIGH);
    const low = await enroll(LOW);
    await reserve(LOW, low);
    await setPolicy(HIGH, "coexist");
    await rows(`select resume_priority_paused_journeys(100)`);
    expect(await status(low)).toBe("waiting");
  });

  it("releases in batches of p_limit", async () => {
    for (let i = 0; i < 3; i++) {
      await db.query(
        `insert into journey_enrollments (tenant_id, journey_id, player_id, status, priority_paused_at, priority_paused_by_journey_id)
         values ($1, $2, gen_random_uuid(), 'paused_by_priority', now(), $3)`,
        [T1, LOW, HIGH],
      );
    }
    await setPolicy(LOW, "coexist");
    expect(await rows(`select resume_priority_paused_journeys(2) n`)).toEqual([{ n: 2 }]);
    expect(await rows(`select resume_priority_paused_journeys(2) n`)).toEqual([{ n: 1 }]);
  });
});

describe("data migration", () => {
  it("turns legacy exclusive journeys into Sem trava", async () => {
    await setPolicy(LOW, "exclusive");
    await db.exec(`begin; ${SEM_TRAVA}; commit;`);
    const [row] = await rows<{ conflict_policy: string }>(
      `select conflict_policy from journeys where id = $1`,
      [LOW],
    );
    expect(row.conflict_policy).toBe("coexist");
  });
});
