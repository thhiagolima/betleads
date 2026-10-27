// Task 1 — SQL test for
// supabase/migrations/20261101100000_tenant_groups.sql:
// `tenant_groups`, `tenant_group_tenants`, `tenant_group_managers`, their
// demo/immutability guards, and the access helper functions
// (`group_ids_managed_by`, `can_view_group`, `is_group_manager_of_tenant`,
// `group_tenant_ids`) plus RLS on the three tables.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261101100000_tenant_groups.sql"),
  "utf8",
);

const DEMO_TENANT = "00000000-0000-4000-8000-00000000d0d0";
const NORMAL_TENANT_1 = "00000000-0000-4000-8000-00000000a0a1";
const NORMAL_TENANT_2 = "00000000-0000-4000-8000-00000000a0a2";
const NORMAL_TENANT_3 = "00000000-0000-4000-8000-00000000a0a3";

const GROUP_DEMO = "00000000-0000-4000-9000-0000000000d1";
const GROUP_1 = "00000000-0000-4000-9000-0000000000a1";
const GROUP_2 = "00000000-0000-4000-9000-0000000000a2";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000f1";
const MANAGER_G1 = "00000000-0000-4000-8000-0000000000f2";
const MANAGER_G1_G2 = "00000000-0000-4000-8000-0000000000f3";
const STRANGER = "00000000-0000-4000-8000-0000000000f4";
const DEMO_USER = "00000000-0000-4000-8000-0000000000f5";
const NORMAL_USER = "00000000-0000-4000-8000-0000000000f6";

const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    raw_app_meta_data jsonb
  );

  -- Stub matching prod auth.uid(): reads the sub claim from request.jwt.claims.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $$;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    nome text NOT NULL,
    is_demo boolean NOT NULL DEFAULT false
  );

  CREATE TYPE public.app_role AS ENUM ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    tenant_id uuid,
    role public.app_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Stub matching prod is_super_admin: super_admin role with no tenant_id.
  CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = 'super_admin' AND tenant_id IS NULL
    )
  $$;

  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE ON public.tenants TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE ON public.user_roles TO anon, authenticated, service_role;
`;

let db: PGlite;

async function seed() {
  await db.exec(`
    INSERT INTO public.tenants (id, nome, is_demo) VALUES
      ('${DEMO_TENANT}', 'Casa Demo', true),
      ('${NORMAL_TENANT_1}', 'Casa 1', false),
      ('${NORMAL_TENANT_2}', 'Casa 2', false),
      ('${NORMAL_TENANT_3}', 'Casa 3', false);

    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${SUPER_ADMIN}', '{}'::jsonb),
      ('${MANAGER_G1}', '{}'::jsonb),
      ('${MANAGER_G1_G2}', '{}'::jsonb),
      ('${STRANGER}', '{}'::jsonb),
      ('${DEMO_USER}', '{"is_demo_user": true}'::jsonb),
      ('${NORMAL_USER}', '{}'::jsonb);

    INSERT INTO public.user_roles (id, user_id, tenant_id, role) VALUES
      ('00000000-0000-4000-8000-0000000001a1', '${SUPER_ADMIN}', NULL, 'super_admin');

    INSERT INTO public.tenant_groups (id, nome, is_demo) VALUES
      ('${GROUP_DEMO}', 'Grupo Demo', true),
      ('${GROUP_1}', 'Grupo 1', false),
      ('${GROUP_2}', 'Grupo 2', false);

    INSERT INTO public.tenant_group_tenants (group_id, tenant_id) VALUES
      ('${GROUP_1}', '${NORMAL_TENANT_1}'),
      ('${GROUP_2}', '${NORMAL_TENANT_2}');

    INSERT INTO public.tenant_group_managers (group_id, user_id) VALUES
      ('${GROUP_1}', '${MANAGER_G1}'),
      ('${GROUP_1}', '${MANAGER_G1_G2}'),
      ('${GROUP_2}', '${MANAGER_G1_G2}');
  `);
}

/** Runs `sql` inside a rolled-back transaction, impersonating `role` with the
 * given JWT claims (or no claims at all when `claims` is omitted). */
async function asRole(
  role: "postgres" | "anon" | "authenticated" | "service_role",
  claims: Record<string, unknown> | undefined,
  sql: string,
) {
  await db.query("BEGIN");
  try {
    if (claims !== undefined) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
    }
    if (role !== "postgres") {
      await db.exec(`SET LOCAL ROLE ${role}`);
    }
    return await db.query(sql);
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION);
  await seed();
});

afterAll(async () => {
  await db.close();
});

describe("tenant_group_tenants", () => {
  it("a house belongs to at most one group", async () => {
    await expect(
      db.query(
        `insert into public.tenant_group_tenants (group_id, tenant_id)
         values ('${GROUP_2}', '${NORMAL_TENANT_1}')`,
      ),
    ).rejects.toThrow();
  });

  it("demo house cannot join a real group", async () => {
    await expect(
      db.query(
        `insert into public.tenant_group_tenants (group_id, tenant_id)
         values ('${GROUP_1}', '${DEMO_TENANT}')`,
      ),
    ).rejects.toThrow(/GROUP_DEMO_MISMATCH/);
  });

  it("real house cannot join a demo group", async () => {
    await expect(
      db.query(
        `insert into public.tenant_group_tenants (group_id, tenant_id)
         values ('${GROUP_DEMO}', '${NORMAL_TENANT_3}')`,
      ),
    ).rejects.toThrow(/GROUP_DEMO_MISMATCH/);
  });
});

describe("tenant_groups", () => {
  it("group is_demo cannot change", async () => {
    await expect(
      db.query(`update public.tenant_groups set is_demo = true where id = '${GROUP_1}'`),
    ).rejects.toThrow(/GROUP_DEMO_IMMUTABLE/);
  });
});

describe("tenant_group_managers", () => {
  it("demo user can only manage demo groups", async () => {
    await expect(
      db.query(
        `insert into public.tenant_group_managers (group_id, user_id)
         values ('${GROUP_1}', '${DEMO_USER}')`,
      ),
    ).rejects.toThrow(/DEMO_USER_GROUP_VIOLATION/);

    const id = `${DEMO_USER}`;
    await db.query(
      `insert into public.tenant_group_managers (group_id, user_id)
       values ('${GROUP_DEMO}', '${id}')`,
    );
    const { rows } = await db.query(
      `select user_id from public.tenant_group_managers where group_id = '${GROUP_DEMO}' and user_id = '${id}'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("group_ids_managed_by", () => {
  it("manager of G1 gets [G1], manager of G1+G2 gets both, super admin gets all, stranger gets []", async () => {
    const asIds = async (user: string) => {
      const { rows } = await db.query<{ group_ids_managed_by: string }>(
        `select * from public.group_ids_managed_by('${user}')`,
      );
      return rows.map((r) => r.group_ids_managed_by).sort();
    };

    expect(await asIds(MANAGER_G1)).toEqual([GROUP_1]);
    expect(await asIds(MANAGER_G1_G2)).toEqual([GROUP_1, GROUP_2].sort());
    expect(await asIds(SUPER_ADMIN)).toEqual([GROUP_1, GROUP_2, GROUP_DEMO].sort());
    expect(await asIds(STRANGER)).toEqual([]);
  });
});

describe("is_group_manager_of_tenant", () => {
  it("is false for super admin without group role and for houses outside the group", async () => {
    const { rows: superAdminRows } = await db.query<{ v: boolean }>(
      `select public.is_group_manager_of_tenant('${SUPER_ADMIN}', '${NORMAL_TENANT_1}') as v`,
    );
    expect(superAdminRows[0].v).toBe(false);

    const { rows: outsideRows } = await db.query<{ v: boolean }>(
      `select public.is_group_manager_of_tenant('${MANAGER_G1}', '${NORMAL_TENANT_2}') as v`,
    );
    expect(outsideRows[0].v).toBe(false);

    const { rows: insideRows } = await db.query<{ v: boolean }>(
      `select public.is_group_manager_of_tenant('${MANAGER_G1}', '${NORMAL_TENANT_1}') as v`,
    );
    expect(insideRows[0].v).toBe(true);
  });
});

describe("can_view_group", () => {
  it("true for a manager of the group and for super admin, false for a stranger", async () => {
    const { rows: managerRows } = await db.query<{ v: boolean }>(
      `select public.can_view_group('${MANAGER_G1}', '${GROUP_1}') as v`,
    );
    expect(managerRows[0].v).toBe(true);

    const { rows: superAdminRows } = await db.query<{ v: boolean }>(
      `select public.can_view_group('${SUPER_ADMIN}', '${GROUP_1}') as v`,
    );
    expect(superAdminRows[0].v).toBe(true);

    const { rows: strangerRows } = await db.query<{ v: boolean }>(
      `select public.can_view_group('${STRANGER}', '${GROUP_1}') as v`,
    );
    expect(strangerRows[0].v).toBe(false);
  });
});

describe("group_tenant_ids", () => {
  it("returns the tenants belonging to the group", async () => {
    const { rows } = await db.query<{ group_tenant_ids: string }>(
      `select * from public.group_tenant_ids('${GROUP_1}')`,
    );
    expect(rows.map((r) => r.group_tenant_ids)).toEqual([NORMAL_TENANT_1]);
  });
});

describe("RLS", () => {
  it("authenticated sees only own groups via RLS", async () => {
    const { rows } = await asRole(
      "authenticated",
      { sub: MANAGER_G1, role: "authenticated" },
      `select id from public.tenant_groups`,
    );
    expect(rows).toEqual([{ id: GROUP_1 }]);
  });
});

describe("function privileges", () => {
  it("anon cannot execute group_ids_managed_by", async () => {
    await expect(
      asRole("anon", undefined, `select * from public.group_ids_managed_by('${MANAGER_G1}')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("authenticated cannot execute group_tenant_ids", async () => {
    await expect(
      asRole(
        "authenticated",
        { sub: MANAGER_G1, role: "authenticated" },
        `select * from public.group_tenant_ids('${GROUP_1}')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("authenticated cannot execute is_group_manager_of_tenant", async () => {
    await expect(
      asRole(
        "authenticated",
        { sub: MANAGER_G1, role: "authenticated" },
        `select public.is_group_manager_of_tenant('${MANAGER_G1}', '${NORMAL_TENANT_1}')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("anon cannot execute can_view_group", async () => {
    await expect(
      asRole("anon", undefined, `select public.can_view_group('${MANAGER_G1}', '${GROUP_1}')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("service_role can execute group_ids_managed_by", async () => {
    const { rows } = await asRole(
      "service_role",
      undefined,
      `select * from public.group_ids_managed_by('${MANAGER_G1_G2}')`,
    );
    expect(rows).toHaveLength(2);
  });

  it("RLS on tenant_groups still works for an authenticated manager of two groups", async () => {
    const { rows } = await asRole(
      "authenticated",
      { sub: MANAGER_G1_G2, role: "authenticated" },
      `select id from public.tenant_groups order by id`,
    );
    expect(rows).toEqual([{ id: GROUP_1 }, { id: GROUP_2 }]);
  });
});
