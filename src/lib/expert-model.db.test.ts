// Expert data model — SQL tests for
// supabase/migrations/20261025100000_add_expert_app_role.sql and
// supabase/migrations/20261025100100_expert_model.sql
//
// Runs both migrations inside an in-memory Postgres (PGlite) against a
// minimal schema (app_role, user_roles, tenants, players, the legacy
// experts table) and asserts: the `expert` app_role + user_roles CHECK, the
// backfill of legacy experts rows into per-house expert_affiliates, and the
// save_expert / delete_expert / tenant_unassigned_affiliate_ids functions.

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

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  affiliate_id text,
  expert text
);

-- Legacy shape, as it exists in production before this migration.
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id text not null unique,
  nome text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);
grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant select, insert, update, delete on public.tenants to anon, authenticated, service_role;
grant select, insert, update, delete on public.user_roles to anon, authenticated, service_role;
grant select, insert, update, delete on public.players to anon, authenticated, service_role;
grant select, insert, update, delete on public.experts to anon, authenticated, service_role;

-- Emulates Supabase's real default: every table created from here on
-- (expert_affiliates, created by the migration below) grants authenticated
-- full CRUD unless a migration revokes it explicitly, same as production
-- (see 20261015100000_fix_rls_privilege_escalation.sql, which only strips
-- the default grants for anon and TRUNCATE for authenticated).
alter default privileges in schema public grant all on tables to authenticated;
`;

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;

let queiroz1Id: string;
let queiroz2Id: string;
let andradeId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);

  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa A'), ($2, 'Casa B')`, [
    TENANT_A,
    TENANT_B,
  ]);

  // Legacy experts seeded in house A, as production has them today: two
  // Queiroz rows (one per affiliate id) and one Andrade row.
  const { rows: seeded } = await db.query<{ id: string; nome: string; affiliate_id: string }>(
    `insert into public.experts (tenant_id, nome, affiliate_id) values
       ($1, 'Queiroz', 'AFF1'),
       ($1, 'Queiroz', 'AFF2'),
       ($1, 'Andrade', 'AFF3')
     returning id, nome, affiliate_id`,
    [TENANT_A],
  );
  queiroz1Id = seeded.find((r) => r.affiliate_id === "AFF1")!.id;
  queiroz2Id = seeded.find((r) => r.affiliate_id === "AFF2")!.id;
  andradeId = seeded.find((r) => r.affiliate_id === "AFF3")!.id;

  // Players whose affiliate_id will be relabeled by the backfill/functions.
  await db.query(
    `insert into public.players (tenant_id, affiliate_id) values
       ($1, 'AFF1'), ($1, 'AFF2'), ($1, 'AFF3'), ($2, 'AFF1')`,
    [TENANT_A, TENANT_B],
  );

  await db.exec(MIGRATION_ROLE);
  await db.exec(MIGRATION_MODEL);
});

afterAll(async () => {
  await db.close();
});

describe("backfill of legacy experts rows", () => {
  it("merges legacy rows per name into one expert with all affiliate ids", async () => {
    const { rows } = await db.query<{ id: string; nome: string; affiliate_id: string | null }>(
      `select id, nome, affiliate_id from public.experts where tenant_id = $1 order by nome`,
      [TENANT_A],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.affiliate_id === null)).toBe(true);
    expect(rows.map((r) => r.nome).sort()).toEqual(["Andrade", "Queiroz"]);

    const queiroz = rows.find((r) => r.nome === "Queiroz")!;
    const { rows: affiliates } = await db.query<{ affiliate_id: string }>(
      `select affiliate_id from public.expert_affiliates where expert_id = $1 order by affiliate_id`,
      [queiroz.id],
    );
    expect(affiliates.map((a) => a.affiliate_id)).toEqual(["AFF1", "AFF2"]);
  });

  it("keeps the canonical row as the one with the earliest created_at (lowest id on tie)", async () => {
    // Both Queiroz rows were inserted in the same statement, so created_at
    // ties and the lowest id wins.
    const canonicalId = queiroz1Id < queiroz2Id ? queiroz1Id : queiroz2Id;
    const { rows } = await db.query(`select id from public.experts where nome = 'Queiroz'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: canonicalId });
  });
});

describe("user_roles role expert", () => {
  it("accepts role expert with a tenant", async () => {
    await expect(
      db.query(
        `insert into public.user_roles (user_id, tenant_id, role) values (gen_random_uuid(), $1, 'expert')`,
        [TENANT_A],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects role expert without a tenant", async () => {
    await expect(
      db.query(
        `insert into public.user_roles (user_id, tenant_id, role) values (gen_random_uuid(), null, 'expert')`,
      ),
    ).rejects.toThrow(/user_roles_canonical_scope/);
  });
});

describe("save_expert", () => {
  it("trims and dedupes ids and labels matching players", async () => {
    const { rows } = await db.query<{ save_expert: string }>(
      `select save_expert($1, null, 'Marina', 'total', $2, 'aprovacao', 500, 5) as save_expert`,
      [TENANT_A, [" AFF9", "AFF9", ""]],
    );
    const expertId = rows[0].save_expert;
    expect(expertId).toBeTruthy();

    const { rows: affiliates } = await db.query<{ affiliate_id: string }>(
      `select affiliate_id from public.expert_affiliates where expert_id = $1`,
      [expertId],
    );
    expect(affiliates.map((a) => a.affiliate_id)).toEqual(["AFF9"]);

    // AFF9 does not exist yet on any player; insert one in each house to
    // check the label only applies within the owning tenant.
    await db.query(`insert into public.players (tenant_id, affiliate_id) values ($1, 'AFF9'), ($2, 'AFF9')`, [
      TENANT_A,
      TENANT_B,
    ]);
    // Re-run so the newly inserted player picks up the label too.
    await db.query(
      `select save_expert($1, $2, 'Marina', 'total', $3, 'aprovacao', 500, 5)`,
      [TENANT_A, expertId, ["AFF9"]],
    );

    const { rows: playerA } = await db.query<{ expert: string | null }>(
      `select expert from public.players where tenant_id = $1 and affiliate_id = 'AFF9'`,
      [TENANT_A],
    );
    expect(playerA[0].expert).toBe("Marina");

    const { rows: playerB } = await db.query<{ expert: string | null }>(
      `select expert from public.players where tenant_id = $1 and affiliate_id = 'AFF9'`,
      [TENANT_B],
    );
    expect(playerB[0].expert).toBeNull();
  });

  it("labels a player whose stored affiliate_id has surrounding whitespace", async () => {
    await db.query(`insert into public.players (tenant_id, affiliate_id) values ($1, ' AFF8 ')`, [
      TENANT_A,
    ]);

    const { rows } = await db.query<{ save_expert: string }>(
      `select save_expert($1, null, 'Espacado', 'restrito', $2, 'livre', null, 3) as save_expert`,
      [TENANT_A, ["AFF8"]],
    );
    expect(rows[0].save_expert).toBeTruthy();

    const { rows: player } = await db.query<{ expert: string | null }>(
      `select expert from public.players where tenant_id = $1 and affiliate_id = ' AFF8 '`,
      [TENANT_A],
    );
    expect(player[0].expert).toBe("Espacado");
  });

  it("rejects an affiliate id owned by another expert of the same house", async () => {
    await expect(
      db.query(
        `select save_expert($1, null, 'Outro', 'restrito', $2, 'livre', null, 3)`,
        [TENANT_A, ["AFF1"]],
      ),
    ).rejects.toThrow(/affiliate_taken:AFF1/);
  });

  it("allows the same affiliate id in two different houses", async () => {
    await expect(
      db.query(
        `select save_expert($1, null, 'Outro B', 'restrito', $2, 'livre', null, 3)`,
        [TENANT_B, ["AFF1"]],
      ),
    ).resolves.toBeDefined();
  });

  it("clears a player's label when an affiliate id is removed from the expert", async () => {
    const { rows: queiroz } = await db.query<{ id: string }>(
      `select id from public.experts where tenant_id = $1 and nome = 'Queiroz'`,
      [TENANT_A],
    );
    const queirozId = queiroz[0].id;

    // Before removal, AFF1/AFF2 both label as Queiroz.
    await db.query(
      `select save_expert($1, $2, 'Queiroz', 'restrito', $3, 'livre', null, 3)`,
      [TENANT_A, queirozId, ["AFF1", "AFF2"]],
    );
    let { rows: labeled } = await db.query<{ affiliate_id: string; expert: string | null }>(
      `select affiliate_id, expert from public.players where tenant_id = $1 and affiliate_id in ('AFF1','AFF2') order by affiliate_id`,
      [TENANT_A],
    );
    expect(labeled.every((r) => r.expert === "Queiroz")).toBe(true);

    // Now keep only AFF1.
    await db.query(
      `select save_expert($1, $2, 'Queiroz', 'restrito', $3, 'livre', null, 3)`,
      [TENANT_A, queirozId, ["AFF1"]],
    );
    ({ rows: labeled } = await db.query<{ affiliate_id: string; expert: string | null }>(
      `select affiliate_id, expert from public.players where tenant_id = $1 and affiliate_id in ('AFF1','AFF2') order by affiliate_id`,
      [TENANT_A],
    ));
    expect(labeled.find((r) => r.affiliate_id === "AFF1")!.expert).toBe("Queiroz");
    expect(labeled.find((r) => r.affiliate_id === "AFF2")!.expert).toBeNull();
  });

  it("raises expert_not_found when updating an expert id that does not belong to the house", async () => {
    const { rows: andrade } = await db.query<{ id: string }>(
      `select id from public.experts where tenant_id = $1 and nome = 'Andrade'`,
      [TENANT_A],
    );
    await expect(
      db.query(
        `select save_expert($1, $2, 'Andrade', 'restrito', $3, 'livre', null, 3)`,
        [TENANT_B, andrade[0].id, ["AFF3"]],
      ),
    ).rejects.toThrow(/expert_not_found/);
  });
});

describe("expert_affiliates tenant consistency trigger", () => {
  it("rejects a row whose tenant differs from the expert's own tenant", async () => {
    const { rows: andrade } = await db.query<{ id: string }>(
      `select id from public.experts where tenant_id = $1 and nome = 'Andrade'`,
      [TENANT_A],
    );
    await expect(
      db.query(
        `insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id) values ($1, $2, 'AFFX')`,
        [TENANT_B, andrade[0].id],
      ),
    ).rejects.toThrow(/expert_affiliates_tenant_mismatch/);
  });
});

describe("delete_expert", () => {
  it("refuses to delete an expert that has a linked user", async () => {
    const { rows: user } = await db.query<{ id: string }>(
      `insert into auth.users (id) values (gen_random_uuid()) returning id`,
    );
    const { rows: expertRow } = await db.query<{ save_expert: string }>(
      `select save_expert($1, null, 'Com Usuario', 'restrito', $2, 'livre', null, 3) as save_expert`,
      [TENANT_A, ["AFFU"]],
    );
    const expertId = expertRow[0].save_expert;
    await db.query(`update public.experts set user_id = $1 where id = $2`, [user[0].id, expertId]);

    await expect(db.query(`select delete_expert($1, $2)`, [TENANT_A, expertId])).rejects.toThrow(
      /expert_has_user/,
    );
  });

  it("clears labels and deletes the expert", async () => {
    const { rows: andrade } = await db.query<{ id: string }>(
      `select id from public.experts where tenant_id = $1 and nome = 'Andrade'`,
      [TENANT_A],
    );
    const andradeId2 = andrade[0].id;

    await db.query(`select delete_expert($1, $2)`, [TENANT_A, andradeId2]);

    const { rows: remaining } = await db.query(`select id from public.experts where id = $1`, [andradeId2]);
    expect(remaining).toHaveLength(0);

    const { rows: player } = await db.query<{ expert: string | null }>(
      `select expert from public.players where tenant_id = $1 and affiliate_id = 'AFF3'`,
      [TENANT_A],
    );
    expect(player[0].expert).toBeNull();
  });
});

describe("tenant_unassigned_affiliate_ids", () => {
  it("lists only affiliate ids without an expert, by lead count descending", async () => {
    // Fresh tenant to keep this independent from the mutations above.
    const tenant = "00000000-0000-4000-8000-0000000000c0";
    await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa C')`, [tenant]);
    await db.query(
      `insert into public.players (tenant_id, affiliate_id) values
         ($1, 'X1'), ($1, 'X1'), ($1, 'X1'),
         ($1, 'X2'), ($1, 'X2'),
         ($1, 'X3'),
         ($1, ' '), ($1, null)`,
      [tenant],
    );
    const { rows: expertRow } = await db.query<{ save_expert: string }>(
      `select save_expert($1, null, 'Dono do X3', 'restrito', $2, 'livre', null, 3) as save_expert`,
      [tenant, ["X3"]],
    );
    expect(expertRow[0].save_expert).toBeTruthy();

    const { rows } = await db.query<{ affiliate_id: string; leads: number }>(
      `select affiliate_id, leads from tenant_unassigned_affiliate_ids($1, 20)`,
      [tenant],
    );
    expect(rows).toEqual([
      { affiliate_id: "X1", leads: 3 },
      { affiliate_id: "X2", leads: 2 },
    ]);
  });
});

describe("authenticated has no direct write access to experts/expert_affiliates", () => {
  let directWriteExpertId: string;

  beforeAll(async () => {
    const { rows } = await db.query<{ save_expert: string }>(
      `select save_expert($1, null, 'Escrita Direta', 'restrito', $2, 'livre', null, 3) as save_expert`,
      [TENANT_A, ["AFFDIRECT"]],
    );
    directWriteExpertId = rows[0].save_expert;
  });

  it("cannot insert into expert_affiliates directly, even with a matching tenant_id", async () => {
    await db.query("BEGIN");
    try {
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(
        db.query(
          `insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id) values ($1, $2, 'AFFBYPASS')`,
          [TENANT_A, directWriteExpertId],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("cannot update experts directly (e.g. tipo)", async () => {
    await db.query("BEGIN");
    try {
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(
        db.query(`update public.experts set tipo = 'total' where id = $1`, [directWriteExpertId]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

describe("service_role-only guard", () => {
  it("authenticated cannot execute save_expert", async () => {
    await db.query("BEGIN");
    try {
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(
        db.query(`select save_expert($1, null, 'Deny', 'restrito', $2, 'livre', null, 3)`, [
          TENANT_A,
          ["AFFDENY"],
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
