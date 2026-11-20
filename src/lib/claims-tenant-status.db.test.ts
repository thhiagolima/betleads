// SA-02 — SQL test for
// supabase/migrations/20261231101700_claims_skip_suspended_and_ended.sql:
// the three worker claims never pick work of a suspended/canceled house, and
// the journey claim never picks an enrollment of a journey past its ends_at.
// Runs in an in-memory Postgres (PGlite) on minimal stubs of the tables the
// functions touch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    "../..",
    "supabase/migrations/20261231101700_claims_skip_suspended_and_ended.sql",
  ),
  "utf8",
);

const ACTIVE = "00000000-0000-4000-8000-0000000000a1";
const SUSPENDED = "00000000-0000-4000-8000-0000000000a2";
const CANCELED = "00000000-0000-4000-8000-0000000000a3";
const DEMO = "00000000-0000-4000-8000-0000000000a4";

const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    status text NOT NULL DEFAULT 'active',
    is_demo boolean NOT NULL DEFAULT false
  );
  CREATE FUNCTION public.is_demo_tenant(_tenant uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $f$
      SELECT coalesce((SELECT is_demo FROM public.tenants WHERE id = _tenant), false)
    $f$;
  CREATE TABLE public.dispatch_pause_state (
    channel text NOT NULL, tenant_id uuid NOT NULL, paused boolean NOT NULL DEFAULT false,
    PRIMARY KEY (channel, tenant_id)
  );
  CREATE TABLE public.sms_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text NOT NULL,
    scheduled_at timestamptz NOT NULL, locked_at timestamptz, locked_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.email_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text NOT NULL,
    scheduled_at timestamptz NOT NULL, locked_at timestamptz, locked_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.journeys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active', express boolean NOT NULL DEFAULT false,
    ends_at timestamptz
  );
  CREATE TABLE public.journey_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journey_id uuid NOT NULL,
    position integer NOT NULL, step_type text NOT NULL, is_enabled boolean NOT NULL DEFAULT true
  );
  CREATE TABLE public.journey_enrollments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    journey_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
    current_position integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now() - interval '1 minute',
    claimed_at timestamptz, claimed_by text, lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function journey(
  tenant: string,
  opts: { express?: boolean; endsAt?: string | null } = {},
): Promise<string> {
  const [j] = await rows<{ id: string }>(
    `insert into journeys (tenant_id, express, ends_at) values ($1, $2, $3::timestamptz) returning id`,
    [tenant, opts.express ?? false, opts.endsAt ?? null],
  );
  await db.query(
    `insert into journey_steps (journey_id, position, step_type) values ($1, 0, 'sms')`,
    [j.id],
  );
  return j.id;
}

async function enroll(tenant: string, journeyId: string): Promise<string> {
  const [e] = await rows<{ id: string }>(
    `insert into journey_enrollments (tenant_id, journey_id) values ($1, $2) returning id`,
    [tenant, journeyId],
  );
  return e.id;
}

async function claimJourneys(): Promise<string[]> {
  const claimed = await rows<{ id: string }>(
    `select id from claim_journey_enrollments_leased(100, 'test-worker', 120, null, null)`,
  );
  return claimed.map((r) => r.id).sort();
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Applied twice: CREATE OR REPLACE only, the migration must be idempotent.
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE journey_enrollments, journey_steps, journeys, sms_campaigns, email_campaigns, tenants;
    INSERT INTO tenants (id, status, is_demo) VALUES
      ('${ACTIVE}', 'active', false),
      ('${SUSPENDED}', 'suspended', false),
      ('${CANCELED}', 'canceled', false),
      ('${DEMO}', 'active', true);
  `);
});

describe("claim_due_sms_campaigns / claim_due_email_campaigns", () => {
  for (const table of ["sms_campaigns", "email_campaigns"] as const) {
    const fn = table === "sms_campaigns" ? "claim_due_sms_campaigns" : "claim_due_email_campaigns";

    it(`${fn}: claims the active house (and a null tenant), never suspended/canceled/demo`, async () => {
      await db.exec(`
        INSERT INTO ${table} (tenant_id, status, scheduled_at) VALUES
          ('${ACTIVE}', 'agendada', now() - interval '1 minute'),
          ('${SUSPENDED}', 'agendada', now() - interval '1 minute'),
          ('${CANCELED}', 'agendada', now() - interval '1 minute'),
          ('${DEMO}', 'agendada', now() - interval '1 minute'),
          (NULL, 'agendada', now() - interval '1 minute');
      `);
      const claimed = await rows<{ tenant_id: string | null }>(`select tenant_id from ${fn}(10)`);
      expect(claimed.map((r) => r.tenant_id).sort()).toEqual([ACTIVE, null].sort());
      const untouched = await rows<{ status: string }>(
        `select status from ${table} where tenant_id in ($1, $2)`,
        [SUSPENDED, CANCELED],
      );
      expect(untouched.map((r) => r.status)).toEqual(["agendada", "agendada"]);
    });
  }

  it("claim_due_sms_campaigns: a suspended house's stale 'enviando' campaign is not reclaimed", async () => {
    await db.exec(`
      INSERT INTO sms_campaigns (tenant_id, status, scheduled_at, locked_at) VALUES
        ('${SUSPENDED}', 'enviando', now() - interval '1 hour', now() - interval '10 minutes');
    `);
    expect(await rows(`select id from claim_due_sms_campaigns(10)`)).toEqual([]);
  });
});

describe("claim_journey_enrollments_leased", () => {
  it("never claims a suspended or canceled house's enrollments", async () => {
    const ok = await enroll(ACTIVE, await journey(ACTIVE));
    await enroll(SUSPENDED, await journey(SUSPENDED));
    await enroll(CANCELED, await journey(CANCELED, { express: true }));
    await enroll(DEMO, await journey(DEMO));
    expect(await claimJourneys()).toEqual([ok]);
  });

  it("never claims an enrollment of a journey past its end date (regular and express)", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await enroll(ACTIVE, await journey(ACTIVE, { endsAt: past }));
    await enroll(ACTIVE, await journey(ACTIVE, { endsAt: past, express: true }));
    const open = await enroll(ACTIVE, await journey(ACTIVE, { endsAt: future }));
    const openExpress = await enroll(ACTIVE, await journey(ACTIVE, { express: true }));
    expect(await claimJourneys()).toEqual([open, openExpress].sort());
  });
});
