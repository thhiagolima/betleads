// link_dispatches / tracked_links read-only for logged-in users — SQL tests
// for the link_tables_read_only section of
// supabase/migrations/20261125100000_expert_hardening.sql.
//
// Starts from the production FOR ALL policies of
// 20261015090000_consolidate_tenant_rls.sql (any member of the house could
// insert/update/delete dispatches over PostgREST, e.g. forge a click credit)
// and asserts that after the section a member still reads its house's rows
// but can no longer write them; service_role (every writer in the app) is
// unaffected.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPERT_HARDENING, migrationSection } from "./migration-section.test-support";

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const MEMBER_A = "00000000-0000-4000-8000-0000000000a1";

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create table public.tenants (id uuid primary key);
create table public.memberships (user_id uuid, tenant_id uuid);
create function public.is_super_admin() returns boolean language sql stable as $$ select false $$;
create function public.accessible_tenant_ids() returns uuid[] language sql stable security definer as $$
  select coalesce(array_agg(tenant_id), '{}') from public.memberships where user_id = auth.uid()
$$;

create table public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  short_url text
);
create table public.link_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  tracked_link_id uuid references public.tracked_links(id),
  source_type text,
  recipient_player_id uuid
);
alter table public.tracked_links enable row level security;
alter table public.link_dispatches enable row level security;

-- 20261015090000_consolidate_tenant_rls.sql (literal)
CREATE POLICY link_dispatches_tenant_rls ON public.link_dispatches
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));
CREATE POLICY tracked_links_tenant_rls ON public.tracked_links
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

grant usage on schema public, auth to anon, authenticated, service_role;
grant all on public.tracked_links, public.link_dispatches to anon, authenticated, service_role;
grant select on public.tenants, public.memberships to anon, authenticated, service_role;
`;

let db: PGlite;
let linkA: string;
let dispatchA: string;

async function as<T>(role: string, uid: string | null, sql: string): Promise<T[]> {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('test.uid', $1, true)`, [uid ?? ""]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    const { rows } = await db.query<T>(sql);
    return rows;
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.query(`insert into public.tenants values ($1), ($2)`, [TENANT_A, TENANT_B]);
  await db.query(`insert into public.memberships values ($1, $2)`, [MEMBER_A, TENANT_A]);
  const { rows: links } = await db.query<{ id: string }>(
    `insert into public.tracked_links (tenant_id) values ($1), ($2) returning id`,
    [TENANT_A, TENANT_B],
  );
  linkA = links[0].id;
  const { rows: dispatches } = await db.query<{ id: string }>(
    `insert into public.link_dispatches (tenant_id, tracked_link_id, source_type)
     values ($1, $2, 'campaign'), ($3, $4, 'campaign') returning id`,
    [TENANT_A, linkA, TENANT_B, links[1].id],
  );
  dispatchA = dispatches[0].id;

  // Before the section a member can forge a dispatch of its house.
  expect(
    await as(
      "authenticated",
      MEMBER_A,
      `insert into public.link_dispatches (tenant_id, source_type) values ('${TENANT_A}', 'expert') returning id`,
    ),
  ).toHaveLength(1);

  await db.exec(migrationSection(EXPERT_HARDENING, "link_tables_read_only"));
  // Idempotent.
  await db.exec(migrationSection(EXPERT_HARDENING, "link_tables_read_only"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("link tables are read-only for authenticated", () => {
  it("a member still reads only its house's rows", async () => {
    for (const table of ["link_dispatches", "tracked_links"]) {
      const rows = await as<{ tenant_id: string }>(
        "authenticated",
        MEMBER_A,
        `select tenant_id from public.${table}`,
      );
      expect(rows).toEqual([{ tenant_id: TENANT_A }]);
    }
  });

  it("a member can no longer insert, update or delete", async () => {
    const writes = [
      `insert into public.link_dispatches (tenant_id, source_type) values ('${TENANT_A}', 'expert')`,
      `update public.link_dispatches set recipient_player_id = gen_random_uuid() where id = '${dispatchA}'`,
      `delete from public.link_dispatches where id = '${dispatchA}'`,
      `insert into public.tracked_links (tenant_id) values ('${TENANT_A}')`,
      `update public.tracked_links set short_url = 'https://evil' where id = '${linkA}'`,
      `delete from public.tracked_links where id = '${linkA}'`,
    ];
    for (const sql of writes) {
      await expect(as("authenticated", MEMBER_A, sql), sql).rejects.toThrow(/permission denied/);
      await expect(as("anon", null, sql), sql).rejects.toThrow(/permission denied/);
    }
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.link_dispatches where id = $1 and recipient_player_id is null`,
      [dispatchA],
    );
    expect(rows[0].n).toBe(1);
  });

  it("the only policy left on each table is SELECT", async () => {
    const { rows } = await db.query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies
       where tablename in ('link_dispatches', 'tracked_links') order by tablename`,
    );
    expect(rows).toEqual([
      { tablename: "link_dispatches", policyname: "link_dispatches_tenant_select", cmd: "SELECT" },
      { tablename: "tracked_links", policyname: "tracked_links_tenant_select", cmd: "SELECT" },
    ]);
  });

  it("service_role keeps writing", async () => {
    const rows = await as<{ id: string }>(
      "service_role",
      null,
      `update public.link_dispatches set source_type = 'campaign' where id = '${dispatchA}' returning id`,
    );
    expect(rows).toEqual([{ id: dispatchA }]);
  });
});
