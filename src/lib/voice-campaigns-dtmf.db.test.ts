// Voice campaigns + DTMF — SQL tests for
// supabase/migrations/20261226100000_voice_campaigns_and_dtmf.sql
// (docs/ESCOPO_VOZ_LOTE_E_INTERACAO_DTMF_2026-11-11.md, V1-03 / V1-04).
//
// Runs the migration inside an in-memory Postgres (PGlite) on top of a
// schema that copies the production tenant helpers literally (same sources
// as expert-rls.db.test.ts) and mirrors the production shape and RLS of the
// tables the migration references (tenants, call_scripts,
// journey_voice_assets, call_queue, call_history). The full migration chain
// is not replayed: it needs Supabase-only objects PGlite does not have.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261226100000_voice_campaigns_and_dtmf.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create type public.app_role as enum ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Casa'
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tenant_id uuid,
  role public.app_role not null
);

-- 20260609200834_8b7989c6-004f-45db-bf6c-7416d26842ee.sql (literal)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid DEFAULT auth.uid())
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'super_admin' AND tenant_id IS NULL
  )
$function$;

-- 20261003093000_tenant_admin_gestor_model.sql (literal)
CREATE OR REPLACE FUNCTION public.has_tenant_access(_tenant_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin(_user_id) OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant_id
      AND role IN ('admin', 'gestor', 'member')
  )
$$;

-- 20261003100000_active_tenant_request_context.sql (literal)
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_requested text;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_requested := current_setting('request.headers', true)::jsonb ->> 'x-active-tenant';
    IF v_requested IS NOT NULL AND v_requested <> '' THEN
      v_tenant := v_requested::uuid;
      IF public.has_tenant_access(v_tenant, v_uid) THEN
        RETURN v_tenant;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT tenant_id INTO v_tenant
  FROM public.user_roles
  WHERE user_id = v_uid AND tenant_id IS NOT NULL
    AND role IN ('admin', 'gestor', 'member')
  ORDER BY tenant_id
  LIMIT 1;
  RETURN v_tenant;
END;
$$;

-- Referenced tables, reduced to the columns that matter here; RLS as in
-- 20261015090000_consolidate_tenant_rls.sql (SA_OR_CUR_ALL).
create table public.call_scripts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  name text not null default 'Roteiro'
);
create table public.journey_voice_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null default 'Audio'
);
create type public.call_queue_status as enum (
  'pending_audio', 'audio_ready', 'queued', 'waiting_provider', 'calling',
  'completed', 'failed', 'cancelled', 'paused'
);
create table public.call_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  script_id uuid references public.call_scripts(id) on delete set null,
  trigger_name text,
  phone_number text,
  status public.call_queue_status not null default 'pending_audio',
  provider_status text,
  scheduled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.call_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  call_queue_id uuid references public.call_queue(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.call_queue enable row level security;
CREATE POLICY call_queue_tenant_rls ON public.call_queue
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
alter table public.call_history enable row level security;
CREATE POLICY call_history_tenant_rls ON public.call_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

grant usage on schema auth, public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;

-- Supabase's real default: new tables grant authenticated full CRUD unless
-- the migration revokes it explicitly.
alter default privileges in schema public grant all on tables to anon, authenticated;
`;

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const ADMIN_A = "00000000-0000-4000-8000-0000000000a1";
const ADMIN_B = "00000000-0000-4000-8000-0000000000b1";

let db: PGlite;
const ids: Record<string, string> = {};

type Row = Record<string, unknown>;

async function asUser<T extends Row>(userId: string, sql: string): Promise<T[]> {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await db.query(`select set_config('request.headers', '{}', true)`);
    await db.exec("SET LOCAL ROLE authenticated");
    const { rows } = await db.query<T>(sql);
    return rows;
  } finally {
    await db.query("ROLLBACK");
  }
}

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  return rows[0].id;
}

// Seeds one campaign → batch → queue item → history → option → response →
// run for a tenant; returns the ids.
async function seedTenant(tenant: string, tag: string) {
  const campaign = await one(
    `insert into public.voice_campaigns (tenant_id, name, dispatch_mode, dtmf_enabled, repeat_digit)
     values ($1, $2, 'bulk', true, '*') returning id`,
    [tenant, `Campanha ${tag}`],
  );
  const batch = await one(
    `insert into public.voice_campaign_batches (tenant_id, campaign_id, seq, bulk_id)
     values ($1, $2, 1, $3) returning id`,
    [tenant, campaign, `vc:${campaign}:1`],
  );
  const queue = await one(
    `insert into public.call_queue (tenant_id, voice_campaign_id, batch_id, provider_message_id, dispatch_mode)
     values ($1, $2, $3, $4, 'bulk') returning id`,
    [tenant, campaign, batch, `msg-${tag}`],
  );
  const history = await one(
    `insert into public.call_history (tenant_id, call_queue_id, provider_message_id, bulk_id, answered_by, dtmf_codes)
     values ($1, $2, $3, $4, 'human', '1') returning id`,
    [tenant, queue, `msg-${tag}`, `vc:${campaign}:1`],
  );
  const option = await one(
    `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, label, action_type, action_config)
     values ($1, 'campaign', $2, '1', 'Quero bônus', 'send_sms', '{"text":"oi"}') returning id`,
    [tenant, campaign],
  );
  const response = await one(
    `insert into public.voice_dtmf_responses (tenant_id, call_history_id, call_queue_id, phone, digits, matched_option_id, received_via)
     values ($1, $2, $3, '+5511999990000', '1', $4, 'report') returning id`,
    [tenant, history, queue, option],
  );
  const run = await one(
    `insert into public.voice_dtmf_action_runs (tenant_id, response_id, option_id, action_type)
     values ($1, $2, $3, 'send_sms') returning id`,
    [tenant, response, option],
  );
  return { campaign, batch, queue, history, option, response, run };
}

async function expectSqlError(sql: string, params: unknown[], pattern: RegExp) {
  await expect(db.query(sql, params)).rejects.toThrow(pattern);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);

  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa A'), ($2, 'Casa B')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await db.query(
    `insert into public.user_roles (user_id, tenant_id, role) values ($1, $2, 'admin'), ($3, $4, 'admin')`,
    [ADMIN_A, TENANT_A, ADMIN_B, TENANT_B],
  );

  const a = await seedTenant(TENANT_A, "a");
  const b = await seedTenant(TENANT_B, "b");
  for (const [k, v] of Object.entries(a)) ids[`a_${k}`] = v;
  for (const [k, v] of Object.entries(b)) ids[`b_${k}`] = v;
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("20261226100000_voice_campaigns_and_dtmf", () => {
  it("is idempotent (re-applying the migration is a no-op)", async () => {
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("applies the defaults of voice_campaigns", async () => {
    const { rows } = await db.query<Row>(
      `insert into public.voice_campaigns (tenant_id, name) values ($1, 'Padrão')
       returning dispatch_mode, status, recipient_count, dtmf_enabled, dtmf_max_digits, dtmf_timeout_s, repeat_digit`,
      [TENANT_A],
    );
    expect(rows[0]).toEqual({
      dispatch_mode: "cml",
      status: "scheduled",
      recipient_count: 0,
      dtmf_enabled: false,
      dtmf_max_digits: 1,
      dtmf_timeout_s: 10,
      repeat_digit: null,
    });
  });

  it("rejects bad campaign settings", async () => {
    const insert = `insert into public.voice_campaigns (tenant_id, name, dispatch_mode, status, dtmf_max_digits, dtmf_timeout_s, repeat_digit)
      values ($1, 'x', $2, $3, $4, $5, $6)`;
    await expectSqlError(insert, [TENANT_A, "sms", "scheduled", 1, 10, null], /check constraint/);
    await expectSqlError(insert, [TENANT_A, "cml", "running", 1, 10, null], /check constraint/);
    await expectSqlError(insert, [TENANT_A, "cml", "draft", 11, 10, null], /check constraint/);
    await expectSqlError(insert, [TENANT_A, "cml", "draft", 1, 61, null], /check constraint/);
    await expectSqlError(insert, [TENANT_A, "cml", "draft", 1, 10, "#"], /check constraint/);
    await expectSqlError(insert, [TENANT_A, "cml", "draft", 1, 10, "12"], /check constraint/);
  });

  it("rejects a duplicate bulk_id and a duplicate (campaign_id, seq)", async () => {
    await expectSqlError(
      `insert into public.voice_campaign_batches (tenant_id, campaign_id, seq, bulk_id) values ($1, $2, 2, $3)`,
      [TENANT_A, ids.a_campaign, `vc:${ids.a_campaign}:1`],
      /duplicate key/,
    );
    await expectSqlError(
      `insert into public.voice_campaign_batches (tenant_id, campaign_id, seq, bulk_id) values ($1, $2, 1, 'other')`,
      [TENANT_A, ids.a_campaign],
      /duplicate key/,
    );
  });

  it("rejects a duplicate call_queue.provider_message_id but allows many nulls", async () => {
    await expectSqlError(
      `insert into public.call_queue (tenant_id, provider_message_id) values ($1, 'msg-a')`,
      [TENANT_A],
      /duplicate key/,
    );
    await db.query(`insert into public.call_queue (tenant_id) values ($1), ($1)`, [TENANT_A]);
  });

  it("rejects a bad call_queue.dispatch_mode and call_history.answered_by", async () => {
    await expectSqlError(
      `insert into public.call_queue (tenant_id, dispatch_mode) values ($1, 'sip')`,
      [TENANT_A],
      /check constraint/,
    );
    await expectSqlError(
      `insert into public.call_history (tenant_id, answered_by) values ($1, 'fax')`,
      [TENANT_A],
      /check constraint/,
    );
  });

  it("rejects a duplicate (tenant_id, owner_type, owner_id, digit) option", async () => {
    await expectSqlError(
      `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, action_type)
       values ($1, 'campaign', $2, '1', 'add_tag')`,
      [TENANT_A, ids.a_campaign],
      /duplicate key/,
    );
    // Same digit on a script owner with the same uuid is a different owner.
    await db.query(
      `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, action_type)
       values ($1, 'script', $2, '1', 'add_tag')`,
      [TENANT_A, ids.a_campaign],
    );
    // The uniqueness is per house: another house never collides with it.
    await db.query(
      `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, action_type)
       values ($1, 'campaign', $2, '1', 'add_tag')`,
      [TENANT_B, ids.a_campaign],
    );
  });

  it("a queue item or batch only points at a campaign/batch of its own house", async () => {
    await expectSqlError(
      `insert into public.call_queue (tenant_id, voice_campaign_id) values ($1, $2)`,
      [TENANT_B, ids.a_campaign],
      /foreign key constraint/,
    );
    await expectSqlError(
      `insert into public.call_queue (tenant_id, batch_id) values ($1, $2)`,
      [TENANT_B, ids.a_batch],
      /foreign key constraint/,
    );
    await expectSqlError(
      `insert into public.voice_campaign_batches (tenant_id, campaign_id, seq, bulk_id)
       values ($1, $2, 9, 'cross-tenant')`,
      [TENANT_B, ids.a_campaign],
      /foreign key constraint/,
    );
    await expectSqlError(
      `update public.call_queue set voice_campaign_id = $1 where id = $2`,
      [ids.a_campaign, ids.b_queue],
      /foreign key constraint/,
    );
    // Same house: accepted.
    await db.query(`insert into public.call_queue (tenant_id, voice_campaign_id) values ($1, $2)`, [
      TENANT_A,
      ids.a_campaign,
    ]);
  });

  it("rejects a bad digit, owner_type, action_type and received_via", async () => {
    const opt = `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, action_type)
      values ($1, $2, gen_random_uuid(), $3, $4)`;
    await expectSqlError(opt, [TENANT_A, "campaign", "#", "add_tag"], /check constraint/);
    await expectSqlError(opt, [TENANT_A, "campaign", "10", "add_tag"], /check constraint/);
    await expectSqlError(opt, [TENANT_A, "journey", "2", "add_tag"], /check constraint/);
    await expectSqlError(opt, [TENANT_A, "campaign", "2", "call_me"], /check constraint/);
    await db.query(opt, [TENANT_A, "campaign", "no_input", "transfer"]);
    await db.query(opt, [TENANT_A, "campaign", "*", "revoke_voice_consent"]);

    await expectSqlError(
      `insert into public.voice_dtmf_responses (tenant_id, phone, received_via) values ($1, '+55', 'sms')`,
      [TENANT_A],
      /check constraint/,
    );
    await expectSqlError(
      `insert into public.voice_dtmf_action_runs (tenant_id, response_id, option_id, action_type)
       values ($1, $2, null, 'call_me')`,
      [TENANT_A, ids.a_response],
      /check constraint/,
    );
    await expectSqlError(
      `insert into public.voice_dtmf_action_runs (tenant_id, response_id, option_id, action_type, status)
       values ($1, $2, null, 'add_tag', 'running')`,
      [TENANT_A, ids.a_response],
      /check constraint/,
    );
  });

  it("rejects a second response for the same call (call_history_id)", async () => {
    await expectSqlError(
      `insert into public.voice_dtmf_responses (tenant_id, call_history_id, phone, digits, received_via)
       values ($1, $2, '+5511999990000', '2', 'cml')`,
      [TENANT_A, ids.a_history],
      /duplicate key/,
    );
    // Responses without a call_history row (e.g. CML before the history
    // row exists) are not constrained.
    await db.query(
      `insert into public.voice_dtmf_responses (tenant_id, phone, received_via)
       values ($1, '+55', 'cml'), ($1, '+55', 'cml')`,
      [TENANT_A],
    );
  });

  it("rejects a second run of the same action for the same response", async () => {
    await expectSqlError(
      `insert into public.voice_dtmf_action_runs (tenant_id, response_id, option_id, action_type)
       values ($1, $2, $3, 'send_sms')`,
      [TENANT_A, ids.a_response, ids.a_option],
      /duplicate key/,
    );
    const { rows } = await db.query<Row>(
      `select status, attempts from public.voice_dtmf_action_runs where id = $1`,
      [ids.a_run],
    );
    expect(rows[0]).toEqual({ status: "pending", attempts: 0 });
  });

  it("bumps updated_at on update", async () => {
    await db.query(`update public.voice_campaigns set updated_at = '2000-01-01' where id = $1`, [
      ids.a_campaign,
    ]);
    const { rows } = await db.query<{ y: number }>(
      `select extract(year from updated_at)::int as y from public.voice_campaigns where id = $1`,
      [ids.a_campaign],
    );
    expect(rows[0].y).toBeGreaterThan(2000);
  });

  describe("RLS", () => {
    const TABLES = [
      "voice_campaigns",
      "voice_campaign_batches",
      "voice_dtmf_options",
      "voice_dtmf_responses",
      "voice_dtmf_action_runs",
    ];

    it.each(TABLES)("a member of house A reads only house A rows of %s", async (table) => {
      const rows = await asUser<{ tenant_id: string }>(
        ADMIN_A,
        `select distinct tenant_id from public.${table}`,
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      const rowsB = await asUser<{ tenant_id: string }>(
        ADMIN_B,
        `select distinct tenant_id from public.${table}`,
      );
      expect(rowsB.map((r) => r.tenant_id)).toEqual([TENANT_B]);
    });

    it("a member cannot create a campaign or an option for another house", async () => {
      await expect(
        asUser(
          ADMIN_A,
          `insert into public.voice_campaigns (tenant_id, name) values ('${TENANT_B}', 'x')`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asUser(
          ADMIN_A,
          `insert into public.voice_dtmf_options (tenant_id, owner_type, owner_id, digit, action_type)
           values ('${TENANT_B}', 'campaign', gen_random_uuid(), '3', 'add_tag')`,
        ),
      ).rejects.toThrow(/row-level security/);
      const ok = await asUser<{ id: string }>(
        ADMIN_A,
        `insert into public.voice_campaigns (tenant_id, name) values ('${TENANT_A}', 'ok') returning id`,
      );
      expect(ok).toHaveLength(1);
    });

    it("batches, responses and action runs are read-only for members (service_role writes)", async () => {
      await expect(
        asUser(
          ADMIN_A,
          `insert into public.voice_dtmf_responses (tenant_id, phone, received_via)
           values ('${TENANT_A}', '+55', 'cml')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asUser(ADMIN_A, `update public.voice_dtmf_action_runs set status = 'done'`),
      ).rejects.toThrow(/permission denied/);
      await expect(asUser(ADMIN_A, `delete from public.voice_campaign_batches`)).rejects.toThrow(
        /permission denied/,
      );
    });

    describe("voice_campaign_item_counts", () => {
      const NOW = "2026-11-11T12:00:00Z";
      let counted: string;
      let single: string;
      let singleItem: string;

      beforeAll(async () => {
        counted = await one(
          `insert into public.voice_campaigns (tenant_id, name) values ($1, 'Contada') returning id`,
          [TENANT_A],
        );
        single = await one(
          `insert into public.voice_campaigns (tenant_id, name) values ($1, 'Uma') returning id`,
          [TENANT_A],
        );
        await db.query(
          `insert into public.call_queue (tenant_id, voice_campaign_id, status, provider_status, scheduled_at)
           values ($1, $2, 'completed', null, '2026-11-11T11:00:00Z'),
                  ($1, $2, 'completed', null, '2026-11-11T11:00:00Z'),
                  ($1, $2, 'failed', null, '2026-11-11T11:00:00Z'),
                  ($1, $2, 'audio_ready', null, '2026-11-11T13:00:00Z'),
                  ($1, $2, 'audio_ready', null, '2026-11-11T13:30:00Z'),
                  ($1, $2, 'audio_ready', 'cooldown', '2026-11-11T11:00:00Z')`,
          [TENANT_A, counted],
        );
        singleItem = await one(
          `insert into public.call_queue (tenant_id, voice_campaign_id, status)
           values ($1, $2, 'waiting_provider') returning id`,
          [TENANT_A, single],
        );
      });

      const call = (campaignIds: string[]) =>
        `select voice_campaign_id, status, provider_status, is_future, item_count::int as item_count,
                sample_item_id
           from public.voice_campaign_item_counts(
             array[${campaignIds.map((id) => `'${id}'`).join(",")}]::uuid[], '${NOW}')
          order by voice_campaign_id, status, provider_status nulls first, is_future`;

      it("returns one row per (campaign, status, provider_status, is_future)", async () => {
        const rows = await asUser<Row>(ADMIN_A, call([counted]));
        expect(rows).toEqual([
          {
            voice_campaign_id: counted,
            status: "audio_ready",
            provider_status: null,
            is_future: true,
            item_count: 2,
            sample_item_id: null,
          },
          {
            voice_campaign_id: counted,
            status: "audio_ready",
            provider_status: "cooldown",
            is_future: false,
            item_count: 1,
            sample_item_id: expect.any(String),
          },
          {
            voice_campaign_id: counted,
            status: "completed",
            provider_status: null,
            is_future: false,
            item_count: 2,
            sample_item_id: null,
          },
          {
            voice_campaign_id: counted,
            status: "failed",
            provider_status: null,
            is_future: false,
            item_count: 1,
            sample_item_id: expect.any(String),
          },
        ]);
      });

      it("gives the only item of a one-call campaign", async () => {
        const rows = await asUser<Row>(ADMIN_A, call([single]));
        expect(rows).toEqual([
          expect.objectContaining({ item_count: 1, sample_item_id: singleItem }),
        ]);
      });

      it("respects call_queue RLS (security invoker)", async () => {
        // House B asking for house A's campaigns gets nothing.
        expect(await asUser<Row>(ADMIN_B, call([counted, single]))).toEqual([]);
        // House A asking for both houses only sees its own items.
        const rows = await asUser<{ voice_campaign_id: string }>(
          ADMIN_A,
          call([counted, ids.b_campaign]),
        );
        expect(new Set(rows.map((r) => r.voice_campaign_id))).toEqual(new Set([counted]));
        const { rows: definer } = await db.query<{ prosecdef: boolean }>(
          `select prosecdef from pg_proc where proname = 'voice_campaign_item_counts'`,
        );
        expect(definer).toEqual([{ prosecdef: false }]);
      });

      it("anon cannot execute it", async () => {
        await db.query("BEGIN");
        try {
          await db.exec("SET LOCAL ROLE anon");
          await expect(
            db.query(`select * from public.voice_campaign_item_counts(array[]::uuid[])`),
          ).rejects.toThrow(/permission denied/);
        } finally {
          await db.query("ROLLBACK");
        }
      });
    });

    it("anon reads nothing", async () => {
      await db.query("BEGIN");
      try {
        await db.exec("SET LOCAL ROLE anon");
        await expect(db.query(`select 1 from public.voice_campaigns`)).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await db.query("ROLLBACK");
      }
    });
  });

  it("cascades and nulls on delete as specified", async () => {
    await db.query(`delete from public.voice_campaigns where id = $1`, [ids.b_campaign]);
    const { rows: batches } = await db.query(
      `select 1 from public.voice_campaign_batches where campaign_id = $1`,
      [ids.b_campaign],
    );
    expect(batches).toHaveLength(0);
    // Only the link columns are nulled; the item keeps its house.
    const { rows: queue } = await db.query<Row>(
      `select tenant_id, voice_campaign_id, batch_id from public.call_queue where id = $1`,
      [ids.b_queue],
    );
    expect(queue[0]).toEqual({ tenant_id: TENANT_B, voice_campaign_id: null, batch_id: null });

    await db.query(`delete from public.voice_dtmf_responses where id = $1`, [ids.b_response]);
    const { rows: runs } = await db.query(
      `select 1 from public.voice_dtmf_action_runs where id = $1`,
      [ids.b_run],
    );
    expect(runs).toHaveLength(0);
  });
});
