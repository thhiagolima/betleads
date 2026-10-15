// ENV-01 / ENV-04 / ENV-05 — SQL regression tests for
// supabase/migrations/20261015110000_journey_dispatch_leases_fairness_rate_limits.sql
//
// Runs the real migration inside an in-memory Postgres (PGlite, WASM) on top of a
// minimal schema with only the columns the functions touch. PGlite has a single
// connection, so true concurrency (SKIP LOCKED, row locks) is validated
// separately against a real Postgres; here we verify lease semantics, fairness,
// pause filtering, slots and token-bucket arithmetic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const MIGRATION = readFileSync(
  resolve(
    root,
    "supabase/migrations/20261015110000_journey_dispatch_leases_fairness_rate_limits.sql",
  ),
  "utf8",
);

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
  status public.journey_status not null default 'active');
create table public.journey_steps (
  id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.journeys(id),
  position integer not null, step_type public.journey_step_type not null,
  is_enabled boolean not null default true, unique (journey_id, position));
create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  journey_id uuid not null references public.journeys(id),
  status public.journey_enrollment_status not null default 'active',
  current_position integer not null default 0,
  next_run_at timestamptz not null default now(),
  attempts integer not null default 0,
  claimed_at timestamptz, claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index journey_enrollments_ready_idx on public.journey_enrollments(status, next_run_at)
  where status in ('active','waiting');
create table public.journey_step_executions (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.journey_enrollments(id),
  status public.journey_execution_status not null default 'claimed',
  error text, completed_at timestamptz,
  updated_at timestamptz not null default now());
create table public.dispatch_pause_state (
  channel text not null, tenant_id uuid not null, paused boolean not null default false,
  primary key (channel, tenant_id));
`;

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const T3 = "00000000-0000-4000-8000-000000000003";
const J1 = "00000000-0000-4000-8000-0000000000a1";
const J2 = "00000000-0000-4000-8000-0000000000a2";
const J3 = "00000000-0000-4000-8000-0000000000a3";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function seedEnrollments(tenant: string, journey: string, count: number, ageSeconds = 60) {
  await db.query(
    `insert into journey_enrollments (tenant_id, journey_id, next_run_at, created_at)
     select $1, $2, now() - make_interval(secs => $3 + g), now() - make_interval(secs => $3 + g)
     from generate_series(1, $4) g`,
    [tenant, journey, ageSeconds, count],
  );
}

async function claim(
  limit: number,
  worker: string,
  tenants: string[] = [],
  journeys: string[] = [],
  exclude: string[] = [],
) {
  return rows<{ id: string; tenant_id: string; lease_expires_at: string; step_type: string | null }>(
    `select * from claim_journey_enrollments_leased($1, $2, 120, $3::uuid[], $4::uuid[], $5::text[])`,
    [limit, worker, tenants, journeys, exclude],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  // TRUNCATE tenants CASCADE also empties channel_rate_limits: keep the seed.
  await db.exec(`create table rate_limit_seed as select * from channel_rate_limits`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    truncate journey_step_executions, journey_enrollments, journey_steps, journeys, tenants,
      dispatch_pause_state, journey_dispatcher_slots, channel_budget_buckets,
      channel_concurrency_permits cascade;
    insert into tenants values ('${T1}'), ('${T2}'), ('${T3}');
    insert into journeys values ('${J1}', '${T1}', 'active'), ('${J2}', '${T2}', 'active'),
      ('${J3}', '${T3}', 'active');
    insert into journey_steps (journey_id, position, step_type) values
      ('${J1}', 0, 'sms'), ('${J2}', 0, 'email'), ('${J3}', 0, 'voice');
    truncate channel_rate_limits;
    insert into channel_rate_limits select * from rate_limit_seed;
  `);
});

describe("lease-aware claim (ENV-01)", () => {
  it("never returns the same item to two claims while the lease is live", async () => {
    await seedEnrollments(T1, J1, 30);
    const a = await claim(20, "worker-a");
    const b = await claim(20, "worker-b");
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(10);
    const ids = new Set(a.map((r) => r.id));
    expect(b.some((r) => ids.has(r.id))).toBe(false);
    expect(await claim(20, "worker-c")).toHaveLength(0);
    const [lease] = await rows<{ secs: number }>(
      `select extract(epoch from lease_expires_at - now())::int secs from journey_enrollments where id = $1`,
      [a[0].id],
    );
    expect(lease.secs).toBe(120);
  });

  it("reclaims an expired lease but not a live one", async () => {
    await seedEnrollments(T1, J1, 2);
    const first = await claim(2, "worker-a");
    await db.query(
      `update journey_enrollments set lease_expires_at = now() - interval '1 second' where id = $1`,
      [first[0].id],
    );
    const second = await claim(10, "worker-b");
    expect(second.map((r) => r.id)).toEqual([first[0].id]);
    const [row] = await rows<{ claimed_by: string }>(
      `select claimed_by from journey_enrollments where id = $1`,
      [first[0].id],
    );
    expect(row.claimed_by).toBe("worker-b");
  });

  it("keeps the 10-minute rule for legacy claims without a lease", async () => {
    await seedEnrollments(T1, J1, 3);
    await db.exec(`
      with r as (select id, row_number() over (order by id) n from journey_enrollments)
      update journey_enrollments e set
        claimed_at = case r.n when 1 then now() - interval '2 minutes'
                              when 2 then now() - interval '11 minutes' else null end,
        claimed_by = case r.n when 3 then null else 'journey-dispatcher' end,
        -- row 3: released by old code (claimed_at null) with a stale future lease left behind
        lease_expires_at = case r.n when 3 then now() + interval '5 minutes' else null end
      from r where r.id = e.id`);
    const claimed = await claim(10, "worker-new");
    expect(claimed).toHaveLength(2);
  });

  it("old claim_due_journey_enrollments signature still works with a 600 s lease", async () => {
    await seedEnrollments(T1, J1, 3);
    const legacy = await rows<{ id: string }>(
      `select * from claim_due_journey_enrollments(10, '{}'::uuid[], '{}'::uuid[])`,
    );
    expect(legacy).toHaveLength(3);
    const [row] = await rows<{ claimed_by: string; secs: number }>(
      `select claimed_by, extract(epoch from lease_expires_at - claimed_at)::int secs
       from journey_enrollments where id = $1`,
      [legacy[0].id],
    );
    expect(row).toEqual({ claimed_by: "journey-dispatcher", secs: 600 });
    expect(await claim(10, "worker-new")).toHaveLength(0);
  });

  it("recover_orphaned_journey_claims releases only expired leases", async () => {
    await seedEnrollments(T1, J1, 2);
    const claimed = await claim(2, "worker-a");
    // Live lease but claimed 15 minutes ago (long run): must NOT be released.
    await db.query(
      `update journey_enrollments set claimed_at = now() - interval '15 minutes' where id = $1`,
      [claimed[0].id],
    );
    await db.query(
      `update journey_enrollments set lease_expires_at = now() - interval '1 second' where id = $1`,
      [claimed[1].id],
    );
    await db.query(
      `insert into journey_step_executions (enrollment_id, status, updated_at)
       values ($1, 'claimed', now() - interval '20 minutes'), ($2, 'claimed', now() - interval '20 minutes')`,
      [claimed[0].id, claimed[1].id],
    );
    await db.query(`select recover_orphaned_journey_claims()`);
    const state = await rows<{ id: string; claimed_by: string | null }>(
      `select id, claimed_by from journey_enrollments`,
    );
    expect(state.find((r) => r.id === claimed[0].id)?.claimed_by).toBe("worker-a");
    expect(state.find((r) => r.id === claimed[1].id)?.claimed_by).toBeNull();
    const executions = await rows<{ enrollment_id: string; status: string }>(
      `select enrollment_id, status::text from journey_step_executions`,
    );
    expect(executions.find((r) => r.enrollment_id === claimed[0].id)?.status).toBe("claimed");
    expect(executions.find((r) => r.enrollment_id === claimed[1].id)?.status).toBe("retrying");
  });

  it("renews owned leases, reports lost ones and releases unstarted items", async () => {
    await seedEnrollments(T1, J1, 3);
    const claimed = await claim(3, "worker-a");
    const ids = claimed.map((r) => r.id);
    // Item 3 was taken over by another worker after its lease expired.
    await db.query(`update journey_enrollments set claimed_by = 'worker-b' where id = $1`, [ids[2]]);
    const [renewal] = await rows<{ slot_held: boolean; lost_ids: string[] }>(
      `select * from renew_journey_dispatch_leases('worker-a', null, $1::uuid[], 300)`,
      [ids],
    );
    expect(renewal.slot_held).toBe(false);
    expect(renewal.lost_ids).toEqual([ids[2]]);
    const [released] = await rows<{ n: number }>(
      `select release_journey_enrollment_claims('worker-a', $1::uuid[]) n`,
      [ids],
    );
    expect(released.n).toBe(2);
    expect(await claim(10, "worker-c")).toHaveLength(2);
  });
});

describe("per-tenant fairness (ENV-05)", () => {
  it("a 1000-item backlog does not starve a 10-item tenant", async () => {
    await seedEnrollments(T1, J1, 1000, 3600); // older than everything from T2
    await seedEnrollments(T2, J2, 10, 60);
    const batch = await claim(20, "worker-a");
    const perTenant = batch.reduce<Record<string, number>>((acc, r) => {
      acc[r.tenant_id] = (acc[r.tenant_id] ?? 0) + 1;
      return acc;
    }, {});
    expect(perTenant).toEqual({ [T1]: 10, [T2]: 10 });
    // A newly due item of the small tenant is served by the very next claim.
    await seedEnrollments(T2, J2, 1, 1);
    const next = await claim(4, "worker-b");
    expect(next.filter((r) => r.tenant_id === T2)).toHaveLength(1);
  });

  it("interleaves tenants round-robin inside one batch", async () => {
    await seedEnrollments(T1, J1, 50, 3600);
    await seedEnrollments(T2, J2, 50, 60);
    await seedEnrollments(T3, J3, 50, 30);
    const batch = await claim(6, "worker-a");
    expect(new Set(batch.map((r) => r.tenant_id)).size).toBe(3);
  });

  it("keeps the canary tenant/journey allowlists", async () => {
    await seedEnrollments(T1, J1, 5);
    await seedEnrollments(T2, J2, 5);
    expect((await claim(20, "w", [T2])).every((r) => r.tenant_id === T2)).toBe(true);
    expect(await claim(20, "w2", [], [J1])).toHaveLength(5);
  });

  it("skips items whose current channel is paused for the tenant", async () => {
    await seedEnrollments(T1, J1, 5); // sms
    await seedEnrollments(T3, J3, 5); // voice -> 'call'
    await db.exec(`insert into dispatch_pause_state values ('call', '${T3}', true), ('sms', '${T2}', true)`);
    const batch = await claim(20, "w");
    expect(batch).toHaveLength(5);
    expect(batch.every((r) => r.tenant_id === T1)).toBe(true);
  });

  it("returns the step type and skips excluded (tenant, channel) pairs (I2)", async () => {
    await seedEnrollments(T1, J1, 3); // sms
    await seedEnrollments(T2, J2, 3); // email
    const batch = await claim(20, "w", [], [], [`${T1}:sms`, `${T2}:voice`]);
    expect(batch).toHaveLength(3);
    expect(batch.every((r) => r.tenant_id === T2 && r.step_type === "email")).toBe(true);
    const rest = await claim(20, "w2");
    expect(rest.map((r) => r.step_type)).toEqual(["sms", "sms", "sms"]);
  });

  it("skips inactive journeys and future items", async () => {
    await seedEnrollments(T1, J1, 3);
    await db.exec(`update journey_enrollments set next_run_at = now() + interval '1 hour'`);
    await seedEnrollments(T2, J2, 3);
    await db.exec(`update journeys set status = 'paused' where id = '${J2}'`);
    expect(await claim(20, "w")).toHaveLength(0);
  });
});

describe("dispatcher slots (ENV-01 mutual exclusion)", () => {
  it("grants at most N slots and frees them on release or lease expiry", async () => {
    const slot = async (holder: string, max = 1) =>
      (await rows<{ s: number | null }>(`select acquire_journey_dispatcher_slot($1, $2, 120) s`, [holder, max]))[0].s;
    expect(await slot("run-1")).toBe(0);
    expect(await slot("run-2")).toBeNull();
    expect(await slot("run-2", 2)).toBe(1);
    expect(await slot("run-3", 2)).toBeNull();
    await db.query(`select release_journey_dispatcher_slot(0, 'run-1')`);
    expect(await slot("run-3", 2)).toBe(0);
    await db.exec(`update journey_dispatcher_slots set lease_expires_at = now() - interval '1 second' where slot = 1`);
    expect(await slot("run-4", 2)).toBe(1);
    // A renewal by a holder that lost its slot reports it.
    const [renewal] = await rows<{ slot_held: boolean }>(
      `select * from renew_journey_dispatch_leases('run-2', 1, '{}'::uuid[], 120)`,
    );
    expect(renewal.slot_held).toBe(false);
  });
});

describe("channel budget (ENV-04)", () => {
  type Grant = { granted: number; retry_after_ms: number; limited_by: string | null };
  const consume = async (tenant: string, channel: string, n: number) =>
    (await rows<Grant>(`select * from consume_channel_budget($1, $2, $3)`, [tenant, channel, n]))[0];

  // Freezes refill: elapsed time is negative until `refilled_at`, so the
  // assertions below do not depend on how long PGlite takes between queries.
  const freezeBuckets = () =>
    db.exec(`update channel_budget_buckets set refilled_at = clock_timestamp() + interval '1 hour'`);

  it("applies the per-tenant limit (burst 15, then 5/s SMS) and reports when to retry", async () => {
    expect((await consume(T1, "sms", 15)).granted).toBe(15); // burst = 3 s
    await freezeBuckets();
    expect((await consume(T1, "sms", 1)).granted).toBe(0);
    // One second later: the tenant bucket (5/s) is the binding limit.
    await db.exec(`update channel_budget_buckets set refilled_at = clock_timestamp() - interval '1 second'`);
    const next = await consume(T1, "sms", 10);
    expect(next.granted).toBe(5);
    expect(next.limited_by).toBe("tenant");
    expect(next.retry_after_ms).toBeGreaterThan(0);
    expect(next.retry_after_ms).toBeLessThanOrEqual(200);
  });

  it("applies the global limit (15/s SMS) across tenants", async () => {
    const T4 = "00000000-0000-4000-8000-000000000004";
    const T5 = "00000000-0000-4000-8000-000000000005";
    let total = 0;
    for (const tenant of [T1, T2, T3]) {
      total += (await consume(tenant, "sms", 5)).granted;
      // Freeze after each call: refill between the queries made this flaky.
      await freezeBuckets();
    }
    expect(total).toBe(15);
    await freezeBuckets(); // no refill between the queries (was time-sensitive)
    const starved = await consume(T4, "sms", 1);
    expect(starved).toMatchObject({ granted: 0, limited_by: "global" });
    expect((await consume(T5, "email", 1)).granted).toBe(1); // independent channel
  });

  it("refills by elapsed time, capped at the burst", async () => {
    await consume(T1, "sms", 5);
    await db.exec(`update channel_budget_buckets set refilled_at = refilled_at - interval '10 seconds'`);
    expect((await consume(T1, "sms", 100)).granted).toBe(15); // capped at the burst
    await db.exec(`update channel_budget_buckets set refilled_at = clock_timestamp() - interval '400 milliseconds'`);
    expect((await consume(T1, "sms", 100)).granted).toBe(2); // 0.4 s * 5/s
  });

  it("uses edited limits without deploy and tenant overrides", async () => {
    await db.exec(`update channel_rate_limits set per_second = 2 where channel = 'email' and scope = 'tenant_default'`);
    expect((await consume(T1, "email", 10)).granted).toBe(2);
    await db.exec(`insert into channel_rate_limits (provider, channel, scope, tenant_id, per_second)
                   values ('infobip', 'email', 'tenant', '${T2}', 8)`);
    expect((await consume(T2, "email", 10)).granted).toBe(8);
  });

  it("grants everything for a channel without configured limits", async () => {
    expect(await consume(T1, "whatsapp", 7)).toMatchObject({ granted: 7, limited_by: null });
  });

  it("limits voice concurrency (2 per tenant, 5 global) with releasable permits", async () => {
    type Permit = { permit_id: string | null; retry_after_ms: number; limited_by: string | null };
    const acquire = async (tenant: string) =>
      (await rows<Permit>(`select * from acquire_channel_slot($1, 'voice', 'test')`, [tenant]))[0];
    const a = await acquire(T1);
    const b = await acquire(T1);
    expect(a.permit_id).toBeTruthy();
    expect(b.permit_id).toBeTruthy();
    const c = await acquire(T1);
    expect(c).toMatchObject({ permit_id: null, limited_by: "tenant" });
    expect(c.retry_after_ms).toBeGreaterThan(0);
    await db.query(`select release_channel_slot($1)`, [a.permit_id]);
    expect((await acquire(T1)).permit_id).toBeTruthy();
    expect((await acquire(T2)).permit_id).toBeTruthy();
    expect((await acquire(T2)).permit_id).toBeTruthy();
    expect((await acquire(T3)).permit_id).toBeTruthy(); // 5th global permit
    expect(await acquire(T3)).toMatchObject({ permit_id: null, limited_by: "global" });
    await db.exec(`update channel_concurrency_permits set expires_at = now() - interval '1 second'`);
    expect((await acquire(T3)).permit_id).toBeTruthy();
    // Channels without concurrency limits get a no-op permit.
    expect(
      (await rows<Permit>(`select * from acquire_channel_slot($1, 'sms')`, [T1]))[0],
    ).toMatchObject({ permit_id: null, limited_by: null });
  });
});
