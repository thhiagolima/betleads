// Per-deposit expert credit — SQL tests for
// supabase/migrations/20261104100000_expert_credits.sql
//
// Runs the expert migrations of phases 1 and 2 plus the new one inside an
// in-memory Postgres (PGlite) against a minimal schema (same approach as
// expert-lead-sheet.db.test.ts, plus deposits, click_events,
// gamification_settings and a managed_tenant_ids() identical to production).
// Asserts the attribution rule of refresh_expert_credits (click within the
// window, affiliate fallback, FTD/reactivation flags), its range/idempotency
// behaviour, refresh_expert_credits_recent and the admin/gestor-only reads.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const migration = (name: string) =>
  readFileSync(resolve(root, "supabase/migrations", name), "utf8");

const MIGRATIONS = [
  "20261025100000_add_expert_app_role.sql",
  "20261025100100_expert_model.sql",
  "20261027100000_expert_lead_sheet.sql",
  "20261104100000_expert_credits.sql",
];

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (
  id uuid primary key
);
-- auth.uid() / current_tenant_id() read test settings so RLS can be exercised.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.current_tenant_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.tenant', true), '')::uuid
$$;

create type public.app_role as enum ('admin', 'user', 'super_admin', 'owner', 'member', 'gestor');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Casa',
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

-- Same body as 20261015100000_fix_rls_privilege_escalation.sql.
create function public.managed_tenant_ids() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ur.tenant_id), '{}'::uuid[])
  from public.user_roles ur
  where ur.user_id = auth.uid()
    and ur.tenant_id is not null
    and ur.role in ('admin', 'gestor')
$$;

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  affiliate_id text,
  expert text,
  ftd_em timestamptz
);

-- Legacy shape, as it exists in production before the expert migrations.
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id text not null unique,
  nome text not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  valor numeric not null default 0,
  status text not null default 'pendente',
  created_at timestamptz not null default now()
);

create table public.link_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  recipient_player_id uuid references public.players(id) on delete set null,
  source_type text not null default 'expert',
  source_id text,
  send_status text not null default 'sent',
  sent_at timestamptz
);

create table public.click_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  link_dispatch_id uuid not null references public.link_dispatches(id) on delete restrict,
  occurred_at timestamptz not null default clock_timestamp(),
  is_human boolean not null default true
);

create table public.gamification_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  sleeping_after_days integer not null default 7
);

grant usage on schema auth, public to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant select, insert, update, delete on public.tenants to anon, authenticated, service_role;
grant select, insert, update, delete on public.user_roles to anon, authenticated, service_role;
grant select, insert, update, delete on public.players to anon, authenticated, service_role;
grant select, insert, update, delete on public.experts to anon, authenticated, service_role;
grant select, insert, update, delete on public.deposits to anon, authenticated, service_role;
grant select, insert, update, delete on public.link_dispatches to anon, authenticated, service_role;
grant select, insert, update, delete on public.click_events to anon, authenticated, service_role;
grant select, insert, update, delete on public.gamification_settings to anon, authenticated, service_role;

-- Emulates Supabase's real default: every table created from here on grants
-- authenticated full CRUD unless a migration revokes it explicitly.
alter default privileges in schema public grant all on tables to authenticated;
`;

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const TENANT_DEMO = "00000000-0000-4000-8000-00000000000d";
const TENANT_W = "00000000-0000-4000-8000-0000000000e0"; // custom click window
const MEMBER_USER = "00000000-0000-4000-8000-0000000000f1";
const GESTOR_USER = "00000000-0000-4000-8000-0000000000f2";

// Wide range used when a test only cares about the attribution itself.
const ALL_FROM = "2020-01-01T00:00:00Z";
const ALL_TO = "2030-01-01T00:00:00Z";

let db: PGlite;

let expert1: string; // tenant A, owns affiliate AFF-1
let expert2: string; // tenant A
let expertB: string; // tenant B
let expertDemo: string; // demo tenant
let expertW: string; // tenant W

type Credit = {
  deposit_id: string;
  tenant_id: string;
  player_id: string;
  expert_id: string;
  via: "clique" | "afiliado";
  valor: string;
  deposit_at: string;
  link_dispatch_id: string | null;
  click_at: string | null;
  is_ftd: boolean;
  is_reativacao: boolean;
  click_window_hours: number;
  rule_version: number;
};

async function newExpert(tenant: string, nome: string, affiliates: string[]) {
  const { rows } = await db.query<{ id: string }>(
    `select save_expert($1, null, $2, 'total', $3, 'livre', null, 1) as id`,
    [tenant, nome, affiliates],
  );
  // Registered long before any deposit used in these tests.
  await db.query(`update public.experts set created_at = '2025-01-01T00:00:00Z' where id = $1`, [
    rows[0].id,
  ]);
  await setAffiliateSince(rows[0].id, "2025-01-01T00:00:00Z");
  return rows[0].id;
}

/** Backdates when the expert's current affiliate ids were linked. */
async function setAffiliateSince(expertId: string, at: string) {
  await db.query(`update public.expert_affiliates set created_at = $2 where expert_id = $1`, [
    expertId,
    at,
  ]);
  await db.query(
    `update public.expert_affiliate_history set valid_from = $2
     where expert_id = $1 and valid_to is null`,
    [expertId, at],
  );
}

async function resave(
  tenant: string,
  expertId: string,
  nome: string,
  affiliates: string[],
  teto: number | null = null,
) {
  await db.query(`select save_expert($1, $2, $3, 'total', $4, 'livre', $5, 1)`, [
    tenant,
    expertId,
    nome,
    affiliates,
    teto,
  ]);
}

type HistoryRow = { expert_id: string; valid_from: string; valid_to: string | null };

async function history(tenant: string, affiliate: string): Promise<HistoryRow[]> {
  const { rows } = await db.query<HistoryRow>(
    `select expert_id, valid_from, valid_to from public.expert_affiliate_history
     where tenant_id = $1 and affiliate_id = $2 order by valid_from`,
    [tenant, affiliate],
  );
  return rows;
}

const plusMs = (at: string | Date, ms: number) =>
  new Date(new Date(at).getTime() + ms).toISOString();

async function newPlayer(tenant: string, opts: { affiliate?: string; ftdEm?: string } = {}) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id, affiliate_id, ftd_em) values ($1, $2, $3) returning id`,
    [tenant, opts.affiliate ?? null, opts.ftdEm ?? null],
  );
  return rows[0].id;
}

async function deposit(
  tenant: string,
  player: string,
  at: string,
  opts: { status?: string; valor?: number } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.deposits (tenant_id, player_id, created_at, status, valor)
     values ($1, $2, $3, $4, $5) returning id`,
    [tenant, player, at, opts.status ?? "aprovado", opts.valor ?? 100],
  );
  return rows[0].id;
}

async function dispatch(
  tenant: string,
  sourceId: string,
  player: string,
  sentAt: string,
  opts: { sourceType?: string; status?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.link_dispatches
       (tenant_id, source_type, source_id, recipient_player_id, send_status, sent_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tenant, opts.sourceType ?? "expert", sourceId, player, opts.status ?? "sent", sentAt],
  );
  return rows[0].id;
}

async function click(tenant: string, dispatchId: string, at: string, human = true) {
  await db.query(
    `insert into public.click_events (tenant_id, link_dispatch_id, occurred_at, is_human)
     values ($1, $2, $3, $4)`,
    [tenant, dispatchId, at, human],
  );
}

async function refresh(tenant: string, from = ALL_FROM, to = ALL_TO) {
  const { rows } = await db.query<{ n: number }>(
    `select public.refresh_expert_credits($1, $2, $3) as n`,
    [tenant, from, to],
  );
  return rows[0].n;
}

async function credit(depositId: string): Promise<Credit | undefined> {
  const { rows } = await db.query<Credit>(
    `select * from public.expert_deposit_credits where deposit_id = $1`,
    [depositId],
  );
  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.query(
    `insert into public.tenants (id, nome, is_demo) values
       ($1, 'Casa A', false), ($2, 'Casa B', false), ($3, 'Casa Demo', true), ($4, 'Casa W', false)`,
    [TENANT_A, TENANT_B, TENANT_DEMO, TENANT_W],
  );
  for (const name of MIGRATIONS) await db.exec(migration(name));

  expert1 = await newExpert(TENANT_A, "Expert Um", ["AFF-1"]);
  expert2 = await newExpert(TENANT_A, "Expert Dois", []);
  expertB = await newExpert(TENANT_B, "Expert B", []);
  expertDemo = await newExpert(TENANT_DEMO, "Expert Demo", ["AFF-DEMO"]);
  expertW = await newExpert(TENANT_W, "Expert W", []);

  await db.query(
    `insert into public.gamification_settings (tenant_id, sleeping_after_days) values ($1, 10)`,
    [TENANT_B],
  );
  await db.query(
    `insert into public.expert_settings (tenant_id, click_window_hours) values ($1, 24)`,
    [TENANT_W],
  );
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("refresh_expert_credits — attribution", () => {
  it("click within 72h credits the clicking expert with via 'clique'", async () => {
    const player = await newPlayer(TENANT_A);
    const ld = await dispatch(TENANT_A, expert2, player, "2026-10-01T10:00:00Z");
    await click(TENANT_A, ld, "2026-10-01T12:00:00Z");
    const dep = await deposit(TENANT_A, player, "2026-10-04T11:00:00Z", { valor: 250 });

    await refresh(TENANT_A);

    const row = await credit(dep);
    expect(row).toMatchObject({
      expert_id: expert2,
      via: "clique",
      tenant_id: TENANT_A,
      player_id: player,
      link_dispatch_id: ld,
      click_window_hours: 72,
      rule_version: 1,
    });
    expect(Number(row?.valor)).toBe(250);
    expect(new Date(row!.click_at!).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(new Date(row!.deposit_at).toISOString()).toBe("2026-10-04T11:00:00.000Z");
  });

  it("latest click wins between two experts", async () => {
    const player = await newPlayer(TENANT_A);
    const ld1 = await dispatch(TENANT_A, expert1, player, "2026-10-02T08:00:00Z");
    const ld2 = await dispatch(TENANT_A, expert2, player, "2026-10-02T09:00:00Z");
    await click(TENANT_A, ld2, "2026-10-02T09:30:00Z");
    await click(TENANT_A, ld1, "2026-10-02T10:00:00Z");
    const dep1 = await deposit(TENANT_A, player, "2026-10-02T11:00:00Z");
    await click(TENANT_A, ld2, "2026-10-02T12:00:00Z");
    const dep2 = await deposit(TENANT_A, player, "2026-10-02T13:00:00Z");

    await refresh(TENANT_A);

    expect((await credit(dep1))?.expert_id).toBe(expert1);
    expect((await credit(dep1))?.link_dispatch_id).toBe(ld1);
    expect((await credit(dep2))?.expert_id).toBe(expert2);
    expect((await credit(dep2))?.link_dispatch_id).toBe(ld2);
  });

  it("click older than the window, bot click, click before sent_at or link for another player does not credit by click", async () => {
    // Older than 72 h.
    const p1 = await newPlayer(TENANT_A);
    const ld1 = await dispatch(TENANT_A, expert2, p1, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld1, "2026-09-01T01:00:00Z");
    const d1 = await deposit(TENANT_A, p1, "2026-09-04T01:00:01Z");

    // Bot click.
    const p2 = await newPlayer(TENANT_A);
    const ld2 = await dispatch(TENANT_A, expert2, p2, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld2, "2026-09-01T01:00:00Z", false);
    const d2 = await deposit(TENANT_A, p2, "2026-09-01T02:00:00Z");

    // Click recorded before the link was sent.
    const p3 = await newPlayer(TENANT_A);
    const ld3 = await dispatch(TENANT_A, expert2, p3, "2026-09-01T05:00:00Z");
    await click(TENANT_A, ld3, "2026-09-01T04:00:00Z");
    const d3 = await deposit(TENANT_A, p3, "2026-09-01T06:00:00Z");

    // Link sent to another player (who forwarded it).
    const p4 = await newPlayer(TENANT_A);
    const other = await newPlayer(TENANT_A);
    const ld4 = await dispatch(TENANT_A, expert2, other, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld4, "2026-09-01T01:00:00Z");
    const d4 = await deposit(TENANT_A, p4, "2026-09-01T02:00:00Z");

    // Click after the deposit, failed send, non-expert source and a
    // non-uuid source_id (must be ignored, not abort the refresh).
    const p5 = await newPlayer(TENANT_A);
    const ld5a = await dispatch(TENANT_A, expert2, p5, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld5a, "2026-09-01T03:00:00Z");
    const ld5b = await dispatch(TENANT_A, expert2, p5, "2026-09-01T00:00:00Z", {
      status: "failed",
    });
    await click(TENANT_A, ld5b, "2026-09-01T01:00:00Z");
    const ld5c = await dispatch(TENANT_A, expert2, p5, "2026-09-01T00:00:00Z", {
      sourceType: "campaign",
    });
    await click(TENANT_A, ld5c, "2026-09-01T01:00:00Z");
    const ld5d = await dispatch(TENANT_A, "not-a-uuid", p5, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld5d, "2026-09-01T01:00:00Z");
    // An expert of another house is not credited either.
    const ld5e = await dispatch(TENANT_A, expertB, p5, "2026-09-01T00:00:00Z");
    await click(TENANT_A, ld5e, "2026-09-01T01:00:00Z");
    const d5 = await deposit(TENANT_A, p5, "2026-09-01T02:00:00Z");

    await refresh(TENANT_A);

    for (const dep of [d1, d2, d3, d4, d5]) expect(await credit(dep)).toBeUndefined();
  });

  it("falls back to the affiliate expert only for deposits after the expert was created and the id was linked", async () => {
    const expert = await newExpert(TENANT_A, "Expert Afiliado", ["AFF-LATE"]);
    await db.query(`update public.experts set created_at = '2026-08-01T00:00:00Z' where id = $1`, [
      expert,
    ]);
    await setAffiliateSince(expert, "2026-08-10T00:00:00Z");
    // Affiliate id padded with spaces: matched after btrim.
    const player = await newPlayer(TENANT_A, { affiliate: "  AFF-LATE " });
    const beforeExpert = await deposit(TENANT_A, player, "2026-07-20T00:00:00Z");
    const beforeAffiliate = await deposit(TENANT_A, player, "2026-08-05T00:00:00Z");
    const atAffiliate = await deposit(TENANT_A, player, "2026-08-10T00:00:00Z");
    const after = await deposit(TENANT_A, player, "2026-08-20T00:00:00Z");

    await refresh(TENANT_A);

    expect(await credit(beforeExpert)).toBeUndefined();
    expect(await credit(beforeAffiliate)).toBeUndefined();
    expect(await credit(atAffiliate)).toMatchObject({
      expert_id: expert,
      via: "afiliado",
      link_dispatch_id: null,
      click_at: null,
    });
    expect((await credit(after))?.expert_id).toBe(expert);
  });

  it("click beats affiliate", async () => {
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    const ld = await dispatch(TENANT_A, expert2, player, "2026-10-05T10:00:00Z");
    await click(TENANT_A, ld, "2026-10-05T10:05:00Z");
    const viaClick = await deposit(TENANT_A, player, "2026-10-05T11:00:00Z");
    const viaAffiliate = await deposit(TENANT_A, player, "2026-10-15T11:00:00Z");

    await refresh(TENANT_A);

    expect(await credit(viaClick)).toMatchObject({ expert_id: expert2, via: "clique" });
    expect(await credit(viaAffiliate)).toMatchObject({ expert_id: expert1, via: "afiliado" });
  });

  it("non-approved deposits get no credit", async () => {
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    const pending = await deposit(TENANT_A, player, "2026-10-06T10:00:00Z", { status: "pendente" });
    const refused = await deposit(TENANT_A, player, "2026-10-06T11:00:00Z", { status: "recusado" });

    await refresh(TENANT_A);

    expect(await credit(pending)).toBeUndefined();
    expect(await credit(refused)).toBeUndefined();
  });

  it("click_window_hours from expert_settings is honoured", async () => {
    const player = await newPlayer(TENANT_W);
    const ld = await dispatch(TENANT_W, expertW, player, "2026-10-01T00:00:00Z");
    await click(TENANT_W, ld, "2026-10-01T00:00:00Z");
    const outside = await deposit(TENANT_W, player, "2026-10-02T06:00:00Z"); // 30 h after
    const player2 = await newPlayer(TENANT_W);
    const ld2 = await dispatch(TENANT_W, expertW, player2, "2026-10-01T00:00:00Z");
    await click(TENANT_W, ld2, "2026-10-01T00:00:00Z");
    const inside = await deposit(TENANT_W, player2, "2026-10-01T20:00:00Z"); // 20 h after

    await refresh(TENANT_W);

    expect(await credit(outside)).toBeUndefined();
    expect(await credit(inside)).toMatchObject({
      expert_id: expertW,
      via: "clique",
      click_window_hours: 24,
    });
  });

  it("is_ftd for the first approved deposit and is_reativacao after sleeping_after_days without deposit", async () => {
    // Tenant B: sleeping_after_days = 10.
    const player = await newPlayer(TENANT_B, { ftdEm: "2026-06-01T00:05:00Z" });
    const ld = await dispatch(TENANT_B, expertB, player, "2026-05-01T00:00:00Z");
    // A pending deposit before the first approved one does not count.
    await deposit(TENANT_B, player, "2026-05-31T00:00:00Z", { status: "pendente" });
    const deps: string[] = [];
    for (const at of [
      "2026-06-01T00:00:00Z", // first approved deposit
      "2026-06-10T00:00:00Z", // 9 days later
      "2026-06-20T00:00:00Z", // 10 days later
    ]) {
      await click(TENANT_B, ld, new Date(new Date(at).getTime() - 60_000).toISOString());
      deps.push(await deposit(TENANT_B, player, at));
    }

    // First approved deposit in our history of a player whose FTD is older:
    // not an FTD.
    const older = await newPlayer(TENANT_B, { ftdEm: "2025-01-01T00:00:00Z" });
    const ldOlder = await dispatch(TENANT_B, expertB, older, "2026-06-01T00:00:00Z");
    await click(TENANT_B, ldOlder, "2026-06-01T00:30:00Z");
    const olderDep = await deposit(TENANT_B, older, "2026-06-01T01:00:00Z");

    await refresh(TENANT_B);

    expect(await credit(deps[0])).toMatchObject({ is_ftd: true, is_reativacao: false });
    expect(await credit(deps[1])).toMatchObject({ is_ftd: false, is_reativacao: false });
    expect(await credit(deps[2])).toMatchObject({ is_ftd: false, is_reativacao: true });
    expect(await credit(olderDep)).toMatchObject({ is_ftd: false, is_reativacao: false });
  });

  it("refresh is idempotent and only touches the given range", async () => {
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    const inRange = await deposit(TENANT_A, player, "2026-03-10T12:00:00Z");
    const outOfRange = await deposit(TENANT_A, player, "2026-03-20T12:00:00Z");
    await refresh(TENANT_A);

    const snapshot = async () =>
      (
        await db.query(
          `select deposit_id, expert_id, via, valor, deposit_at, link_dispatch_id, click_at,
                  is_ftd, is_reativacao, click_window_hours, rule_version
           from public.expert_deposit_credits where tenant_id = $1 order by deposit_id`,
          [TENANT_A],
        )
      ).rows;
    const before = await snapshot();
    const n = await refresh(TENANT_A);
    expect(n).toBe(before.length);
    expect(await snapshot()).toEqual(before);

    // The player loses the affiliate id; only the refreshed range changes.
    await db.query(`update public.players set affiliate_id = null where id = $1`, [player]);
    const touched = await refresh(TENANT_A, "2026-03-01T00:00:00Z", "2026-03-15T00:00:00Z");
    expect(touched).toBe(0);
    expect(await credit(inRange)).toBeUndefined();
    expect((await credit(outOfRange))?.expert_id).toBe(expert1);
    // The upper bound is exclusive.
    await db.query(`update public.players set affiliate_id = 'AFF-1' where id = $1`, [player]);
    expect(await refresh(TENANT_A, "2026-03-01T00:00:00Z", "2026-03-10T12:00:00Z")).toBe(0);
    expect(await credit(inRange)).toBeUndefined();
  });

  it("a deposit whose created_at moved into or out of the range keeps exactly one correct credit", async () => {
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    const dep = await deposit(TENANT_A, player, "2026-04-20T12:00:00Z");
    await refresh(TENANT_A, "2026-04-15T00:00:00Z", "2026-04-25T00:00:00Z");
    expect(new Date((await credit(dep))!.deposit_at).toISOString()).toBe(
      "2026-04-20T12:00:00.000Z",
    );

    // Outside the range → into it: the stored credit (deposit_at 04-20) is
    // outside [04-01, 04-10) but must be replaced, not collide.
    await db.query(`update public.deposits set created_at = '2026-04-05T12:00:00Z' where id = $1`, [
      dep,
    ]);
    expect(await refresh(TENANT_A, "2026-04-01T00:00:00Z", "2026-04-10T00:00:00Z")).toBe(1);
    const moved = await db.query<{ deposit_at: string }>(
      `select deposit_at from public.expert_deposit_credits where deposit_id = $1`,
      [dep],
    );
    expect(moved.rows).toHaveLength(1);
    expect(new Date(moved.rows[0].deposit_at).toISOString()).toBe("2026-04-05T12:00:00.000Z");

    // Inside the range → out of it: refreshing the old range drops the
    // stale credit, refreshing the new one recreates it once.
    await db.query(`update public.deposits set created_at = '2026-04-28T12:00:00Z' where id = $1`, [
      dep,
    ]);
    expect(await refresh(TENANT_A, "2026-04-01T00:00:00Z", "2026-04-10T00:00:00Z")).toBe(0);
    expect(await credit(dep)).toBeUndefined();
    expect(await refresh(TENANT_A, "2026-04-25T00:00:00Z", "2026-05-01T00:00:00Z")).toBe(1);
    const back = await credit(dep);
    expect(back?.expert_id).toBe(expert1);
    expect(new Date(back!.deposit_at).toISOString()).toBe("2026-04-28T12:00:00.000Z");
  });

  it("deposit at 00:30 São Paulo falls in that São Paulo day range", async () => {
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    // 00:30 BRT on 2026-10-20 is 03:30 UTC.
    const dep = await deposit(TENANT_A, player, "2026-10-20T03:30:00Z");
    const dayRange = async (day: string) => {
      const { rows } = await db.query<{ n: number }>(
        `select public.refresh_expert_credits(
           $1,
           ($2::date::timestamp at time zone 'America/Sao_Paulo'),
           (($2::date + 1)::timestamp at time zone 'America/Sao_Paulo')) as n`,
        [TENANT_A, day],
      );
      return rows[0].n;
    };

    await db.query(`delete from public.expert_deposit_credits where tenant_id = $1`, [TENANT_A]);
    await dayRange("2026-10-19");
    expect(await credit(dep)).toBeUndefined();
    await dayRange("2026-10-20");
    expect((await credit(dep))?.expert_id).toBe(expert1);
  });
});

describe("affiliate history (save_expert diff)", () => {
  it("re-saving an expert (e.g. teto change) keeps its affiliate credits after refresh", async () => {
    const expert = await newExpert(TENANT_A, "Expert Resave", ["AFF-RS", "AFF-RS2"]);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-RS" });
    const dep = await deposit(TENANT_A, player, "2026-09-15T12:00:00Z");
    await refresh(TENANT_A);
    expect(await credit(dep)).toMatchObject({ expert_id: expert, via: "afiliado" });

    const affiliateRows = async () =>
      (
        await db.query(
          `select id, affiliate_id, created_at from public.expert_affiliates
           where expert_id = $1 order by affiliate_id`,
          [expert],
        )
      ).rows;
    const before = await affiliateRows();
    await resave(TENANT_A, expert, "Expert Resave", ["AFF-RS", "AFF-RS2"], 500);
    await resave(TENANT_A, expert, "Expert Resave Novo Nome", [" AFF-RS ", "AFF-RS2"], 500);

    expect(await affiliateRows()).toEqual(before);
    expect(await history(TENANT_A, "AFF-RS")).toEqual([
      { expert_id: expert, valid_from: new Date("2025-01-01T00:00:00Z"), valid_to: null },
    ]);

    await refresh(TENANT_A);
    expect(await credit(dep)).toMatchObject({ expert_id: expert, via: "afiliado" });
  });

  it("moving an affiliate id from A to B keeps A's earlier credits and credits B only after the move", async () => {
    const expertA = await newExpert(TENANT_A, "Expert Mover A", ["AFF-MV", "AFF-MV-KEEP"]);
    const expertB = await newExpert(TENANT_A, "Expert Mover B", []);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-MV" });
    const old = await deposit(TENANT_A, player, "2026-09-01T12:00:00Z");

    // The id cannot be given to B while A still owns it.
    await expect(resave(TENANT_A, expertB, "Expert Mover B", ["AFF-MV"])).rejects.toThrow(
      /affiliate_taken:AFF-MV/,
    );
    await resave(TENANT_A, expertA, "Expert Mover A", ["AFF-MV-KEEP"]);
    await resave(TENANT_A, expertB, "Expert Mover B", ["AFF-MV"]);

    const rows = await history(TENANT_A, "AFF-MV");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ expert_id: expertA });
    expect(rows[1]).toMatchObject({ expert_id: expertB, valid_to: null });
    // Two saves: A's row closes when A drops the id, B's opens when B gets it.
    const removedAt = new Date(rows[0].valid_to!).toISOString();
    const movedAt = new Date(rows[1].valid_from).toISOString();
    expect(movedAt >= removedAt).toBe(true);
    // The untouched id of A kept its open row.
    expect(await history(TENANT_A, "AFF-MV-KEEP")).toEqual([
      { expert_id: expertA, valid_from: new Date("2025-01-01T00:00:00Z"), valid_to: null },
    ]);

    const justBefore = await deposit(TENANT_A, player, plusMs(removedAt, -1000));
    const atMove = await deposit(TENANT_A, player, movedAt);
    const after = await deposit(TENANT_A, player, plusMs(movedAt, 60_000));

    await refresh(TENANT_A);

    expect(await credit(old)).toMatchObject({ expert_id: expertA, via: "afiliado" });
    expect(await credit(justBefore)).toMatchObject({ expert_id: expertA, via: "afiliado" });
    expect(await credit(atMove)).toMatchObject({ expert_id: expertB, via: "afiliado" });
    expect(await credit(after)).toMatchObject({ expert_id: expertB, via: "afiliado" });
  });

  it("removing an id stops new affiliate credits but keeps past ones", async () => {
    const expert = await newExpert(TENANT_A, "Expert Remove Id", ["AFF-RM"]);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-RM" });
    const past = await deposit(TENANT_A, player, "2026-09-02T12:00:00Z");

    await resave(TENANT_A, expert, "Expert Remove Id", []);
    const rows = await history(TENANT_A, "AFF-RM");
    expect(rows).toHaveLength(1);
    expect(rows[0].valid_to).not.toBeNull();
    const removedAt = new Date(rows[0].valid_to!).toISOString();
    const afterRemoval = await deposit(TENANT_A, player, plusMs(removedAt, 60_000));

    await refresh(TENANT_A);

    expect(await credit(past)).toMatchObject({ expert_id: expert, via: "afiliado" });
    expect(await credit(afterRemoval)).toBeUndefined();
    const { rows: links } = await db.query(
      `select 1 from public.expert_affiliates where affiliate_id = 'AFF-RM'`,
    );
    expect(links).toHaveLength(0);
  });

  it("every expert_affiliates row has exactly one open history row", async () => {
    const { rows } = await db.query<{ missing: number }>(
      `select count(*)::int as missing from public.expert_affiliates ea
       where not exists (
         select 1 from public.expert_affiliate_history h
         where h.tenant_id = ea.tenant_id and h.affiliate_id = ea.affiliate_id
           and h.expert_id = ea.expert_id and h.valid_to is null)`,
    );
    expect(rows[0].missing).toBe(0);
  });
});

describe("deactivated profiles", () => {
  it("no click or affiliate credit for deposits at or after desativado_em", async () => {
    const off = await newExpert(TENANT_A, "Expert Desativado", ["AFF-OFF"]);
    const other = await newExpert(TENANT_A, "Expert Ativo Clique", []);
    await db.query(
      `update public.experts set ativo = false, desativado_em = '2026-09-10T00:00:00Z' where id = $1`,
      [off],
    );

    const player = await newPlayer(TENANT_A, { affiliate: "AFF-OFF" });
    const before = await deposit(TENANT_A, player, "2026-09-05T00:00:00Z");
    const atDeactivation = await deposit(TENANT_A, player, "2026-09-10T00:00:00Z");
    const afterAff = await deposit(TENANT_A, player, "2026-09-12T00:00:00Z");

    // Latest click is of the deactivated expert: skipped, the earlier click
    // of an active expert in the window wins instead.
    const p2 = await newPlayer(TENANT_A);
    const ldOther = await dispatch(TENANT_A, other, p2, "2026-09-14T00:00:00Z");
    await click(TENANT_A, ldOther, "2026-09-14T01:00:00Z");
    const ldOff = await dispatch(TENANT_A, off, p2, "2026-09-14T00:00:00Z");
    await click(TENANT_A, ldOff, "2026-09-14T02:00:00Z");
    const viaClick = await deposit(TENANT_A, p2, "2026-09-14T03:00:00Z");

    // A deposit before the deactivation still credits its click.
    const p3 = await newPlayer(TENANT_A);
    const ldEarly = await dispatch(TENANT_A, off, p3, "2026-09-08T00:00:00Z");
    await click(TENANT_A, ldEarly, "2026-09-08T01:00:00Z");
    const earlyClick = await deposit(TENANT_A, p3, "2026-09-08T02:00:00Z");

    await refresh(TENANT_A);

    expect(await credit(before)).toMatchObject({ expert_id: off, via: "afiliado" });
    expect(await credit(atDeactivation)).toBeUndefined();
    expect(await credit(afterAff)).toBeUndefined();
    expect(await credit(viaClick)).toMatchObject({ expert_id: other, via: "clique" });
    expect(await credit(earlyClick)).toMatchObject({ expert_id: off, via: "clique" });

    // Reactivated (desativado_em cleared): a later refresh credits again.
    await db.query(`update public.experts set ativo = true, desativado_em = null where id = $1`, [
      off,
    ]);
    await refresh(TENANT_A);
    expect(await credit(afterAff)).toMatchObject({ expert_id: off, via: "afiliado" });
  });

  it("no inactive profile is left without desativado_em by the migration", async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.experts where not ativo and desativado_em is null`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("ja_vinculado defaults to false and the migration backfills true for profiles with a user_id", async () => {
    const neverLinked = await newExpert(TENANT_A, "Nunca Vinculado", ["AFF-JV1"]);
    const { rows: fresh } = await db.query<{ ja_vinculado: boolean }>(
      `select ja_vinculado from public.experts where id = $1`,
      [neverLinked],
    );
    expect(fresh[0].ja_vinculado).toBe(false);

    // Simulates a profile that already had user_id before this migration ran:
    // the backfill (`update ... where user_id is not null`) must catch it.
    const { rows: authUser } = await db.query<{ id: string }>(
      `insert into auth.users (id) values (gen_random_uuid()) returning id`,
    );
    const linkedBefore = await newExpert(TENANT_A, "Ja Vinculado Antes", ["AFF-JV2"]);
    await db.query(`update public.experts set user_id = $2, ja_vinculado = false where id = $1`, [
      linkedBefore,
      authUser[0].id,
    ]);
    await db.query(`update public.experts set ja_vinculado = true where user_id is not null`);
    const { rows: backfilled } = await db.query<{ ja_vinculado: boolean }>(
      `select ja_vinculado from public.experts where id = $1`,
      [linkedBefore],
    );
    expect(backfilled[0].ja_vinculado).toBe(true);
  });
});

describe("delete_expert", () => {
  it("refuses a profile with credits (expert_has_credits) and the FK does not cascade", async () => {
    const expert = await newExpert(TENANT_A, "Expert Com Credito", ["AFF-DELC"]);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-DELC" });
    const dep = await deposit(TENANT_A, player, "2026-09-03T00:00:00Z");
    await refresh(TENANT_A);
    expect((await credit(dep))?.expert_id).toBe(expert);

    await expect(
      db.query(`select public.delete_expert($1, $2)`, [TENANT_A, expert]),
    ).rejects.toThrow(/expert_has_credits/);
    await expect(db.query(`delete from public.experts where id = $1`, [expert])).rejects.toThrow(
      /foreign key/,
    );
    expect((await credit(dep))?.expert_id).toBe(expert);
  });

  it("deletes a profile without credits, with its affiliate ids and history", async () => {
    const expert = await newExpert(TENANT_A, "Expert Sem Credito", ["AFF-DELN"]);
    await db.query(`select public.delete_expert($1, $2)`, [TENANT_A, expert]);
    const { rows } = await db.query(`select 1 from public.experts where id = $1`, [expert]);
    expect(rows).toHaveLength(0);
    expect(await history(TENANT_A, "AFF-DELN")).toEqual([]);
  });
});

describe("refresh_expert_credits_recent", () => {
  it("recent refresh skips demo houses and returns -1 when the lock is held", async () => {
    // Deposits relative to today's São Paulo date.
    const { rows } = await db.query<{ start: string }>(
      `select (((now() at time zone 'America/Sao_Paulo')::date - 1)::timestamp
               at time zone 'America/Sao_Paulo') as start`,
    );
    const yesterdayStart = new Date(rows[0].start).getTime();
    const at = (offsetMs: number) => new Date(yesterdayStart + offsetMs).toISOString();

    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    const justInside = await deposit(TENANT_A, player, at(30 * 60_000)); // yesterday 00:30 BRT
    const justOutside = await deposit(TENANT_A, player, at(-30 * 60_000)); // day before, 23:30 BRT
    const demoPlayer = await newPlayer(TENANT_DEMO, { affiliate: "AFF-DEMO" });
    const demoDep = await deposit(TENANT_DEMO, demoPlayer, at(30 * 60_000));

    const { rows: result } = await db.query<{ n: number }>(
      `select public.refresh_expert_credits_recent(1) as n`,
    );
    expect(result[0].n).toBe(0);
    expect((await credit(justInside))?.expert_id).toBe(expert1);
    expect(await credit(justOutside)).toBeUndefined();
    expect(await credit(demoDep)).toBeUndefined();
    // Sanity: the demo deposit would be credited by a direct refresh.
    await refresh(TENANT_DEMO);
    expect((await credit(demoDep))?.expert_id).toBe(expertDemo);

    // PGlite is a single session and advisory locks are re-entrant within a
    // session, so a lock held "elsewhere" cannot be simulated here. Assert
    // the function takes the documented try-lock and bails out with -1.
    const { rows: def } = await db.query<{ src: string }>(
      `select pg_get_functiondef('public.refresh_expert_credits_recent(integer)'::regprocedure) as src`,
    );
    expect(def[0].src).toMatch(
      /if not pg_try_advisory_xact_lock\(hashtext\('betleads\.refresh_expert_credits'\)::bigint\) then\s+return -1;/,
    );
  });
});

describe("access to expert tables", () => {
  const TABLES = [
    "expert_links",
    "expert_lead_contacts",
    "expert_lead_followups",
    "expert_lead_claims",
    "expert_message_templates",
    "expert_deposit_credits",
    "expert_settings",
    "expert_affiliate_history",
  ];

  async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      await db.query(
        `select set_config('test.uid', $1, true), set_config('test.tenant', $2, true)`,
        [uid, TENANT_A],
      );
      await db.exec("SET LOCAL ROLE authenticated");
      return await fn();
    } finally {
      await db.query("ROLLBACK");
    }
  }

  async function countAs(uid: string, table: string) {
    return asUser(uid, async () => {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where tenant_id = $1`,
        [TENANT_A],
      );
      return rows[0].n;
    });
  }

  it("authenticated cannot read expert tables as member, can as gestor via managed_tenant_ids", async () => {
    await db.query(
      `insert into public.user_roles (user_id, tenant_id, role) values ($1, $3, 'member'), ($2, $3, 'gestor')`,
      [MEMBER_USER, GESTOR_USER, TENANT_A],
    );
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-1" });
    await deposit(TENANT_A, player, "2026-10-07T10:00:00Z");
    await refresh(TENANT_A);
    await db.query(
      `insert into public.expert_settings (tenant_id, click_window_hours) values ($1, 48)`,
      [TENANT_A],
    );
    await db.query(
      `insert into public.expert_links
         (tenant_id, expert_id, player_id, oferta, original_url, sent_url, shortened)
       values ($1, $2, $3, 'Oferta', 'https://example.com', 'https://example.com', false)`,
      [TENANT_A, expert1, player],
    );
    await db.query(
      `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado)
       values ($1, $2, $3, 'chamei')`,
      [TENANT_A, expert1, player],
    );
    await db.query(
      `insert into public.expert_lead_followups (tenant_id, expert_id, player_id, due_date)
       values ($1, $2, $3, current_date)`,
      [TENANT_A, expert1, player],
    );
    await db.query(
      `insert into public.expert_lead_claims (tenant_id, player_id, expert_id, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [TENANT_A, player, expert1],
    );
    await db.query(
      `insert into public.expert_message_templates (tenant_id, expert_id, nome, conteudo)
       values ($1, $2, 'Modelo', 'Conteudo')`,
      [TENANT_A, expert1],
    );

    for (const table of TABLES) {
      expect({ table, n: await countAs(MEMBER_USER, table) }).toEqual({ table, n: 0 });
      const gestor = await countAs(GESTOR_USER, table);
      expect({ table, ok: gestor > 0 }).toEqual({ table, ok: true });
    }

    // No direct writes, even for a gestor.
    for (const sql of [
      `delete from public.expert_deposit_credits`,
      `update public.expert_settings set click_window_hours = 10`,
    ]) {
      await expect(asUser(GESTOR_USER, () => db.query(sql))).rejects.toThrow(/permission denied/);
    }
    // Only service_role runs the refresh functions.
    await expect(
      asUser(GESTOR_USER, () =>
        db.query(`select public.refresh_expert_credits($1, now(), now())`, [TENANT_A]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(GESTOR_USER, () => db.query(`select public.refresh_expert_credits_recent(1)`)),
    ).rejects.toThrow(/permission denied/);
  });
});
