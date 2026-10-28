// Per-expert metrics and daily series — SQL tests for
// supabase/migrations/20261104100100_expert_metrics.sql
//
// Runs the expert migrations (phases 1, 2 and the Task 1 credits migration)
// plus the new one inside an in-memory Postgres (PGlite), reusing the
// minimal schema from expert-credits.db.test.ts (deposits, click_events,
// gamification_settings, link_dispatches, a managed_tenant_ids() identical
// to production). Asserts expert_metrics' per-expert aggregation (split by
// via, distinct depositors, reativacoes/ftds, links/clicks/contacts inside
// the period only, zero rows for idle/inactive experts, a deleted expert
// disappearing together with its credits) and expert_metrics_daily's São
// Paulo day series with gaps filled with zeros. Both functions are
// service_role only.

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
  "20261104100100_expert_metrics.sql",
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

const ALL_FROM = "2020-01-01T00:00:00Z";
const ALL_TO = "2030-01-01T00:00:00Z";

let db: PGlite;

async function newExpert(tenant: string, nome: string, affiliates: string[] = []) {
  const { rows } = await db.query<{ id: string }>(
    `select save_expert($1, null, $2, 'total', $3, 'livre', null, 1) as id`,
    [tenant, nome, affiliates],
  );
  return rows[0].id;
}

/** Links the expert's current affiliate ids long before the test deposits. */
async function backdateAffiliates(expert: string) {
  await db.query(
    `update public.expert_affiliates set created_at = '2025-01-01T00:00:00Z' where expert_id = $1`,
    [expert],
  );
  await db.query(
    `update public.expert_affiliate_history set valid_from = '2025-01-01T00:00:00Z'
     where expert_id = $1 and valid_to is null`,
    [expert],
  );
}

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

async function refreshCredits(tenant: string, from = ALL_FROM, to = ALL_TO) {
  await db.query(`select public.refresh_expert_credits($1, $2, $3)`, [tenant, from, to]);
}

type MetricsRow = {
  expert_id: string;
  depositado: string;
  depositado_clique: string;
  depositado_afiliado: string;
  depositos: number;
  depositantes: number;
  reativacoes: number;
  ftds: number;
  links: number;
  cliques: number;
  contatos: number;
};

async function metrics(tenant: string, from = ALL_FROM, to = ALL_TO) {
  const { rows } = await db.query<MetricsRow>(`select * from public.expert_metrics($1, $2, $3)`, [
    tenant,
    from,
    to,
  ]);
  return rows;
}

async function metricsFor(tenant: string, expertId: string, from = ALL_FROM, to = ALL_TO) {
  return (await metrics(tenant, from, to)).find((r) => r.expert_id === expertId);
}

type DailyRow = {
  dia: string;
  depositado: string;
  depositado_clique: string;
  depositado_afiliado: string;
  cliques: number;
};

async function dailySeries(tenant: string, expertId: string, from: string, to: string) {
  const { rows } = await db.query<DailyRow>(
    `select * from public.expert_metrics_daily($1, $2, $3, $4)`,
    [tenant, expertId, from, to],
  );
  return rows;
}

async function addLink(tenant: string, expertId: string, playerId: string, at: string) {
  await db.query(
    `insert into public.expert_links
       (tenant_id, expert_id, player_id, oferta, original_url, sent_url, shortened, created_at)
     values ($1, $2, $3, 'Oferta', 'https://example.com', 'https://example.com', false, $4)`,
    [tenant, expertId, playerId, at],
  );
}

async function addContact(tenant: string, expertId: string, playerId: string, at: string) {
  await db.query(
    `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado, created_at)
     values ($1, $2, $3, 'chamei', $4)`,
    [tenant, expertId, playerId, at],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.query(`insert into public.tenants (id, nome, is_demo) values ($1, 'Casa A', false)`, [
    TENANT_A,
  ]);
  for (const name of MIGRATIONS) await db.exec(migration(name));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("expert_metrics", () => {
  it("sums credits per expert split by via, counts distinct depositors, reativacoes and ftds", async () => {
    const expert = await newExpert(TENANT_A, "Expert Métricas", ["AFF-MET"]);
    await db.query(`update public.experts set created_at = '2025-01-01T00:00:00Z' where id = $1`, [
      expert,
    ]);
    await backdateAffiliates(expert);

    // Player A: clicks + two deposits (first FTD, second not).
    const playerA = await newPlayer(TENANT_A);
    const ldA = await dispatch(TENANT_A, expert, playerA, "2026-05-01T00:00:00Z");
    await click(TENANT_A, ldA, "2026-05-01T00:30:00Z");
    const depA1 = await deposit(TENANT_A, playerA, "2026-05-01T01:00:00Z", { valor: 150 });
    await click(TENANT_A, ldA, "2026-05-02T00:30:00Z");
    const depA2 = await deposit(TENANT_A, playerA, "2026-05-02T01:00:00Z", { valor: 50 });

    // Player B: via affiliate, deposit far enough apart to be a reativação
    // (default sleeping_after_days = 7).
    const playerB = await newPlayer(TENANT_A, { affiliate: "AFF-MET" });
    const depB1 = await deposit(TENANT_A, playerB, "2026-05-01T00:00:00Z", { valor: 200 });
    const depB2 = await deposit(TENANT_A, playerB, "2026-05-20T00:00:00Z", { valor: 300 });

    await refreshCredits(TENANT_A);

    const row = await metricsFor(TENANT_A, expert);
    expect(row).toBeDefined();
    expect(Number(row!.depositado)).toBe(150 + 50 + 200 + 300);
    expect(Number(row!.depositado_clique)).toBe(150 + 50);
    expect(Number(row!.depositado_afiliado)).toBe(200 + 300);
    expect(row!.depositos).toBe(4);
    expect(row!.depositantes).toBe(2);
    expect(row!.ftds).toBe(2); // depA1 and depB1 are each player's first approved deposit
    expect(row!.reativacoes).toBe(1); // depB2, 19 days after depB1
    void depA2;
    void depB2;
  });

  it("returns zero rows for experts without activity, including inactive ones", async () => {
    const idle = await newExpert(TENANT_A, "Expert Ocioso");
    await db.query(`update public.experts set ativo = false where id = $1`, [idle]);

    const row = await metricsFor(TENANT_A, idle);
    expect(row).toMatchObject({
      depositos: 0,
      depositantes: 0,
      reativacoes: 0,
      ftds: 0,
      links: 0,
      cliques: 0,
      contatos: 0,
    });
    expect(Number(row!.depositado)).toBe(0);
    expect(Number(row!.depositado_clique)).toBe(0);
    expect(Number(row!.depositado_afiliado)).toBe(0);
  });

  it("counts links, human clicks and contacts inside the period only", async () => {
    const expert = await newExpert(TENANT_A, "Expert Periodo");
    const player = await newPlayer(TENANT_A);

    await addLink(TENANT_A, expert, player, "2026-06-01T00:00:00Z"); // before
    await addLink(TENANT_A, expert, player, "2026-06-10T00:00:00Z"); // inside
    await addLink(TENANT_A, expert, player, "2026-06-20T00:00:00Z"); // after

    await addContact(TENANT_A, expert, player, "2026-06-01T00:00:00Z"); // before
    await addContact(TENANT_A, expert, player, "2026-06-11T00:00:00Z"); // inside
    await addContact(TENANT_A, expert, player, "2026-06-20T00:00:00Z"); // after

    const ld = await dispatch(TENANT_A, expert, player, "2026-06-01T00:00:00Z");
    await click(TENANT_A, ld, "2026-06-01T00:00:00Z"); // before
    await click(TENANT_A, ld, "2026-06-12T00:00:00Z"); // inside
    await click(TENANT_A, ld, "2026-06-12T01:00:00Z", false); // inside, but bot
    await click(TENANT_A, ld, "2026-06-20T00:00:00Z"); // after

    const row = await metricsFor(TENANT_A, expert, "2026-06-05T00:00:00Z", "2026-06-15T00:00:00Z");
    expect(row).toMatchObject({ links: 1, contatos: 1, cliques: 1 });
  });

  it("an expert with credits cannot be deleted; without credits it disappears from the metrics", async () => {
    const expert = await newExpert(TENANT_A, "Expert Removido", ["AFF-DEL"]);
    await db.query(`update public.experts set created_at = '2025-01-01T00:00:00Z' where id = $1`, [
      expert,
    ]);
    await backdateAffiliates(expert);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-DEL" });
    await deposit(TENANT_A, player, "2026-07-01T00:00:00Z", { valor: 500 });
    await refreshCredits(TENANT_A);
    expect(await metricsFor(TENANT_A, expert)).toBeDefined();

    // The credits are the commission history: no cascade, delete_expert refuses.
    await expect(db.query(`delete from public.experts where id = $1`, [expert])).rejects.toThrow(
      /foreign key/,
    );
    await expect(
      db.query(`select public.delete_expert($1, $2)`, [TENANT_A, expert]),
    ).rejects.toThrow(/expert_has_credits/);
    expect(await metricsFor(TENANT_A, expert)).toBeDefined();

    const empty = await newExpert(TENANT_A, "Expert Sem Creditos");
    expect(await metricsFor(TENANT_A, empty)).toBeDefined();
    await db.query(`select public.delete_expert($1, $2)`, [TENANT_A, empty]);
    expect(await metricsFor(TENANT_A, empty)).toBeUndefined();
  });

  it("authenticated cannot execute the metric functions", async () => {
    async function asAuthenticated(sql: string) {
      await db.query("BEGIN");
      try {
        await db.exec("SET LOCAL ROLE authenticated");
        await db.query(sql, [TENANT_A]);
      } finally {
        await db.query("ROLLBACK");
      }
    }

    await expect(asAuthenticated(`select public.expert_metrics($1, now(), now())`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asAuthenticated(`select public.expert_metrics_daily($1, $1, now(), now())`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("expert_metrics_daily", () => {
  it("fills missing São Paulo days with zeros", async () => {
    const expert = await newExpert(TENANT_A, "Expert Serie", ["AFF-SERIE"]);
    await db.query(`update public.experts set created_at = '2025-01-01T00:00:00Z' where id = $1`, [
      expert,
    ]);
    await backdateAffiliates(expert);
    const player = await newPlayer(TENANT_A, { affiliate: "AFF-SERIE" });
    // 00:30 BRT on 2026-08-02 is 03:30 UTC; falls on the 08-02 São Paulo day.
    await deposit(TENANT_A, player, "2026-08-02T03:30:00Z", { valor: 70 });
    // 2026-08-04, no movement on 08-03.
    await deposit(TENANT_A, player, "2026-08-04T12:00:00Z", { valor: 30 });
    await refreshCredits(TENANT_A);

    const ld = await dispatch(TENANT_A, expert, player, "2026-08-01T00:00:00Z");
    await click(TENANT_A, ld, "2026-08-02T12:00:00Z");
    await click(TENANT_A, ld, "2026-08-02T13:00:00Z");

    // São Paulo 2026-08-01 00:00 to 2026-08-05 00:00 (4 days: 01, 02, 03, 04).
    const from = "2026-08-01T03:00:00Z";
    const to = "2026-08-05T03:00:00Z";
    const series = await dailySeries(TENANT_A, expert, from, to);

    const toDay = (d: string) => new Date(d).toISOString().slice(0, 10);
    expect(series.map((r) => toDay(r.dia))).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(series[0]).toMatchObject({ cliques: 0 });
    expect(Number(series[0].depositado)).toBe(0);
    expect(series[1]).toMatchObject({ cliques: 2 });
    expect(Number(series[1].depositado)).toBe(70);
    expect(Number(series[1].depositado_afiliado)).toBe(70);
    expect(series[2]).toMatchObject({ cliques: 0 });
    expect(Number(series[2].depositado)).toBe(0);
    expect(series[3]).toMatchObject({ cliques: 0 });
    expect(Number(series[3].depositado)).toBe(30);
  });
});
