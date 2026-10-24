// Expert lead-sheet tables + atomic lead claim — SQL tests for
// supabase/migrations/20261027100000_expert_lead_sheet.sql
//
// Runs 20261025100000_add_expert_app_role.sql, 20261025100100_expert_model.sql
// and 20261027100000_expert_lead_sheet.sql inside an in-memory Postgres
// (PGlite) against a minimal schema (same shape as expert-model.db.test.ts,
// plus a minimal link_dispatches table for the expert_links FK). Asserts:
// the lead tables' tenant-consistency trigger, the CHECK constraints, the
// deny-by-default grants for authenticated, and claim_expert_lead /
// release_expert_lead.

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
const MIGRATION_LEAD_SHEET = readFileSync(
  resolve(root, "supabase/migrations/20261027100000_expert_lead_sheet.sql"),
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

-- Minimal stand-in for 20261006150000_create_shortio_link_tracking.sql, just
-- enough for expert_links.link_dispatch_id's FK.
create table public.link_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade
);

grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant select, insert, update, delete on public.tenants to anon, authenticated, service_role;
grant select, insert, update, delete on public.user_roles to anon, authenticated, service_role;
grant select, insert, update, delete on public.players to anon, authenticated, service_role;
grant select, insert, update, delete on public.experts to anon, authenticated, service_role;
grant select, insert, update, delete on public.link_dispatches to anon, authenticated, service_role;

-- Emulates Supabase's real default: every table created from here on grants
-- authenticated full CRUD unless a migration revokes it explicitly, same as
-- production (see 20261015100000_fix_rls_privilege_escalation.sql, which
-- only strips the default grants for anon and TRUNCATE for authenticated).
alter default privileges in schema public grant all on tables to authenticated;
`;

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;

let totalExpertId: string;
let totalExpert2Id: string;
let restritoExpertId: string;
let inactiveExpertId: string;
let playerId: string;
let otherTenantExpertId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);

  await db.query(`insert into public.tenants (id, nome) values ($1, 'Casa A'), ($2, 'Casa B')`, [
    TENANT_A,
    TENANT_B,
  ]);

  await db.exec(MIGRATION_ROLE);
  await db.exec(MIGRATION_MODEL);
  await db.exec(MIGRATION_LEAD_SHEET);

  const { rows: experts } = await db.query<{ save_expert: string }>(
    `select save_expert($1, null, $2, $3, $4, 'livre', null, $5) as save_expert`,
    [TENANT_A, "Total Um", "total", [], 1],
  );
  totalExpertId = experts[0].save_expert;

  const { rows: experts2 } = await db.query<{ save_expert: string }>(
    `select save_expert($1, null, $2, $3, $4, 'livre', null, $5) as save_expert`,
    [TENANT_A, "Total Dois", "total", [], 1],
  );
  totalExpert2Id = experts2[0].save_expert;

  const { rows: restrito } = await db.query<{ save_expert: string }>(
    `select save_expert($1, null, $2, $3, $4, 'livre', null, $5) as save_expert`,
    [TENANT_A, "Restrito", "restrito", [], 3],
  );
  restritoExpertId = restrito[0].save_expert;

  const { rows: inactive } = await db.query<{ save_expert: string }>(
    `select save_expert($1, null, $2, $3, $4, 'livre', null, $5) as save_expert`,
    [TENANT_A, "Inativo", "total", [], 3],
  );
  inactiveExpertId = inactive[0].save_expert;
  await db.query(`update public.experts set ativo = false where id = $1`, [inactiveExpertId]);

  const { rows: otherExpert } = await db.query<{ save_expert: string }>(
    `select save_expert($1, null, $2, $3, $4, 'livre', null, $5) as save_expert`,
    [TENANT_B, "Outra Casa", "total", [], 3],
  );
  otherTenantExpertId = otherExpert[0].save_expert;

  const { rows: players } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id) values ($1) returning id`,
    [TENANT_A],
  );
  playerId = players[0].id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("claim_expert_lead", () => {
  it("claim by a total expert sets expires_at = now + assumir_prazo_dias", async () => {
    const before = Date.now();
    const { rows } = await db.query<{
      expert_id: string;
      expert_nome: string;
      expires_at: string;
      claimed: boolean;
    }>(`select * from claim_expert_lead($1, $2, $3)`, [TENANT_A, totalExpertId, playerId]);

    expect(rows).toHaveLength(1);
    expect(rows[0].claimed).toBe(true);
    expect(rows[0].expert_id).toBe(totalExpertId);
    expect(rows[0].expert_nome).toBe("Total Um");

    const expiresMs = new Date(rows[0].expires_at).getTime();
    // assumir_prazo_dias = 1 for this expert.
    const expectedMs = before + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(5000);
  });

  it("second total expert gets claimed=false with the holder's name while the claim is active", async () => {
    const { rows: holder } = await db.query<{ expires_at: string }>(
      `select expires_at from public.expert_lead_claims where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    );

    const { rows } = await db.query<{
      expert_id: string;
      expert_nome: string;
      expires_at: string;
      claimed: boolean;
    }>(`select * from claim_expert_lead($1, $2, $3)`, [TENANT_A, totalExpert2Id, playerId]);

    expect(rows).toHaveLength(1);
    expect(rows[0].claimed).toBe(false);
    expect(rows[0].expert_id).toBe(totalExpertId);
    expect(rows[0].expert_nome).toBe("Total Um");
    expect(new Date(rows[0].expires_at).getTime()).toBe(new Date(holder[0].expires_at).getTime());
  });

  it("same expert renews the claim", async () => {
    const { rows: before } = await db.query<{ expires_at: string }>(
      `select expires_at from public.expert_lead_claims where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    );

    const { rows } = await db.query<{ expert_id: string; claimed: boolean; expires_at: string }>(
      `select * from claim_expert_lead($1, $2, $3)`,
      [TENANT_A, totalExpertId, playerId],
    );

    expect(rows[0].claimed).toBe(true);
    expect(rows[0].expert_id).toBe(totalExpertId);
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before[0].expires_at).getTime(),
    );
  });

  it("expired claim can be taken by another expert", async () => {
    await db.query(
      `update public.expert_lead_claims set expires_at = now() - interval '1 day' where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    );

    const { rows } = await db.query<{ expert_id: string; claimed: boolean }>(
      `select * from claim_expert_lead($1, $2, $3)`,
      [TENANT_A, totalExpert2Id, playerId],
    );

    expect(rows[0].claimed).toBe(true);
    expect(rows[0].expert_id).toBe(totalExpert2Id);

    const { rows: stored } = await db.query<{ expert_id: string }>(
      `select expert_id from public.expert_lead_claims where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    );
    expect(stored[0].expert_id).toBe(totalExpert2Id);
  });

  it("restricted or inactive expert gets expert_claim_not_allowed", async () => {
    await expect(
      db.query(`select * from claim_expert_lead($1, $2, $3)`, [TENANT_A, restritoExpertId, playerId]),
    ).rejects.toThrow(/expert_claim_not_allowed/);

    await expect(
      db.query(`select * from claim_expert_lead($1, $2, $3)`, [TENANT_A, inactiveExpertId, playerId]),
    ).rejects.toThrow(/expert_claim_not_allowed/);
  });
});

describe("release_expert_lead", () => {
  it("release only removes the caller's own claim", async () => {
    // playerId is currently held by totalExpert2Id (from the expiry test above).
    await db.query(`select release_expert_lead($1, $2, $3)`, [TENANT_A, totalExpertId, playerId]);

    let { rows } = await db.query(
      `select 1 from public.expert_lead_claims where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    );
    expect(rows).toHaveLength(1);

    await db.query(`select release_expert_lead($1, $2, $3)`, [TENANT_A, totalExpert2Id, playerId]);

    ({ rows } = await db.query(
      `select 1 from public.expert_lead_claims where tenant_id = $1 and player_id = $2`,
      [TENANT_A, playerId],
    ));
    expect(rows).toHaveLength(0);
  });
});

describe("tenant-consistency trigger", () => {
  it("rows whose tenant differs from the expert's or the player's are rejected", async () => {
    // expert and player both belong to TENANT_A, but the row claims TENANT_B.
    await expect(
      db.query(
        `insert into public.expert_links
           (tenant_id, expert_id, player_id, oferta, original_url, sent_url, shortened)
         values ($1, $2, $3, 'Oferta teste', 'https://example.com', 'https://example.com', false)`,
        [TENANT_B, totalExpertId, playerId],
      ),
    ).rejects.toThrow(/expert_lead_tenant_mismatch/);

    // expert belongs to TENANT_B, but player belongs to TENANT_A; row claims
    // the expert's own (wrong, from the player's perspective) tenant.
    await expect(
      db.query(
        `insert into public.expert_links
           (tenant_id, expert_id, player_id, oferta, original_url, sent_url, shortened)
         values ($1, $2, $3, 'Oferta teste', 'https://example.com', 'https://example.com', false)`,
        [TENANT_B, otherTenantExpertId, playerId],
      ),
    ).rejects.toThrow(/expert_lead_tenant_mismatch/);
  });
});

describe("expert_lead_contacts", () => {
  it("contact resultado outside the allowed set is rejected", async () => {
    await expect(
      db.query(
        `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado)
         values ($1, $2, $3, 'invalido')`,
        [TENANT_A, totalExpertId, playerId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado)
         values ($1, $2, $3, 'chamei')`,
        [TENANT_A, totalExpertId, playerId],
      ),
    ).resolves.toBeDefined();
  });
});

describe("authenticated has no direct write access", () => {
  // Each attempt runs in its own BEGIN/ROLLBACK: once a statement fails, the
  // surrounding transaction is aborted and every later statement in it would
  // fail with "current transaction is aborted" instead of the permission
  // error actually being asserted.
  async function expectDeniedAsAuthenticated(sql: string, params: unknown[]) {
    await db.query("BEGIN");
    try {
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(db.query(sql, params)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  }

  it("cannot write any expert lead table nor execute claim_expert_lead", async () => {
    await expectDeniedAsAuthenticated(
      `insert into public.expert_links
         (tenant_id, expert_id, player_id, oferta, original_url, sent_url, shortened)
       values ($1, $2, $3, 'Oferta', 'https://example.com', 'https://example.com', false)`,
      [TENANT_A, totalExpertId, playerId],
    );

    await expectDeniedAsAuthenticated(
      `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado)
       values ($1, $2, $3, 'chamei')`,
      [TENANT_A, totalExpertId, playerId],
    );

    await expectDeniedAsAuthenticated(
      `insert into public.expert_lead_followups (tenant_id, expert_id, player_id, due_date)
       values ($1, $2, $3, current_date)`,
      [TENANT_A, totalExpertId, playerId],
    );

    await expectDeniedAsAuthenticated(
      `insert into public.expert_lead_claims (tenant_id, player_id, expert_id, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [TENANT_A, playerId, totalExpertId],
    );

    await expectDeniedAsAuthenticated(
      `insert into public.expert_message_templates (tenant_id, expert_id, nome, conteudo)
       values ($1, $2, 'Modelo', 'Conteudo')`,
      [TENANT_A, totalExpertId],
    );

    await expectDeniedAsAuthenticated(`select * from claim_expert_lead($1, $2, $3)`, [
      TENANT_A,
      totalExpertId,
      playerId,
    ]);
  });
});
