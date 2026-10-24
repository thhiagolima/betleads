// Área do Expert — Fase 1, Task 3 — SQL test for
// supabase/migrations/20261025100300_retire_crm_expert.sql
//
// Runs the Task 1 migrations (20261025100000, 20261025100100) plus this
// one inside an in-memory Postgres (PGlite) against a minimal schema, and
// asserts: non-demo CRM_EXPERT houses are archived and their flows
// deactivated, metadata affiliate ids get linked into the source house's
// expert without duplicating ids already assigned, and demo CRM_EXPERT
// houses are left untouched.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION_ROLE = readFileSync(
  resolve(root, "supabase/migrations/20261025100000_add_expert_app_role.sql"),
  "utf8",
);
const MIGRATION_MODEL = readFileSync(
  resolve(root, "supabase/migrations/20261025100100_expert_model.sql"),
  "utf8",
);
const MIGRATION_RETIRE = readFileSync(
  resolve(root, "supabase/migrations/20261025100300_retire_crm_expert.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (
  id uuid primary key
);

create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.current_tenant_id() returns uuid language sql as $$ select null::uuid $$;

create type public.app_role as enum ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Casa',
  status text not null default 'active',
  crm_model text not null default 'CRM_PLATAFORMA',
  metadata jsonb not null default '{}'::jsonb,
  is_demo boolean not null default false
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tenant_id uuid,
  role public.app_role not null,
  created_at timestamptz not null default now()
);

alter table public.user_roles
  add constraint user_roles_canonical_scope
  check (
    (role = 'super_admin' and tenant_id is null)
    or (role in ('admin', 'gestor', 'member') and tenant_id is not null)
  ) not valid;

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  affiliate_id text,
  expert text
);

-- Legacy shape, as it exists in production before the Task 1 migration.
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id text not null unique,
  nome text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.sms_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  is_active boolean not null default true
);

create table public.email_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  active boolean not null default true
);

create table public.call_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  is_active boolean not null default true
);

grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant select, insert, update, delete on public.tenants to anon, authenticated, service_role;
grant select, insert, update, delete on public.user_roles to anon, authenticated, service_role;
grant select, insert, update, delete on public.players to anon, authenticated, service_role;
grant select, insert, update, delete on public.experts to anon, authenticated, service_role;
grant select, insert, update, delete on public.sms_flows to anon, authenticated, service_role;
grant select, insert, update, delete on public.email_flows to anon, authenticated, service_role;
grant select, insert, update, delete on public.call_flows to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to authenticated;
`;

const SOURCE_TENANT = "00000000-0000-0000-0000-000000000001";
const DEMO_SOURCE_TENANT = "00000000-0000-4000-8000-0000000000d0";

let db: PGlite;

async function setupSchema() {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION_ROLE);
  await db.exec(MIGRATION_MODEL);
}

afterAll(async () => {
  await db?.close();
});

describe("archives non-demo CRM_EXPERT houses and deactivates their flows", () => {
  let houseId: string;

  beforeAll(async () => {
    await setupSchema();

    await db.query(`insert into public.tenants (id, nome, crm_model, is_demo) values ($1, 'Casa principal', 'CRM_PLATAFORMA', false)`, [
      SOURCE_TENANT,
    ]);

    const { rows } = await db.query<{ id: string }>(
      `insert into public.tenants (nome, crm_model, is_demo, metadata)
       values ('CRM Expert - Alisson Kevin Queiroz', 'CRM_EXPERT', false, '{"expert_affiliate_ids": ["AFF1", "AFF2"]}'::jsonb)
       returning id`,
    );
    houseId = rows[0].id;

    await db.query(`insert into public.sms_flows (tenant_id) values ($1)`, [houseId]);
    await db.query(`insert into public.email_flows (tenant_id) values ($1)`, [houseId]);
    await db.query(`insert into public.call_flows (tenant_id) values ($1)`, [houseId]);

    await db.exec(MIGRATION_RETIRE);
  });

  it("archives the house with status canceled and archived metadata", async () => {
    const { rows } = await db.query<{ status: string; metadata: Record<string, unknown> }>(
      `select status, metadata from public.tenants where id = $1`,
      [houseId],
    );
    expect(rows[0].status).toBe("canceled");
    expect(rows[0].metadata).toMatchObject({ archived_reason: "crm_expert_retired" });
    expect(rows[0].metadata.archived_at).toBeTruthy();
  });

  it("deactivates its sms_flows, email_flows and call_flows", async () => {
    const { rows: sms } = await db.query<{ is_active: boolean }>(
      `select is_active from public.sms_flows where tenant_id = $1`,
      [houseId],
    );
    const { rows: email } = await db.query<{ active: boolean }>(
      `select active from public.email_flows where tenant_id = $1`,
      [houseId],
    );
    const { rows: call } = await db.query<{ is_active: boolean }>(
      `select is_active from public.call_flows where tenant_id = $1`,
      [houseId],
    );
    expect(sms[0].is_active).toBe(false);
    expect(email[0].active).toBe(false);
    expect(call[0].is_active).toBe(false);
  });
});

describe("links metadata affiliate ids to an expert in the source house without duplicating existing ones", () => {
  beforeAll(async () => {
    await setupSchema();

    await db.query(`insert into public.tenants (id, nome, crm_model, is_demo) values ($1, 'Casa principal', 'CRM_PLATAFORMA', false)`, [
      SOURCE_TENANT,
    ]);

    // The source house already has Queiroz with AFF1 (the production shape).
    const { rows: expertRows } = await db.query<{ id: string }>(
      `insert into public.experts (tenant_id, nome) values ($1, 'Queiroz') returning id`,
      [SOURCE_TENANT],
    );
    await db.query(
      `insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id) values ($1, $2, 'AFF1')`,
      [SOURCE_TENANT, expertRows[0].id],
    );

    await db.query(
      `insert into public.tenants (nome, crm_model, is_demo, metadata)
       values ('CRM Expert - Queiroz', 'CRM_EXPERT', false, '{"expert_affiliate_ids": ["AFF1", "AFF2"]}'::jsonb)`,
    );

    await db.exec(MIGRATION_RETIRE);
  });

  it("ends with Queiroz owning both affiliate ids and only one expert of that name", async () => {
    const { rows: experts } = await db.query<{ id: string; nome: string }>(
      `select id, nome from public.experts where tenant_id = $1 and lower(btrim(nome)) = 'queiroz'`,
      [SOURCE_TENANT],
    );
    expect(experts).toHaveLength(1);

    const { rows: affiliates } = await db.query<{ affiliate_id: string }>(
      `select affiliate_id from public.expert_affiliates where tenant_id = $1 and expert_id = $2 order by affiliate_id`,
      [SOURCE_TENANT, experts[0].id],
    );
    expect(affiliates.map((r) => r.affiliate_id)).toEqual(["AFF1", "AFF2"]);
  });
});

describe("leaves demo CRM_EXPERT houses untouched", () => {
  let houseId: string;

  beforeAll(async () => {
    await setupSchema();

    await db.query(
      `insert into public.tenants (id, nome, crm_model, is_demo) values ($1, 'Casa demo', 'CRM_PLATAFORMA', true)`,
      [DEMO_SOURCE_TENANT],
    );

    const { rows } = await db.query<{ id: string }>(
      `insert into public.tenants (nome, crm_model, is_demo, metadata, status)
       values ('CRM Expert - Demo', 'CRM_EXPERT', true, '{"source_tenant_id": "${DEMO_SOURCE_TENANT}", "expert_affiliate_ids": ["AFF-DEMO"]}'::jsonb, 'active')
       returning id`,
    );
    houseId = rows[0].id;

    await db.query(`insert into public.sms_flows (tenant_id) values ($1)`, [houseId]);

    await db.exec(MIGRATION_RETIRE);
  });

  it("keeps status and flows unchanged, and does not create an expert for it", async () => {
    const { rows } = await db.query<{ status: string }>(
      `select status from public.tenants where id = $1`,
      [houseId],
    );
    expect(rows[0].status).toBe("active");

    const { rows: sms } = await db.query<{ is_active: boolean }>(
      `select is_active from public.sms_flows where tenant_id = $1`,
      [houseId],
    );
    expect(sms[0].is_active).toBe(true);

    const { rows: experts } = await db.query(
      `select id from public.experts where tenant_id = $1`,
      [DEMO_SOURCE_TENANT],
    );
    expect(experts).toHaveLength(0);
  });
});
