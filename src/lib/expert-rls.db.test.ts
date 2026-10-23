// Expert RLS — SQL tests for
// supabase/migrations/20261025100200_expert_rls.sql
//
// Runs the expert migrations (Tasks 1 and 2) inside an in-memory Postgres
// (PGlite) on top of a schema that copies the production tenant helpers
// literally and mirrors the production policies of players, deposits,
// withdrawals and one representative house table (sms_campaigns). Each
// persona query runs as `authenticated` with a simulated Supabase JWT
// (request.jwt.claims) and optional X-Active-Tenant header
// (request.headers), and asserts that an expert sees only the players its
// type allows — and nothing else of the house.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const migration = (file: string) =>
  readFileSync(resolve(root, "supabase/migrations", file), "utf8");
const MIGRATION_ROLE = migration("20261025100000_add_expert_app_role.sql");
const MIGRATION_MODEL = migration("20261025100100_expert_model.sql");
const MIGRATION_RLS = migration("20261025100200_expert_rls.sql");

// Guide: the four tenant helpers below are copied literally from their
// newest production definitions, so these tests prove the `expert` role
// stays outside house membership without any change to them:
//   * is_super_admin       — 20260609200834_8b7989c6-004f-45db-bf6c-7416d26842ee.sql
//   * has_tenant_access    — 20261003093000_tenant_admin_gestor_model.sql
//   * current_tenant_id    — 20261003100000_active_tenant_request_context.sql
//   * accessible_tenant_ids — 20261015090000_consolidate_tenant_rls.sql
//     (which also pins search_path = public, pg_temp on the other three)
// The players/deposits/withdrawals/experts policies are the production ones
// from 20261015090000_consolidate_tenant_rls.sql and
// 20261015100000_fix_rls_privilege_escalation.sql.
const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (
  id uuid primary key
);

-- Same contract as Supabase's auth.uid(): the JWT sub claim.
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
  role public.app_role not null,
  created_at timestamptz not null default now()
);

alter table public.user_roles
  add constraint user_roles_canonical_scope
  check (
    (role = 'super_admin' and tenant_id is null)
    or (role in ('admin', 'gestor', 'member') and tenant_id is not null)
  ) not valid;

-- 20260609200834_8b7989c6-004f-45db-bf6c-7416d26842ee.sql (literal)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'super_admin'
      AND tenant_id IS NULL
  )
$function$;

-- 20261003093000_tenant_admin_gestor_model.sql (literal)
CREATE OR REPLACE FUNCTION public.has_tenant_access(_tenant_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin(_user_id) OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant_id
      AND role IN ('admin', 'gestor', 'member')
  )
$$;

-- 20261003100000_active_tenant_request_context.sql (literal)
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
  WHERE user_id = v_uid
    AND tenant_id IS NOT NULL
    AND role IN ('admin', 'gestor', 'member')
  ORDER BY tenant_id
  LIMIT 1;
  RETURN v_tenant;
END;
$$;

-- 20261015090000_consolidate_tenant_rls.sql (literal)
CREATE OR REPLACE FUNCTION public.accessible_tenant_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Same membership rule as has_tenant_access(): admin/gestor/member of the tenant.
  SELECT coalesce(array_agg(DISTINCT ur.tenant_id), '{}'::uuid[])
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.tenant_id IS NOT NULL
    AND ur.role IN ('admin', 'gestor', 'member')
$$;

REVOKE ALL ON FUNCTION public.accessible_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accessible_tenant_ids() TO authenticated, service_role;

ALTER FUNCTION public.current_tenant_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.is_super_admin(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.has_tenant_access(uuid, uuid) SET search_path = public, pg_temp;

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  affiliate_id text,
  expert text,
  ftd_em timestamptz
);
-- Prod-equivalent tenant_id-leading index (20260610212336_af971463-…).
CREATE INDEX players_tenant_ftd_idx ON public.players (tenant_id, ftd_em);
alter table public.players enable row level security;
CREATE POLICY players_tenant_rls ON public.players
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- Prod-equivalent index (20260610212336_af971463-…).
CREATE INDEX deposits_tenant_player_created_idx ON public.deposits (tenant_id, player_id, created_at DESC);
alter table public.deposits enable row level security;
CREATE POLICY deposits_tenant_select ON public.deposits
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY deposits_super_admin_write ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- Prod-equivalent index (20261002170000_optimize_analytics_queries.sql).
CREATE INDEX withdrawals_tenant_player_created_idx ON public.withdrawals (tenant_id, player_id, created_at desc);
alter table public.withdrawals enable row level security;
CREATE POLICY withdrawals_tenant_select ON public.withdrawals
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY withdrawals_super_admin_write ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- A representative house table (SA_OR_CUR rule).
create table public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
);
alter table public.sms_campaigns enable row level security;
CREATE POLICY sms_campaigns_tenant_rls ON public.sms_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

-- Legacy shape, as it exists in production before the Task 1 migration.
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id text not null unique,
  nome text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.experts enable row level security;
CREATE POLICY experts_tenant_rls ON public.experts
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant select, insert, update, delete on public.tenants to anon, authenticated, service_role;
grant select, insert, update, delete on public.user_roles to anon, authenticated, service_role;
grant select, insert, update, delete on public.players to anon, authenticated, service_role;
grant select, insert, update, delete on public.deposits to anon, authenticated, service_role;
grant select, insert, update, delete on public.withdrawals to anon, authenticated, service_role;
grant select, insert, update, delete on public.sms_campaigns to anon, authenticated, service_role;
grant select, insert, update, delete on public.experts to anon, authenticated, service_role;

-- Emulates Supabase's real default: every table created from here on
-- (expert_affiliates) grants authenticated full CRUD unless a migration
-- revokes it explicitly, same as production.
alter default privileges in schema public grant all on tables to authenticated;
`;

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

const ADMIN_A = "00000000-0000-4000-8000-0000000000a1";
const RESTRITO_A = "00000000-0000-4000-8000-0000000000e1";
const TOTAL_A = "00000000-0000-4000-8000-0000000000e2";
const RESTRITO_VAZIO_A = "00000000-0000-4000-8000-0000000000e3";
const INATIVO_A = "00000000-0000-4000-8000-0000000000e4";
const INATIVO_TOTAL_A = "00000000-0000-4000-8000-0000000000e5";
// Active experts row linked to the user, but no user_roles 'expert' row.
const SEM_ROLE_A = "00000000-0000-4000-8000-0000000000e6";
// user_roles 'expert' row, but no experts row linked to the user.
const SEM_VINCULO_A = "00000000-0000-4000-8000-0000000000e7";
// Total expert of both house A and house B.
const DUAS_CASAS = "00000000-0000-4000-8000-0000000000e8";

let db: PGlite;
let playerAff1A: string;
let playerAff1B: string;

type Row = Record<string, unknown>;

// Runs `sql` as `authenticated` with the given user's JWT and, optionally,
// an X-Active-Tenant header, then rolls back.
async function asUser<T extends Row>(
  userId: string,
  sql: string,
  opts: { activeTenant?: string } = {},
): Promise<T[]> {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await db.query(`select set_config('request.headers', $1, true)`, [
      JSON.stringify(opts.activeTenant ? { "x-active-tenant": opts.activeTenant } : {}),
    ]);
    await db.exec("SET LOCAL ROLE authenticated");
    const { rows } = await db.query<T>(sql);
    return rows;
  } finally {
    await db.query("ROLLBACK");
  }
}

async function addExpert(
  userId: string,
  nome: string,
  tipo: "restrito" | "total",
  ativo: boolean,
  affiliateIds: string[],
  opts: { tenant?: string; withRole?: boolean; linkUser?: boolean; newUser?: boolean } = {},
) {
  const { tenant = TENANT_A, withRole = true, linkUser = true, newUser = true } = opts;
  if (newUser) await db.query(`insert into auth.users (id) values ($1)`, [userId]);
  if (withRole) {
    await db.query(
      `insert into public.user_roles (user_id, tenant_id, role) values ($1, $2, 'expert')`,
      [userId, tenant],
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into public.experts (tenant_id, nome, user_id, tipo, ativo)
     values ($1, $2, $3, $4, $5) returning id`,
    [tenant, nome, linkUser ? userId : null, tipo, ativo],
  );
  for (const affiliateId of affiliateIds) {
    await db.query(
      `insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id) values ($1, $2, $3)`,
      [tenant, rows[0].id, affiliateId],
    );
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION_ROLE);
  await db.exec(MIGRATION_MODEL);
  await db.exec(MIGRATION_RLS);

  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa A'), ($2, 'Casa B')`, [
    TENANT_A,
    TENANT_B,
  ]);

  await db.query(`insert into auth.users (id) values ($1)`, [ADMIN_A]);
  await db.query(
    `insert into public.user_roles (user_id, tenant_id, role) values ($1, $2, 'admin')`,
    [ADMIN_A, TENANT_A],
  );

  // An affiliate id belongs to one expert per house (unique (tenant_id,
  // affiliate_id)), so the deactivated restricted expert owns AFF2, which
  // would otherwise make it see exactly one player.
  await addExpert(RESTRITO_A, "Restrito", "restrito", true, ["AFF1"]);
  await addExpert(TOTAL_A, "Total", "total", true, []);
  await addExpert(RESTRITO_VAZIO_A, "Restrito Vazio", "restrito", true, []);
  await addExpert(INATIVO_A, "Inativo", "restrito", false, ["AFF2"]);
  await addExpert(INATIVO_TOTAL_A, "Inativo Total", "total", false, []);
  await addExpert(SEM_ROLE_A, "Sem Papel", "total", true, [], { withRole: false });
  await addExpert(SEM_VINCULO_A, "Sem Vinculo", "total", true, [], { linkUser: false });
  await addExpert(DUAS_CASAS, "Duas Casas A", "total", true, []);
  await addExpert(DUAS_CASAS, "Duas Casas B", "total", true, [], {
    tenant: TENANT_B,
    newUser: false,
  });

  const { rows: playersA } = await db.query<{ id: string; affiliate_id: string | null }>(
    `insert into public.players (tenant_id, affiliate_id) values ($1, 'AFF1'), ($1, 'AFF2'), ($1, null)
     returning id, affiliate_id`,
    [TENANT_A],
  );
  playerAff1A = playersA.find((p) => p.affiliate_id === "AFF1")!.id;
  const { rows: playersB } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id, affiliate_id) values ($1, 'AFF1') returning id`,
    [TENANT_B],
  );
  playerAff1B = playersB[0].id;

  for (const p of playersA) {
    await db.query(`insert into public.deposits (tenant_id, player_id) values ($1, $2)`, [
      TENANT_A,
      p.id,
    ]);
    await db.query(`insert into public.withdrawals (tenant_id, player_id) values ($1, $2)`, [
      TENANT_A,
      p.id,
    ]);
  }
  await db.query(`insert into public.deposits (tenant_id, player_id) values ($1, $2)`, [
    TENANT_B,
    playersB[0].id,
  ]);
  await db.query(`insert into public.withdrawals (tenant_id, player_id) values ($1, $2)`, [
    TENANT_B,
    playersB[0].id,
  ]);
  await db.query(`insert into public.sms_campaigns (tenant_id) values ($1), ($2)`, [
    TENANT_A,
    TENANT_B,
  ]);
});

afterAll(async () => {
  await db.close();
});

describe("expert RLS", () => {
  it("restricted expert sees only players of own affiliate ids", async () => {
    const players = await asUser<{ id: string; tenant_id: string }>(
      RESTRITO_A,
      `select id, tenant_id from public.players`,
    );
    expect(players).toEqual([{ id: playerAff1A, tenant_id: TENANT_A }]);

    const deposits = await asUser<{ player_id: string }>(
      RESTRITO_A,
      `select player_id from public.deposits`,
    );
    expect(deposits).toEqual([{ player_id: playerAff1A }]);

    const withdrawals = await asUser<{ player_id: string }>(
      RESTRITO_A,
      `select player_id from public.withdrawals`,
    );
    expect(withdrawals).toEqual([{ player_id: playerAff1A }]);
  });

  it("total expert sees all players of the house and none of other houses", async () => {
    const players = await asUser<{ tenant_id: string }>(
      TOTAL_A,
      `select tenant_id from public.players`,
    );
    expect(players).toHaveLength(3);
    expect(players.every((p) => p.tenant_id === TENANT_A)).toBe(true);

    // Same result with its own house as the active tenant.
    const withHeader = await asUser(TOTAL_A, `select id from public.players`, {
      activeTenant: TENANT_A,
    });
    expect(withHeader).toHaveLength(3);

    const deposits = await asUser<{ tenant_id: string }>(
      TOTAL_A,
      `select tenant_id from public.deposits`,
    );
    expect(deposits).toHaveLength(3);
    expect(deposits.every((d) => d.tenant_id === TENANT_A)).toBe(true);
  });

  it("restricted expert without ids sees no players", async () => {
    expect(await asUser(RESTRITO_VAZIO_A, `select id from public.players`)).toHaveLength(0);
    expect(await asUser(RESTRITO_VAZIO_A, `select id from public.deposits`)).toHaveLength(0);
  });

  it("deactivated expert sees nothing", async () => {
    for (const user of [INATIVO_A, INATIVO_TOTAL_A]) {
      expect(await asUser(user, `select id from public.players`)).toHaveLength(0);
      expect(await asUser(user, `select id from public.deposits`)).toHaveLength(0);
      expect(await asUser(user, `select id from public.withdrawals`)).toHaveLength(0);
      expect(await asUser(user, `select id from public.expert_affiliates`)).toHaveLength(
        user === INATIVO_A ? 1 : 0,
      );
    }
  });

  it("expert is outside house membership", async () => {
    const [helpers] = await asUser<{
      current_tenant: string | null;
      has_access: boolean;
      accessible: string[];
    }>(
      TOTAL_A,
      `select public.current_tenant_id() as current_tenant,
              public.has_tenant_access('${TENANT_A}') as has_access,
              public.accessible_tenant_ids() as accessible`,
    );
    expect(helpers).toEqual({ current_tenant: null, has_access: false, accessible: [] });

    expect(await asUser(TOTAL_A, `select id from public.sms_campaigns`)).toHaveLength(0);
    expect(
      await asUser(TOTAL_A, `select id from public.sms_campaigns`, { activeTenant: TENANT_A }),
    ).toHaveLength(0);
  });

  it("expert with x-active-tenant of another house sees nothing", async () => {
    expect(
      await asUser(TOTAL_A, `select id from public.players`, { activeTenant: TENANT_B }),
    ).toHaveLength(0);
    expect(
      await asUser(TOTAL_A, `select id from public.deposits`, { activeTenant: TENANT_B }),
    ).toHaveLength(0);
  });

  it("admin of the house still sees all players", async () => {
    const players = await asUser<{ tenant_id: string }>(
      ADMIN_A,
      `select tenant_id from public.players`,
    );
    expect(players).toHaveLength(3);
    expect(players.every((p) => p.tenant_id === TENANT_A)).toBe(true);
    expect(await asUser(ADMIN_A, `select id from public.deposits`)).toHaveLength(3);
    // Every experts row of house A (DUAS_CASAS also has one in house B).
    expect(await asUser(ADMIN_A, `select id from public.experts`)).toHaveLength(8);
  });

  it("expert sees own experts row only", async () => {
    const experts = await asUser<{ user_id: string }>(
      RESTRITO_A,
      `select user_id from public.experts`,
    );
    expect(experts).toEqual([{ user_id: RESTRITO_A }]);

    const affiliates = await asUser<{ affiliate_id: string }>(
      RESTRITO_A,
      `select affiliate_id from public.expert_affiliates`,
    );
    expect(affiliates).toEqual([{ affiliate_id: "AFF1" }]);
  });

  it("expert without the user_roles expert row sees nothing", async () => {
    expect(await asUser(SEM_ROLE_A, `select id from public.players`)).toHaveLength(0);
    expect(await asUser(SEM_ROLE_A, `select id from public.deposits`)).toHaveLength(0);
  });

  it("expert role without a linked experts row sees nothing", async () => {
    expect(await asUser(SEM_VINCULO_A, `select id from public.players`)).toHaveLength(0);
    expect(await asUser(SEM_VINCULO_A, `select id from public.deposits`)).toHaveLength(0);
  });

  it("expert of two houses sees the first house by default and the header house otherwise", async () => {
    // TENANT_A < TENANT_B, so without a header the active house is A.
    const noHeader = await asUser<{ tenant_id: string }>(
      DUAS_CASAS,
      `select tenant_id from public.players`,
    );
    expect(noHeader).toHaveLength(3);
    expect(noHeader.every((p) => p.tenant_id === TENANT_A)).toBe(true);

    const headerB = await asUser<{ id: string }>(DUAS_CASAS, `select id from public.players`, {
      activeTenant: TENANT_B,
    });
    expect(headerB).toEqual([{ id: playerAff1B }]);
  });

  it("expert cannot write players, deposits or withdrawals", async () => {
    await expect(
      asUser(
        TOTAL_A,
        `insert into public.players (tenant_id, affiliate_id) values ('${TENANT_A}', 'AFFW')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(
        TOTAL_A,
        `insert into public.deposits (tenant_id, player_id) values ('${TENANT_A}', '${playerAff1A}')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(
        TOTAL_A,
        `insert into public.withdrawals (tenant_id, player_id) values ('${TENANT_A}', '${playerAff1A}')`,
      ),
    ).rejects.toThrow(/row-level security/);

    // No UPDATE policy admits an expert, so Postgres silently matches no
    // rows (no error): assert nothing was touched.
    const updated = await asUser<{ id: string }>(
      TOTAL_A,
      `update public.players set expert = 'Hack' where id = '${playerAff1A}' returning id`,
    );
    expect(updated).toHaveLength(0);
    const { rows } = await db.query<{ expert: string | null }>(
      `select expert from public.players where id = $1`,
      [playerAff1A],
    );
    expect(rows[0].expert).toBeNull();
  });

  it("expert policies keep the tenant_id index usable for non-experts", async () => {
    // Measured in PGlite (20 extra houses x 500 players, ANALYZE, as admin_A),
    // EXPLAIN ANALYZE of `select * from players where tenant_id = A`, the
    // shape every app query has:
    //   Index Scan using players_tenant_ftd_idx on players
    //     Index Cond: (tenant_id = A)
    //     Filter: ((InitPlan 1) OR (tenant_id = (InitPlan 2)) OR
    //              ((tenant_id = (InitPlan 3)) AND ((InitPlan 4) IS NOT NULL)
    //               AND expert_can_see_player(tenant_id, affiliate_id)))
    //     InitPlan 3 / InitPlan 4 (current_expert_tenant_id): never executed
    // Same plan and cost as with no expert policy at all. Note that an
    // unfiltered `select * from players` is a Seq Scan even WITHOUT any expert
    // policy: players_tenant_rls's own `(select is_super_admin()) OR …` arm
    // cannot drive an index, so that case is not asserted here.
    await db.exec(`
      insert into public.tenants (id, nome)
        select ('00000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'Casa ' || g
        from generate_series(1, 20) g;
      insert into public.players (tenant_id, affiliate_id)
        select ('00000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'X' || (n % 7)
        from generate_series(1, 20) g, generate_series(1, 500) n;
      analyze public.players;
    `);
    const plan = await asUser<{ "QUERY PLAN": string }>(
      ADMIN_A,
      `explain select * from public.players where tenant_id = '${TENANT_A}'`,
    );
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).not.toContain("Seq Scan on players");
    expect(text).toMatch(
      /Index Scan using players_tenant_ftd_idx|Bitmap Index Scan on players_tenant_ftd_idx/,
    );

    // Still only house A's three players for the admin.
    expect(await asUser(ADMIN_A, `select id from public.players`)).toHaveLength(3);
  });
});
