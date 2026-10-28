// Transactional RPC for Task 3 of "Trocar domínio nos links" —
// SQL tests for supabase/migrations/20261103100000_apply_link_domain_change.sql
//
// Runs the migration inside an in-memory Postgres (PGlite) against a minimal
// schema (tenants, journeys, journey_steps, sms_templates, email_templates,
// tenant_quick_links, shortio_settings, tenant_audit_logs) and asserts the
// RPC updates every source atomically, bumps the sms_templates version via
// its trigger, writes the audit log, and rolls back entirely on any
// cross-tenant id.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261103100000_apply_link_domain_change.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Casa'
);

create table public.journeys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'active' check (status in ('draft', 'active', 'paused', 'archived'))
);

create table public.journey_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  content text not null,
  version integer not null default 1,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create function public.bump_sms_template_version_test() returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

create trigger sms_templates_bump_version
  before update on public.sms_templates
  for each row execute function public.bump_sms_template_version_test();

create table public.email_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  subject text not null,
  preheader text,
  body_html text not null,
  body_text text,
  version integer not null default 1,
  lifecycle_status text not null default 'active',
  updated_at timestamptz not null default now()
);

create table public.tenant_quick_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  label text not null,
  path text not null,
  position integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.shortio_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  allowed_destination_hosts text[] not null default '{}'::text[],
  updated_at timestamptz not null default now()
);

create table public.tenant_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
`;

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa Teste')`, [TENANT]);
  await db.query(`insert into public.tenants (id, nome) values ($1, 'Outra Casa')`, [OTHER_TENANT]);
  await db.query(`insert into auth.users (id) values ($1)`, [ACTOR]);
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe("apply_link_domain_change", () => {
  it("atualiza todas as fontes do tenant e grava um audit log", async () => {
    const { rows: journeyRows } = await db.query<{ id: string }>(
      `insert into public.journeys (tenant_id, status) values ($1, 'active') returning id`,
      [TENANT],
    );
    const journeyId = journeyRows[0].id;

    const { rows: stepRows } = await db.query<{ id: string }>(
      `insert into public.journey_steps (tenant_id, journey_id, config)
       values ($1, $2, $3) returning id`,
      [TENANT, journeyId, JSON.stringify({ url: "https://casa-antiga.com/a" })],
    );
    const stepId = stepRows[0].id;

    const { rows: smsRows } = await db.query<{ id: string }>(
      `insert into public.sms_templates (tenant_id, content) values ($1, $2) returning id`,
      [TENANT, "Acesse https://casa-antiga.com"],
    );
    const smsId = smsRows[0].id;

    const { rows: emailRows } = await db.query<{ id: string }>(
      `insert into public.email_templates (tenant_id, subject, body_html, body_text)
       values ($1, 'Assunto', '<a href="https://casa-antiga.com">x</a>', 'https://casa-antiga.com')
       returning id`,
      [TENANT],
    );
    const emailId = emailRows[0].id;

    const { rows: linkRows } = await db.query<{ id: string }>(
      `insert into public.tenant_quick_links (tenant_id, key, label, path)
       values ($1, 'login', 'Login', 'https://casa-antiga.com/login') returning id`,
      [TENANT],
    );
    const linkId = linkRows[0].id;

    await db.query(
      `insert into public.shortio_settings (tenant_id, allowed_destination_hosts) values ($1, $2)`,
      [TENANT, ["casa-antiga.com"]],
    );

    const payload = {
      from: "casa-antiga.com",
      to: "casa-nova.com",
      journey_steps: [{ id: stepId, config: { url: "https://casa-nova.com/a" } }],
      sms_templates: [{ id: smsId, content: "Acesse https://casa-nova.com" }],
      email_templates: [
        {
          id: emailId,
          subject: "Assunto",
          preheader: null,
          body_html: '<a href="https://casa-nova.com">x</a>',
          body_text: "https://casa-nova.com",
        },
      ],
      quick_links: [{ id: linkId, path: "https://casa-nova.com/login" }],
      tracking_hosts: ["casa-antiga.com", "casa-nova.com"],
      audit_before: { from: "casa-antiga.com" },
      audit_after: { to: "casa-nova.com" },
    };

    const { rows } = await db.query<{ apply_link_domain_change: Record<string, unknown> }>(
      `select public.apply_link_domain_change($1, $2, $3) as apply_link_domain_change`,
      [TENANT, ACTOR, JSON.stringify(payload)],
    );

    expect(rows[0].apply_link_domain_change).toEqual({
      journey_steps: 1,
      sms_templates: 1,
      email_templates: 1,
      quick_links: 1,
      tracking_hosts: true,
    });

    const { rows: stepAfter } = await db.query<{ config: { url: string } }>(
      `select config from public.journey_steps where id = $1`,
      [stepId],
    );
    expect(stepAfter[0].config).toEqual({ url: "https://casa-nova.com/a" });

    const { rows: smsAfter } = await db.query<{ content: string; version: number }>(
      `select content, version from public.sms_templates where id = $1`,
      [smsId],
    );
    expect(smsAfter[0].content).toBe("Acesse https://casa-nova.com");
    expect(smsAfter[0].version).toBe(2);

    const { rows: emailAfter } = await db.query<{ body_html: string; body_text: string }>(
      `select body_html, body_text from public.email_templates where id = $1`,
      [emailId],
    );
    expect(emailAfter[0].body_html).toBe('<a href="https://casa-nova.com">x</a>');
    expect(emailAfter[0].body_text).toBe("https://casa-nova.com");

    const { rows: linkAfter } = await db.query<{ path: string }>(
      `select path from public.tenant_quick_links where id = $1`,
      [linkId],
    );
    expect(linkAfter[0].path).toBe("https://casa-nova.com/login");

    const { rows: hostsAfter } = await db.query<{ allowed_destination_hosts: string[] }>(
      `select allowed_destination_hosts from public.shortio_settings where tenant_id = $1`,
      [TENANT],
    );
    expect(hostsAfter[0].allowed_destination_hosts).toEqual(["casa-antiga.com", "casa-nova.com"]);

    const { rows: auditRows } = await db.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
      before_data: Record<string, unknown>;
      after_data: Record<string, unknown>;
    }>(
      `select action, entity_type, entity_id, actor_user_id, metadata, before_data, after_data
       from public.tenant_audit_logs where tenant_id = $1`,
      [TENANT],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "house.link_domain_changed",
      entity_type: "tenant",
      entity_id: TENANT,
      actor_user_id: ACTOR,
      before_data: { from: "casa-antiga.com" },
      after_data: { to: "casa-nova.com" },
    });
    expect(auditRows[0].metadata).toMatchObject({
      from: "casa-antiga.com",
      to: "casa-nova.com",
      counts: { journey_steps: 1, sms_templates: 1, email_templates: 1, quick_links: 1, tracking_hosts: true },
    });
  });

  it("atualiza etapa de jornada ativa no lugar (mesmo id, sem nova jornada)", async () => {
    const { rows: journeyRows } = await db.query<{ id: string }>(
      `insert into public.journeys (tenant_id, status) values ($1, 'active') returning id`,
      [TENANT],
    );
    const journeyId = journeyRows[0].id;
    const { rows: stepRows } = await db.query<{ id: string }>(
      `insert into public.journey_steps (tenant_id, journey_id, config)
       values ($1, $2, $3) returning id`,
      [TENANT, journeyId, JSON.stringify({ url: "https://casa-antiga.com/b" })],
    );
    const stepId = stepRows[0].id;

    const before = await db.query<{ count: string }>(`select count(*) from public.journey_steps`);
    const stepCountBefore = Number(before.rows[0].count);

    const payload = {
      from: "casa-antiga.com",
      to: "casa-nova.com",
      journey_steps: [{ id: stepId, config: { url: "https://casa-nova.com/b" } }],
      sms_templates: [],
      email_templates: [],
      quick_links: [],
      tracking_hosts: null,
      audit_before: {},
      audit_after: {},
    };

    await db.query(`select public.apply_link_domain_change($1, $2, $3)`, [
      TENANT,
      ACTOR,
      JSON.stringify(payload),
    ]);

    const after = await db.query<{ count: string }>(`select count(*) from public.journey_steps`);
    expect(Number(after.rows[0].count)).toBe(stepCountBefore);

    const { rows: stepAfter } = await db.query<{ id: string; config: { url: string } }>(
      `select id, config from public.journey_steps where id = $1`,
      [stepId],
    );
    expect(stepAfter[0].id).toBe(stepId);
    expect(stepAfter[0].config).toEqual({ url: "https://casa-nova.com/b" });
  });

  it("id de outra casa faz a chamada inteira falhar e nada muda", async () => {
    const { rows: journeyRows } = await db.query<{ id: string }>(
      `insert into public.journeys (tenant_id, status) values ($1, 'active') returning id`,
      [TENANT],
    );
    const journeyId = journeyRows[0].id;
    const { rows: stepRows } = await db.query<{ id: string }>(
      `insert into public.journey_steps (tenant_id, journey_id, config)
       values ($1, $2, $3) returning id`,
      [TENANT, journeyId, JSON.stringify({ url: "https://casa-antiga.com/c" })],
    );
    const stepId = stepRows[0].id;

    const { rows: otherSmsRows } = await db.query<{ id: string }>(
      `insert into public.sms_templates (tenant_id, content) values ($1, $2) returning id`,
      [OTHER_TENANT, "Acesse https://casa-antiga.com"],
    );
    const otherSmsId = otherSmsRows[0].id;

    const payload = {
      from: "casa-antiga.com",
      to: "casa-nova.com",
      journey_steps: [{ id: stepId, config: { url: "https://casa-nova.com/c" } }],
      sms_templates: [{ id: otherSmsId, content: "Acesse https://casa-nova.com" }],
      email_templates: [],
      quick_links: [],
      tracking_hosts: null,
      audit_before: {},
      audit_after: {},
    };

    await expect(
      db.query(`select public.apply_link_domain_change($1, $2, $3)`, [
        TENANT,
        ACTOR,
        JSON.stringify(payload),
      ]),
    ).rejects.toThrow(/link_domain_item_not_found/);

    const { rows: stepAfter } = await db.query<{ config: { url: string } }>(
      `select config from public.journey_steps where id = $1`,
      [stepId],
    );
    expect(stepAfter[0].config).toEqual({ url: "https://casa-antiga.com/c" });
  });

  it("tracking_hosts null não mexe em shortio_settings", async () => {
    const tenant = "00000000-0000-4000-8000-000000000003";
    await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa Hosts')`, [tenant]);
    await db.query(
      `insert into public.shortio_settings (tenant_id, allowed_destination_hosts) values ($1, $2)`,
      [tenant, ["original.com"]],
    );

    const payload = {
      from: "casa-antiga.com",
      to: "casa-nova.com",
      journey_steps: [],
      sms_templates: [],
      email_templates: [],
      quick_links: [],
      tracking_hosts: null,
      audit_before: {},
      audit_after: {},
    };

    const { rows } = await db.query<{ apply_link_domain_change: Record<string, unknown> }>(
      `select public.apply_link_domain_change($1, $2, $3) as apply_link_domain_change`,
      [tenant, ACTOR, JSON.stringify(payload)],
    );
    expect(rows[0].apply_link_domain_change).toMatchObject({ tracking_hosts: false });

    const { rows: hostsAfter } = await db.query<{ allowed_destination_hosts: string[] }>(
      `select allowed_destination_hosts from public.shortio_settings where tenant_id = $1`,
      [tenant],
    );
    expect(hostsAfter[0].allowed_destination_hosts).toEqual(["original.com"]);
  });

  it("revoga execução de public/anon/authenticated e concede a service_role", async () => {
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
       from information_schema.routine_privileges
       where routine_name = 'apply_link_domain_change'`,
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).toContain("service_role");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("authenticated");
  });
});
