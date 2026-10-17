// Task 9 — SQL test for
// supabase/migrations/20261018110000_demo_tenant_skip_workers.sql: the whole
// migration applies (on minimal stubs of the tables/cron it touches) and
// `claim_sms_flow_leads` never claims a demo tenant's row, while normal and
// legacy null-tenant rows are still claimed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(resolve(__dirname, "../..", "supabase/migrations", name), "utf8");

const DEMO_FLAG = migration("20261018100000_demo_tenant_flag.sql");
const SKIP_WORKERS = migration("20261018110000_demo_tenant_skip_workers.sql");

const DEMO_TENANT = "00000000-0000-4000-8000-00000000d0d0";
const NORMAL_TENANT = "00000000-0000-4000-8000-00000000a0a0";

const DEMO_LEAD = "00000000-0000-4000-8000-0000000001d0";
const NORMAL_LEAD = "00000000-0000-4000-8000-0000000001a0";
const NULL_TENANT_LEAD = "00000000-0000-4000-8000-000000000100";

// Only what the two migrations need to apply. Function bodies are not
// validated (check_function_bodies = off) except for claim_sms_flow_leads,
// which is exercised for real below.
const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb);
  CREATE TABLE public.tenants (id uuid PRIMARY KEY, nome text NOT NULL);
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid, role text NOT NULL
  );

  CREATE TABLE public.dispatch_pause_state (
    channel text NOT NULL, tenant_id uuid NOT NULL, paused boolean NOT NULL DEFAULT false,
    PRIMARY KEY (channel, tenant_id)
  );
  CREATE TABLE public.sms_flow_leads (
    id uuid PRIMARY KEY,
    tenant_id uuid,
    status text NOT NULL,
    next_run_at timestamptz NOT NULL,
    locked_at timestamptz,
    locked_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- Row types referenced by RETURNS SETOF in the migration.
  CREATE TABLE public.email_flow_leads (id uuid PRIMARY KEY, tenant_id uuid);
  CREATE TABLE public.email_campaigns (id uuid PRIMARY KEY, tenant_id uuid);
  CREATE TABLE public.sms_campaigns (id uuid PRIMARY KEY, tenant_id uuid);
  CREATE TABLE public.call_flow_progress (id uuid PRIMARY KEY, tenant_id uuid);
  CREATE TABLE public.journey_scan_jobs (id uuid PRIMARY KEY, tenant_id uuid);
  CREATE TABLE public.meta_sync_jobs (id uuid PRIMARY KEY, tenant_id uuid);

  -- pg_cron stand-in.
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
  CREATE FUNCTION cron.schedule(_name text, _schedule text, _command text) RETURNS bigint
    LANGUAGE sql AS $f$
      INSERT INTO cron.job (jobname, schedule, command) VALUES (_name, _schedule, _command)
      RETURNING jobid
    $f$;
  CREATE FUNCTION cron.unschedule(_jobid bigint) RETURNS boolean
    LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobid = _jobid RETURNING true $f$;
  INSERT INTO cron.job (jobname, schedule, command)
    VALUES ('betleads-orchestrate-tenants', '*/5 * * * *', 'old command');
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(DEMO_FLAG);
  await db.exec("SET check_function_bodies = off;");
  await db.exec(SKIP_WORKERS);
  await db.exec("SET check_function_bodies = on;");
  await db.exec(`
    INSERT INTO public.tenants (id, nome) VALUES
      ('${DEMO_TENANT}', 'Casa Demo'),
      ('${NORMAL_TENANT}', 'Casa Normal');
    UPDATE public.tenants SET is_demo = true WHERE id = '${DEMO_TENANT}';
    INSERT INTO public.sms_flow_leads (id, tenant_id, status, next_run_at) VALUES
      ('${DEMO_LEAD}', '${DEMO_TENANT}', 'pending', now() - interval '1 minute'),
      ('${NORMAL_LEAD}', '${NORMAL_TENANT}', 'pending', now() - interval '1 minute'),
      ('${NULL_TENANT_LEAD}', NULL, 'pending', now() - interval '1 minute');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("claim_sms_flow_leads", () => {
  it("claims the normal and null-tenant rows but never the demo row", async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM public.claim_sms_flow_leads(10) ORDER BY id",
    );
    expect(rows.map((r) => r.id).sort()).toEqual([NULL_TENANT_LEAD, NORMAL_LEAD].sort());

    const { rows: demo } = await db.query<{ locked_at: string | null; locked_by: string | null }>(
      "SELECT locked_at, locked_by FROM public.sms_flow_leads WHERE id = $1",
      [DEMO_LEAD],
    );
    expect(demo[0]).toEqual({ locked_at: null, locked_by: null });
  });
});

describe("betleads-orchestrate-tenants cron", () => {
  it("is re-scheduled once with a command that skips demo tenants", async () => {
    const { rows } = await db.query<{ schedule: string; command: string }>(
      "SELECT schedule, command FROM cron.job WHERE jobname = 'betleads-orchestrate-tenants'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("*/5 * * * *");
    expect(rows[0].command).toMatch(/where\s+not\s+t\.is_demo/i);
  });
});
