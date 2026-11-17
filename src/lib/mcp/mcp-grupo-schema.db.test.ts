// SQL test for supabase/migrations/20261231101400_mcp_grupo_operacao.sql
// (MCP do grupo §4.1, §4.3, §5.6, §7): mcp_access.areas, mcp_call_log
// args/scope, mcp_ops_tenant_ids / mcp_ops_can_view (who sees the operação of
// which house) and mcp_affiliate_metrics. Runs on PGlite over minimal stubs
// of tenants/user_roles/players/deposits/experts plus the real tenant_groups
// and mcp_financeiro migrations.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigration } from "../billing/billing-db-test-support";

const GROUPS = readMigration("supabase/migrations/20261101100000_tenant_groups.sql");
const MCP = readMigration("supabase/migrations/20261128100000_mcp_financeiro.sql");
const MIGRATION = readMigration("supabase/migrations/20261231101400_mcp_grupo_operacao.sql");

const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const DEMO = "00000000-0000-4000-8000-00000000d0d0";
const G1 = "00000000-0000-4000-9000-0000000000a1";

const SUPER = "00000000-0000-4000-8000-0000000000f1";
const MANAGER_G1 = "00000000-0000-4000-8000-0000000000f2";
const ADMIN_C = "00000000-0000-4000-8000-0000000000f3";
const GESTOR_A = "00000000-0000-4000-8000-0000000000f4";
const MEMBER_A = "00000000-0000-4000-8000-0000000000f5";

const EXPERT = "00000000-0000-4000-8000-00000000e001";

const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $$;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    nome text NOT NULL,
    is_demo boolean NOT NULL DEFAULT false
  );

  CREATE TYPE public.app_role AS ENUM ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    tenant_id uuid,
    role public.app_role NOT NULL
  );
  CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = 'super_admin' AND tenant_id IS NULL
    )
  $$;

  CREATE TABLE public.players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    nome text NOT NULL DEFAULT 'x',
    affiliate_id text,
    ftd_em timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.deposits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    player_id uuid REFERENCES public.players(id),
    valor numeric NOT NULL,
    status text NOT NULL DEFAULT 'aprovado',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.experts (id uuid PRIMARY KEY, tenant_id uuid, nome text NOT NULL);
  CREATE TABLE public.expert_affiliates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    expert_id uuid NOT NULL REFERENCES public.experts(id),
    affiliate_id text NOT NULL,
    unique (tenant_id, affiliate_id)
  );

  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`ALTER ROLE service_role BYPASSRLS`);
  await db.exec(GROUPS);
  await db.exec(MCP);
  await db.exec(MIGRATION);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION);

  await db.exec(`
    INSERT INTO public.tenants (id, nome, is_demo) VALUES
      ('${HOUSE_A}', 'Casa A', false),
      ('${HOUSE_B}', 'Casa B', false),
      ('${HOUSE_C}', 'Casa C', false),
      ('${DEMO}', 'Casa Demo', true);
    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${SUPER}', '{}'), ('${MANAGER_G1}', '{}'), ('${ADMIN_C}', '{}'),
      ('${GESTOR_A}', '{}'), ('${MEMBER_A}', '{}');
    INSERT INTO public.user_roles (user_id, tenant_id, role) VALUES
      ('${SUPER}', NULL, 'super_admin'),
      ('${ADMIN_C}', '${HOUSE_C}', 'admin'),
      ('${GESTOR_A}', '${HOUSE_A}', 'gestor'),
      ('${MEMBER_A}', '${HOUSE_A}', 'member');
    INSERT INTO public.tenant_groups (id, nome, is_demo) VALUES ('${G1}', 'Grupo 1', false);
    INSERT INTO public.tenant_group_tenants (group_id, tenant_id) VALUES
      ('${G1}', '${HOUSE_A}'), ('${G1}', '${HOUSE_B}');
    INSERT INTO public.tenant_group_managers (group_id, user_id) VALUES ('${G1}', '${MANAGER_G1}');
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function opsIds(user: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select t as id from public.mcp_ops_tenant_ids($1) t order by 1`,
    [user],
  );
  return rows.map((row) => row.id);
}

async function canView(user: string, tenant: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(`select public.mcp_ops_can_view($1, $2) ok`, [
    user,
    tenant,
  ]);
  return rows[0].ok;
}

describe("mcp_access.areas", () => {
  it("defaults to {financeiro} for a new (or existing) grant", async () => {
    await db.query(`insert into public.mcp_access (user_id, level) values ($1, 'read')`, [SUPER]);
    const { rows } = await db.query<{ areas: string[] }>(
      `select areas from public.mcp_access where user_id = $1`,
      [SUPER],
    );
    expect(rows[0].areas).toEqual(["financeiro"]);
  });

  it("accepts a non-empty subset of {financeiro, operacao}", async () => {
    await db.query(
      `update public.mcp_access set areas = '{operacao,financeiro}' where user_id = $1`,
      [SUPER],
    );
    await db.query(`update public.mcp_access set areas = '{operacao}' where user_id = $1`, [SUPER]);
  });

  it("refuses an empty list or an unknown area", async () => {
    await expect(
      db.query(`update public.mcp_access set areas = '{}' where user_id = $1`, [SUPER]),
    ).rejects.toThrow(/mcp_access_areas_check/);
    await expect(
      db.query(`update public.mcp_access set areas = '{financeiro,marketing}' where user_id = $1`, [
        SUPER,
      ]),
    ).rejects.toThrow(/mcp_access_areas_check/);
  });
});

describe("mcp_call_log args/scope", () => {
  it("stores jsonb args and scope", async () => {
    await db.query(
      `insert into public.mcp_call_log (user_id, tool, ok, duration_ms, args, scope)
       values ($1, 'visao_geral', true, 1, $2, $3)`,
      [
        SUPER,
        JSON.stringify({ escopo: { tipo: "todas" } }),
        JSON.stringify({ tipo: "todas", casas: 3 }),
      ],
    );
    const { rows } = await db.query<{ args: unknown; scope: unknown }>(
      `select args, scope from public.mcp_call_log where tool = 'visao_geral'`,
    );
    expect(rows[0]).toEqual({
      args: { escopo: { tipo: "todas" } },
      scope: { tipo: "todas", casas: 3 },
    });
  });
});

describe("mcp_ops_tenant_ids / mcp_ops_can_view", () => {
  it("super admin sees every house (demo included; the TS layer drops demo from todas)", async () => {
    expect(await opsIds(SUPER)).toEqual([HOUSE_A, HOUSE_B, HOUSE_C, DEMO].sort());
  });

  it("group manager sees the group's houses only", async () => {
    expect(await opsIds(MANAGER_G1)).toEqual([HOUSE_A, HOUSE_B]);
    expect(await canView(MANAGER_G1, HOUSE_C)).toBe(false);
  });

  it("house admin sees their house only", async () => {
    expect(await opsIds(ADMIN_C)).toEqual([HOUSE_C]);
    expect(await canView(ADMIN_C, HOUSE_A)).toBe(false);
    expect(await canView(ADMIN_C, HOUSE_C)).toBe(true);
  });

  it("gestor and member see nothing", async () => {
    expect(await opsIds(GESTOR_A)).toEqual([]);
    expect(await opsIds(MEMBER_A)).toEqual([]);
    expect(await canView(GESTOR_A, HOUSE_A)).toBe(false);
  });

  it("only service_role may execute them", async () => {
    for (const fn of [
      "mcp_ops_tenant_ids(uuid)",
      "mcp_ops_can_view(uuid, uuid)",
      "mcp_affiliate_metrics(uuid[], timestamptz, timestamptz, text)",
    ]) {
      const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', 'public.${fn}', 'execute') anon,
                has_function_privilege('authenticated', 'public.${fn}', 'execute') auth,
                has_function_privilege('service_role', 'public.${fn}', 'execute') svc`,
      );
      expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
    }
  });
});

describe("mcp_affiliate_metrics", () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.experts (id, tenant_id, nome) VALUES ('${EXPERT}', '${HOUSE_A}', 'Queiroz');
      INSERT INTO public.expert_affiliates (tenant_id, expert_id, affiliate_id)
        VALUES ('${HOUSE_A}', '${EXPERT}', 'aff-expert');

      -- aff-expert at house A: 2 players, one registered and FTD in the period.
      INSERT INTO public.players (id, tenant_id, affiliate_id, ftd_em, created_at) VALUES
        ('00000000-0000-4000-8000-0000000a0001', '${HOUSE_A}', 'aff-expert', '2026-10-05T12:00:00Z', '2026-10-05T10:00:00Z'),
        ('00000000-0000-4000-8000-0000000a0002', '${HOUSE_A}', 'aff-expert', NULL, '2026-09-01T10:00:00Z'),
        -- 4512 (no expert) at houses A and B.
        ('00000000-0000-4000-8000-0000000a0003', '${HOUSE_A}', '4512', NULL, '2026-10-10T10:00:00Z'),
        ('00000000-0000-4000-8000-0000000a0004', '${HOUSE_B}', '4512', '2026-10-11T12:00:00Z', '2026-10-11T10:00:00Z'),
        -- No affiliate: never counted.
        ('00000000-0000-4000-8000-0000000a0005', '${HOUSE_A}', NULL, '2026-10-12T12:00:00Z', '2026-10-12T10:00:00Z');

      INSERT INTO public.deposits (tenant_id, player_id, valor, status, created_at) VALUES
        ('${HOUSE_A}', '00000000-0000-4000-8000-0000000a0001', 100, 'aprovado', '2026-10-05T12:00:00Z'),
        ('${HOUSE_A}', '00000000-0000-4000-8000-0000000a0001', 50, 'aprovado', '2026-10-20T12:00:00Z'),
        ('${HOUSE_A}', '00000000-0000-4000-8000-0000000a0001', 999, 'pendente', '2026-10-20T12:00:00Z'),
        ('${HOUSE_A}', '00000000-0000-4000-8000-0000000a0002', 70, 'aprovado', '2026-11-02T12:00:00Z'),
        ('${HOUSE_B}', '00000000-0000-4000-8000-0000000a0004', 30, 'aprovado', '2026-10-11T12:00:00Z'),
        ('${HOUSE_A}', '00000000-0000-4000-8000-0000000a0005', 500, 'aprovado', '2026-10-12T12:00:00Z');
    `);
  });

  type MetricRow = Record<string, unknown>;
  async function metrics(tenants: string[], affiliate: string | null = null) {
    const { rows } = await db.query<MetricRow>(
      `select * from public.mcp_affiliate_metrics($1::uuid[], '2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z', $2)
       order by tenant_id, affiliate_id`,
      [tenants, affiliate],
    );
    return rows.map((row): MetricRow => ({ ...row, depositado: Number(row.depositado) }));
  }

  it("aggregates per (house, affiliate_id), with the linked expert", async () => {
    const rows = await metrics([HOUSE_A, HOUSE_B]);
    expect(rows).toEqual([
      expect.objectContaining({
        tenant_id: HOUSE_A,
        affiliate_id: "4512",
        jogadores_base: 1,
        cadastros: 1,
        ftds: 0,
        depositos: 0,
        depositado: 0,
        depositantes: 0,
        expert_id: null,
        expert_nome: null,
      }),
      expect.objectContaining({
        tenant_id: HOUSE_A,
        affiliate_id: "aff-expert",
        jogadores_base: 2,
        cadastros: 1,
        ftds: 1,
        depositos: 2,
        depositado: 150,
        depositantes: 1,
        expert_id: EXPERT,
        expert_nome: "Queiroz",
      }),
      expect.objectContaining({
        tenant_id: HOUSE_B,
        affiliate_id: "4512",
        jogadores_base: 1,
        cadastros: 1,
        ftds: 1,
        depositos: 1,
        depositado: 30,
        depositantes: 1,
        expert_id: null,
      }),
    ]);
  });

  it("filters by one affiliate_id across houses, even without an expert", async () => {
    const rows = await metrics([HOUSE_A, HOUSE_B], "4512");
    expect(rows.map((row) => [row.tenant_id, row.affiliate_id])).toEqual([
      [HOUSE_A, "4512"],
      [HOUSE_B, "4512"],
    ]);
  });

  it("an unknown id or a house outside _tenants returns nothing", async () => {
    expect(await metrics([HOUSE_A, HOUSE_B], "nao-existe")).toEqual([]);
    expect(await metrics([HOUSE_C])).toEqual([]);
  });
});
