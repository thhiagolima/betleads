// Task 1 — SQL test for
// supabase/migrations/20261018100000_demo_tenant_flag.sql:
// `tenants.is_demo`, its protection trigger, `is_demo_tenant`/`tenants_demo_ids`,
// and the demo-user role guard on `user_roles`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261018100000_demo_tenant_flag.sql"),
  "utf8",
);

const DEMO_TENANT = "00000000-0000-4000-8000-00000000d0d0";
const NORMAL_TENANT = "00000000-0000-4000-8000-00000000a0a0";
const UNKNOWN_TENANT = "00000000-0000-4000-8000-00000000ffff";

const DEMO_USER = "00000000-0000-4000-8000-0000000000d1";
const NORMAL_USER = "00000000-0000-4000-8000-0000000000a1";

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

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    nome text NOT NULL
  );

  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    tenant_id uuid,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE ON public.tenants TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE ON public.user_roles TO anon, authenticated, service_role;
`;

let db: PGlite;

async function seed() {
  await db.exec(`
    INSERT INTO public.tenants (id, nome) VALUES
      ('${DEMO_TENANT}', 'Casa Demo'),
      ('${NORMAL_TENANT}', 'Casa Normal');
    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${DEMO_USER}', '{"is_demo_user": true}'::jsonb),
      ('${NORMAL_USER}', '{}'::jsonb);
  `);
  // is_demo starts false; flip the demo tenant on as the migration-equivalent
  // service_role connection (no claims, current_user = postgres) would.
  await db.exec(`UPDATE public.tenants SET is_demo = true WHERE id = '${DEMO_TENANT}'`);
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

describe("is_demo_tenant", () => {
  it("is true for a tenant with is_demo = true", async () => {
    const { rows } = await db.query<{ v: boolean }>(
      `select public.is_demo_tenant('${DEMO_TENANT}') as v`,
    );
    expect(rows[0].v).toBe(true);
  });

  it("is false for a normal tenant", async () => {
    const { rows } = await db.query<{ v: boolean }>(
      `select public.is_demo_tenant('${NORMAL_TENANT}') as v`,
    );
    expect(rows[0].v).toBe(false);
  });

  it("is false for an unknown tenant id", async () => {
    const { rows } = await db.query<{ v: boolean }>(
      `select public.is_demo_tenant('${UNKNOWN_TENANT}') as v`,
    );
    expect(rows[0].v).toBe(false);
  });

  it("is false for a null tenant id", async () => {
    const { rows } = await db.query<{ v: boolean }>(`select public.is_demo_tenant(null) as v`);
    expect(rows[0].v).toBe(false);
  });
});

describe("tenants_demo_ids", () => {
  it("returns only demo tenant ids", async () => {
    const { rows } = await db.query<{ id: string }>(
      `select tenants_demo_ids() as id`,
    );
    expect(rows.map((r) => r.id)).toEqual([DEMO_TENANT]);
  });
});

describe("trg_tenants_protect_is_demo", () => {
  it("blocks authenticated (via JWT claims) from flipping is_demo", async () => {
    await expect(
      asRole(
        "authenticated",
        { role: "authenticated" },
        `update public.tenants set is_demo = true where id = '${NORMAL_TENANT}'`,
      ),
    ).rejects.toThrow(/DEMO_FLAG_PROTECTED/);
  });

  it("allows service_role (via JWT claims) to flip is_demo", async () => {
    await expect(
      asRole(
        "service_role",
        { role: "service_role" },
        `update public.tenants set is_demo = true where id = '${NORMAL_TENANT}'`,
      ),
    ).resolves.toBeDefined();
  });

  it("allows a superuser/migration connection with no JWT claims at all", async () => {
    await expect(
      asRole(
        "postgres",
        undefined,
        `update public.tenants set is_demo = true where id = '${NORMAL_TENANT}'`,
      ),
    ).resolves.toBeDefined();
  });

  it("blocks role=authenticated with no JWT claims (PostgREST-style)", async () => {
    await expect(
      asRole(
        "authenticated",
        undefined,
        `update public.tenants set is_demo = true where id = '${NORMAL_TENANT}'`,
      ),
    ).rejects.toThrow(/DEMO_FLAG_PROTECTED/);
  });

  it("does not fire when is_demo is not actually changing", async () => {
    await expect(
      asRole(
        "authenticated",
        { role: "authenticated" },
        `update public.tenants set is_demo = false where id = '${NORMAL_TENANT}'`,
      ),
    ).resolves.toBeDefined();
  });
});

describe("trg_user_roles_demo_user_guard", () => {
  it("blocks a demo user assigned to a normal tenant", async () => {
    await expect(
      db.query(
        `insert into public.user_roles (id, user_id, tenant_id, role)
         values ('00000000-0000-4000-8000-0000000000e3', '${DEMO_USER}', '${NORMAL_TENANT}', 'gestor')`,
      ),
    ).rejects.toThrow(/DEMO_USER_ROLE_BLOCKED/);
  });

  it("blocks a demo user with role admin even in the demo tenant", async () => {
    await expect(
      db.query(
        `insert into public.user_roles (id, user_id, tenant_id, role)
         values ('00000000-0000-4000-8000-0000000000e4', '${DEMO_USER}', '${DEMO_TENANT}', 'admin')`,
      ),
    ).rejects.toThrow(/DEMO_USER_ROLE_BLOCKED/);
  });

  it("allows a demo user with role gestor in the demo tenant", async () => {
    const id = "00000000-0000-4000-8000-0000000000e1";
    await db.query(
      `insert into public.user_roles (id, user_id, tenant_id, role)
       values ('${id}', '${DEMO_USER}', '${DEMO_TENANT}', 'gestor')`,
    );
    const { rows } = await db.query(`select role from public.user_roles where id = '${id}'`);
    expect(rows[0]).toEqual({ role: "gestor" });
  });

  it("does not affect a normal user", async () => {
    const id = "00000000-0000-4000-8000-0000000000e2";
    await db.query(
      `insert into public.user_roles (id, user_id, tenant_id, role)
       values ('${id}', '${NORMAL_USER}', '${NORMAL_TENANT}', 'admin')`,
    );
    const { rows } = await db.query(`select role from public.user_roles where id = '${id}'`);
    expect(rows[0]).toEqual({ role: "admin" });
  });
});
