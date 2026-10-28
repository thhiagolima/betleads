// Relatório de rendimento — SQL tests for
// supabase/migrations/20261106153000_expert_report.sql and
// supabase/migrations/20261106153100_expert_portfolio.sql
//
// Runs the expert migrations (phases 1, 2 and 3) plus the two new ones inside
// an in-memory Postgres (PGlite), against the minimal schema of
// expert-credits.db.test.ts (players gain nome/telefone). Credits are always
// built by refresh_expert_credits, never inserted by hand, so the report,
// the portfolio and the lead timeline are checked against the real rule.

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
  "20261105143000_expert_credits.sql",
  "20261105143100_expert_metrics.sql",
  "20261106153000_expert_report.sql",
  "20261106153100_expert_portfolio.sql",
];

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (
  id uuid primary key
);
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
  nome text not null default 'Lead',
  telefone text,
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

alter default privileges in schema public grant all on tables to authenticated;
`;

const ALL_FROM = "2020-01-01T00:00:00Z";
const ALL_TO = "2030-01-01T00:00:00Z";
// São Paulo September 2026: [09-01 00:00, 10-01 00:00) BRT.
const SEP_FROM = "2026-09-01T03:00:00Z";
const SEP_TO = "2026-10-01T03:00:00Z";

let db: PGlite;

async function newTenant() {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.tenants (nome) values ('Casa') returning id`,
  );
  return rows[0].id;
}

async function newExpert(
  tenant: string,
  nome: string,
  affiliates: string[] = [],
  opts: { createdAt?: string; affiliateSince?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `select save_expert($1, null, $2, 'total', $3, 'livre', null, 1) as id`,
    [tenant, nome, affiliates],
  );
  const id = rows[0].id;
  await db.query(`update public.experts set created_at = $2 where id = $1`, [
    id,
    opts.createdAt ?? "2025-01-01T00:00:00Z",
  ]);
  await db.query(
    `update public.expert_affiliate_history set valid_from = $2
     where expert_id = $1 and valid_to is null`,
    [id, opts.affiliateSince ?? "2025-01-01T00:00:00Z"],
  );
  return id;
}

async function newPlayer(
  tenant: string,
  opts: { nome?: string; telefone?: string; affiliate?: string; ftdEm?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.players (tenant_id, nome, telefone, affiliate_id, ftd_em)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      tenant,
      opts.nome ?? "Lead",
      opts.telefone ?? null,
      opts.affiliate ?? null,
      opts.ftdEm ?? null,
    ],
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

/** A link of the expert to the lead: the dispatch plus its expert_links row. */
async function sendLink(tenant: string, expert: string, player: string, at: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.link_dispatches
       (tenant_id, source_type, source_id, recipient_player_id, send_status, sent_at)
     values ($1, 'expert', $2, $3, 'sent', $4) returning id`,
    [tenant, expert, player, at],
  );
  const ld = rows[0].id;
  await db.query(
    `insert into public.expert_links
       (tenant_id, expert_id, player_id, link_dispatch_id, oferta, original_url, sent_url, shortened, created_at)
     values ($1, $2, $3, $4, 'Bônus 100%', 'https://casa.test/x', 'https://s.test/x', true, $5)`,
    [tenant, expert, player, ld, at],
  );
  return ld;
}

async function click(tenant: string, dispatchId: string, at: string, human = true) {
  await db.query(
    `insert into public.click_events (tenant_id, link_dispatch_id, occurred_at, is_human)
     values ($1, $2, $3, $4)`,
    [tenant, dispatchId, at, human],
  );
}

async function contact(
  tenant: string,
  expert: string,
  player: string,
  at: string,
  resultado = "respondeu",
  nota: string | null = null,
) {
  await db.query(
    `insert into public.expert_lead_contacts (tenant_id, expert_id, player_id, resultado, nota, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [tenant, expert, player, resultado, nota, at],
  );
}

async function refresh(tenant: string) {
  await db.query(`select public.refresh_expert_credits($1, $2, $3)`, [tenant, ALL_FROM, ALL_TO]);
}

type ReportRow = {
  depositado: string;
  depositado_clique: string;
  depositado_afiliado: string;
  ftds: number;
  valor_ftd: string;
  redepositos: number;
  valor_redeposito: string;
  reativados: number;
  depositantes: number;
  links: number;
  leads_com_link: number;
  leads_clicaram: number;
  leads_depositaram_clique: number;
  contatos: number;
};

async function report(tenant: string, expert: string, from = SEP_FROM, to = SEP_TO) {
  const { rows } = await db.query<ReportRow>(`select * from public.expert_report($1, $2, $3, $4)`, [
    tenant,
    expert,
    from,
    to,
  ]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

type PortfolioRow = {
  player_id: string;
  nome: string;
  telefone: string | null;
  creditado: string;
  depositos: number;
  origem: string;
  primeiro_credito: string;
  ultimo_deposito: string | null;
  ultimo_contato_resultado: string | null;
  ultimo_contato_em: string | null;
  tem_ftd: boolean;
  reativado: boolean;
  total_count: string;
};

async function portfolio(
  tenant: string,
  expert: string,
  opts: {
    from?: string;
    to?: string;
    search?: string | null;
    onlyFtd?: boolean;
    onlyReativados?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  const { rows } = await db.query<PortfolioRow>(
    `select * from public.expert_portfolio($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenant,
      expert,
      opts.from ?? SEP_FROM,
      opts.to ?? SEP_TO,
      opts.search ?? null,
      opts.onlyFtd ?? false,
      opts.onlyReativados ?? false,
      opts.limit ?? 50,
      opts.offset ?? 0,
    ],
  );
  return rows;
}

type TimelineRow = {
  at: string;
  kind: string;
  titulo: string;
  detalhe: string | null;
  valor: string | null;
  status: string | null;
};

async function timeline(
  tenant: string,
  expert: string,
  player: string,
  before: string | null = null,
  limit = 100,
) {
  const { rows } = await db.query<TimelineRow>(
    `select * from public.expert_lead_timeline($1, $2, $3, $4, $5)`,
    [tenant, expert, player, before, limit],
  );
  return rows;
}

const iso = (d: string | Date) => new Date(d).toISOString();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  for (const name of MIGRATIONS) await db.exec(migration(name));
}, 60_000);

afterAll(async () => {
  await db.close();
});

/**
 * September 2026 of one expert (affiliate AFF-E, 72 h window):
 * - p1: link 09-01 10:00, click 11:00, FTD 100 at 12:00 (clique), redeposit
 *   50 on 09-03 (still inside the 72 h of the click → clique);
 * - p2 (AFF-E): FTD 200 on 09-02 (afiliado), redeposit 30 on 09-20, 18 days
 *   later (afiliado, reactivation);
 * - p3: link 09-05, a human and a bot click, no deposit;
 * - p4: link 09-06, no click;
 * - one contact with p1.
 */
async function septemberScenario() {
  const tenant = await newTenant();
  const expert = await newExpert(tenant, "Expert Setembro", ["AFF-E"]);
  const p1 = await newPlayer(tenant, { nome: "Ana" });
  const p2 = await newPlayer(tenant, { nome: "Bruno", affiliate: "AFF-E" });
  const p3 = await newPlayer(tenant, { nome: "Carla" });
  const p4 = await newPlayer(tenant, { nome: "Davi" });

  const ld1 = await sendLink(tenant, expert, p1, "2026-09-01T10:00:00Z");
  await click(tenant, ld1, "2026-09-01T11:00:00Z");
  await deposit(tenant, p1, "2026-09-01T12:00:00Z", { valor: 100 });
  await deposit(tenant, p1, "2026-09-03T12:00:00Z", { valor: 50 });

  await deposit(tenant, p2, "2026-09-02T12:00:00Z", { valor: 200 });
  await deposit(tenant, p2, "2026-09-20T12:00:00Z", { valor: 30 });

  const ld3 = await sendLink(tenant, expert, p3, "2026-09-05T10:00:00Z");
  await click(tenant, ld3, "2026-09-05T11:00:00Z");
  await click(tenant, ld3, "2026-09-05T11:01:00Z", false);
  await sendLink(tenant, expert, p4, "2026-09-06T10:00:00Z");

  await contact(tenant, expert, p1, "2026-09-02T15:00:00Z");

  // Outside the period: must not count.
  await deposit(tenant, p2, "2026-10-05T12:00:00Z", { valor: 999 });
  await sendLink(tenant, expert, p4, "2026-10-06T10:00:00Z");

  await refresh(tenant);
  return { tenant, expert, p1, p2, p3, p4 };
}

describe("expert_report", () => {
  it("expert_report splits ftd/redeposit values and counts depositors, links, clicked and click-converted leads", async () => {
    const { tenant, expert } = await septemberScenario();
    const r = await report(tenant, expert);

    expect(Number(r.depositado)).toBe(380);
    expect(Number(r.depositado_clique)).toBe(150);
    expect(Number(r.depositado_afiliado)).toBe(230);
    expect(r.ftds).toBe(2);
    expect(Number(r.valor_ftd)).toBe(300);
    expect(r.redepositos).toBe(2);
    expect(Number(r.valor_redeposito)).toBe(80);
    expect(r.reativados).toBe(1);
    expect(r.depositantes).toBe(2);
    expect(r.links).toBe(3);
    expect(r.leads_com_link).toBe(3);
    expect(r.leads_clicaram).toBe(2);
    expect(r.leads_depositaram_clique).toBe(1);
    expect(r.contatos).toBe(1);

    // An empty period is one row of zeros.
    const empty = await report(tenant, expert, "2026-01-01T03:00:00Z", "2026-02-01T03:00:00Z");
    expect(Number(empty.depositado)).toBe(0);
    expect(empty).toMatchObject({ ftds: 0, links: 0, leads_clicaram: 0, contatos: 0 });

    // Another house sees nothing of this expert.
    const other = await newTenant();
    const fromOther = await report(other, expert);
    expect(Number(fromOther.depositado)).toBe(0);
    expect(fromOther.links).toBe(0);
  });

  it("report total equals the sum of the portfolio creditado for the same period", async () => {
    const { tenant, expert } = await septemberScenario();
    const r = await report(tenant, expert);
    const rows = await portfolio(tenant, expert);
    const { rows: extrato } = await db.query<{ total: string }>(
      `select coalesce(sum(valor), 0) total from public.expert_deposit_credits
       where tenant_id = $1 and expert_id = $2 and deposit_at >= $3 and deposit_at < $4`,
      [tenant, expert, SEP_FROM, SEP_TO],
    );
    const sum = rows.reduce((acc, row) => acc + Number(row.creditado), 0);
    expect(sum).toBe(Number(r.depositado));
    expect(Number(extrato[0].total)).toBe(Number(r.depositado));
    expect(rows.reduce((acc, row) => acc + row.depositos, 0)).toBe(r.ftds + r.redepositos);
  });

  it("expert_report_daily fills São Paulo days with zeros", async () => {
    const { tenant, expert } = await septemberScenario();
    // São Paulo 09-01 00:00 to 09-05 00:00 (4 days).
    const { rows } = await db.query<{
      dia: string;
      valor_ftd: string;
      valor_redeposito: string;
      depositantes: number;
    }>(`select * from public.expert_report_daily($1, $2, $3, $4)`, [
      tenant,
      expert,
      SEP_FROM,
      "2026-09-05T03:00:00Z",
    ]);
    expect(rows.map((r) => iso(r.dia).slice(0, 10))).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    expect(
      rows.map((r) => [Number(r.valor_ftd), Number(r.valor_redeposito), r.depositantes]),
    ).toEqual([
      [100, 0, 1],
      [200, 0, 1],
      [0, 50, 1],
      [0, 0, 0],
    ]);

    // 23:30 BRT on 09-04 is 02:30 UTC on 09-05: still the 09-04 São Paulo day.
    const late = await newPlayer(tenant, { affiliate: "AFF-E" });
    await deposit(tenant, late, "2026-09-05T02:30:00Z", { valor: 10 });
    await refresh(tenant);
    const { rows: again } = await db.query<{ dia: string; valor_ftd: string }>(
      `select * from public.expert_report_daily($1, $2, $3, $4)`,
      [tenant, expert, SEP_FROM, "2026-09-05T03:00:00Z"],
    );
    expect(Number(again[3].valor_ftd)).toBe(10);
  });
});

describe("expert_team_report", () => {
  it("expert_team_report has one row per profile including inactive with zeros", async () => {
    const { tenant, expert } = await septemberScenario();
    const idle = await newExpert(tenant, "Expert Parado");
    const inactive = await newExpert(tenant, "Expert Inativo");
    await db.query(
      `update public.experts set ativo = false, desativado_em = '2026-08-01T00:00:00Z' where id = $1`,
      [inactive],
    );
    // A profile of another house does not show up.
    await newExpert(await newTenant(), "Expert Outra Casa");

    const { rows } = await db.query<{
      expert_id: string;
      depositado: string;
      ftds: number;
      redepositos: number;
      reativados: number;
      leads_clicaram: number;
      leads_depositaram_clique: number;
      depositos: number;
    }>(`select * from public.expert_team_report($1, $2, $3)`, [tenant, SEP_FROM, SEP_TO]);

    expect(rows.map((r) => r.expert_id).sort()).toEqual([expert, idle, inactive].sort());
    const main = rows.find((r) => r.expert_id === expert)!;
    expect(Number(main.depositado)).toBe(380);
    expect(main).toMatchObject({
      ftds: 2,
      redepositos: 2,
      reativados: 1,
      leads_clicaram: 2,
      leads_depositaram_clique: 1,
      depositos: 4,
    });
    for (const id of [idle, inactive]) {
      const row = rows.find((r) => r.expert_id === id)!;
      expect(Number(row.depositado)).toBe(0);
      expect(row).toMatchObject({
        ftds: 0,
        redepositos: 0,
        reativados: 0,
        leads_clicaram: 0,
        leads_depositaram_clique: 0,
        depositos: 0,
      });
    }

    // Same click→deposit numbers as the individual report.
    const r = await report(tenant, expert);
    expect([r.leads_clicaram, r.leads_depositaram_clique]).toEqual([
      main.leads_clicaram,
      main.leads_depositaram_clique,
    ]);
  });
});

describe("house_deposit_totals / expert_last_computed_at", () => {
  it("house_deposit_totals counts approved deposits and FTDs of the whole house", async () => {
    const tenant = await newTenant();
    const a = await newPlayer(tenant);
    const b = await newPlayer(tenant, { ftdEm: "2026-01-01T00:00:00Z" }); // FTD long before
    const c = await newPlayer(tenant);
    const d = await newPlayer(tenant, { ftdEm: "2026-09-10T11:55:00Z" }); // 5 min before
    // a: FTD in the period plus a redeposit.
    await deposit(tenant, a, "2026-09-02T12:00:00Z", { valor: 100 });
    await deposit(tenant, a, "2026-09-03T12:00:00Z", { valor: 40 });
    // b: first approved deposit, but ftd_em is far older → not an FTD.
    await deposit(tenant, b, "2026-09-04T12:00:00Z", { valor: 10 });
    // c: approved before the period → its September deposit is no FTD;
    // a pending deposit is ignored.
    await deposit(tenant, c, "2026-08-20T12:00:00Z", { valor: 500 });
    await deposit(tenant, c, "2026-09-05T12:00:00Z", { valor: 20 });
    await deposit(tenant, c, "2026-09-06T12:00:00Z", { valor: 900, status: "pendente" });
    // d: FTD (ftd_em within 10 minutes).
    await deposit(tenant, d, "2026-09-10T12:00:00Z", { valor: 7 });
    // Another house is not counted.
    const other = await newTenant();
    await deposit(other, await newPlayer(other), "2026-09-02T12:00:00Z", { valor: 1000 });

    const { rows } = await db.query<{ depositado: string; ftds: number }>(
      `select * from public.house_deposit_totals($1, $2, $3)`,
      [tenant, SEP_FROM, SEP_TO],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].depositado)).toBe(177);
    expect(rows[0].ftds).toBe(2);

    const { rows: none } = await db.query<{ depositado: string; ftds: number }>(
      `select * from public.house_deposit_totals($1, $2, $3)`,
      [tenant, "2026-01-01T03:00:00Z", "2026-02-01T03:00:00Z"],
    );
    expect(Number(none[0].depositado)).toBe(0);
    expect(none[0].ftds).toBe(0);
  });

  it("expert_last_computed_at is the latest computed_at of the house, or null", async () => {
    const { tenant } = await septemberScenario();
    await db.query(
      `update public.expert_deposit_credits set computed_at = '2026-09-30T10:00:00Z' where tenant_id = $1`,
      [tenant],
    );
    await db.query(
      `update public.expert_deposit_credits set computed_at = '2026-09-30T10:10:00Z'
       where deposit_id = (select deposit_id from public.expert_deposit_credits where tenant_id = $1 limit 1)`,
      [tenant],
    );
    const { rows } = await db.query<{ at: string | null }>(
      `select public.expert_last_computed_at($1) as at`,
      [tenant],
    );
    expect(iso(rows[0].at!)).toBe("2026-09-30T10:10:00.000Z");

    const { rows: empty } = await db.query<{ at: string | null }>(
      `select public.expert_last_computed_at($1) as at`,
      [await newTenant()],
    );
    expect(empty[0].at).toBeNull();
  });
});

describe("expert_portfolio", () => {
  it("portfolio filters only_ftd / only_reativados, paginates with total_count and escapes % _ in search", async () => {
    const tenant = await newTenant();
    const expert = await newExpert(tenant, "Expert Carteira", ["AFF-C"]);
    const other = await newExpert(tenant, "Outro Expert");
    // FTD in September, a contact of the expert and one of someone else.
    const ftd = await newPlayer(tenant, {
      nome: "Ana 100%",
      telefone: "+5511999990001",
      affiliate: "AFF-C",
    });
    await deposit(tenant, ftd, "2026-09-02T12:00:00Z", { valor: 300 });
    await contact(tenant, expert, ftd, "2026-09-03T12:00:00Z", "prometeu_depositar");
    await contact(tenant, expert, ftd, "2026-09-01T12:00:00Z", "chamei");
    await contact(tenant, other, ftd, "2026-09-04T12:00:00Z", "sem_interesse");
    // A later deposit outside the period counts only as ultimo_deposito.
    await deposit(tenant, ftd, "2026-10-10T12:00:00Z", { valor: 1 });
    // Reactivated in September, first credit back in July.
    const sleeper = await newPlayer(tenant, {
      nome: "Bruno_x",
      telefone: "+5511999990002",
      affiliate: "AFF-C",
    });
    await deposit(tenant, sleeper, "2026-07-01T12:00:00Z", { valor: 50 });
    await deposit(tenant, sleeper, "2026-09-05T12:00:00Z", { valor: 200 });
    // Both origins: affiliate deposit, then a click deposit.
    const both = await newPlayer(tenant, {
      nome: "Carla",
      telefone: "+5511999990003",
      affiliate: "AFF-C",
    });
    await deposit(tenant, both, "2026-08-01T12:00:00Z", { valor: 5 });
    await deposit(tenant, both, "2026-09-06T12:00:00Z", { valor: 60 });
    const ld = await sendLink(tenant, expert, both, "2026-09-07T10:00:00Z");
    await click(tenant, ld, "2026-09-07T11:00:00Z");
    await deposit(tenant, both, "2026-09-07T12:00:00Z", { valor: 40 });
    // Credited to the other expert only: not in this portfolio.
    const foreign = await newPlayer(tenant, { nome: "Davi%" });
    const ldo = await sendLink(tenant, other, foreign, "2026-09-08T10:00:00Z");
    await click(tenant, ldo, "2026-09-08T11:00:00Z");
    await deposit(tenant, foreign, "2026-09-08T12:00:00Z", { valor: 1000 });
    await refresh(tenant);

    const all = await portfolio(tenant, expert);
    expect(all.map((r) => r.player_id)).toEqual([ftd, sleeper, both]);
    expect(all.map((r) => Number(r.total_count))).toEqual([3, 3, 3]);

    const [a, b, c] = all;
    expect(a).toMatchObject({
      nome: "Ana 100%",
      telefone: "+5511999990001",
      depositos: 1,
      origem: "afiliado",
      tem_ftd: true,
      reativado: false,
      ultimo_contato_resultado: "prometeu_depositar",
    });
    expect(Number(a.creditado)).toBe(300);
    expect(iso(a.ultimo_contato_em!)).toBe("2026-09-03T12:00:00.000Z");
    expect(iso(a.primeiro_credito)).toBe("2026-09-02T12:00:00.000Z");
    expect(iso(a.ultimo_deposito!)).toBe("2026-10-10T12:00:00.000Z");

    expect(b).toMatchObject({ depositos: 1, origem: "afiliado", tem_ftd: false, reativado: true });
    expect(iso(b.primeiro_credito)).toBe("2026-07-01T12:00:00.000Z");
    expect(b.ultimo_contato_resultado).toBeNull();
    expect(b.ultimo_contato_em).toBeNull();

    expect(c).toMatchObject({ depositos: 2, origem: "ambos", tem_ftd: false, reativado: true });
    expect(Number(c.creditado)).toBe(100);
    expect(iso(c.primeiro_credito)).toBe("2026-08-01T12:00:00.000Z");

    expect((await portfolio(tenant, expert, { onlyFtd: true })).map((r) => r.player_id)).toEqual([
      ftd,
    ]);
    expect(
      (await portfolio(tenant, expert, { onlyReativados: true })).map((r) => r.player_id),
    ).toEqual([sleeper, both]);

    const page2 = await portfolio(tenant, expert, { limit: 2, offset: 2 });
    expect(page2.map((r) => r.player_id)).toEqual([both]);
    expect(Number(page2[0].total_count)).toBe(3);
    const page1 = await portfolio(tenant, expert, { limit: 2, offset: 0 });
    expect(page1.map((r) => r.player_id)).toEqual([ftd, sleeper]);

    // % and _ are literal characters, not wildcards.
    expect((await portfolio(tenant, expert, { search: "%" })).map((r) => r.player_id)).toEqual([
      ftd,
    ]);
    expect((await portfolio(tenant, expert, { search: "_" })).map((r) => r.player_id)).toEqual([
      sleeper,
    ]);
    expect(await portfolio(tenant, expert, { search: "\\" })).toEqual([]);
    expect((await portfolio(tenant, expert, { search: "bruno" })).map((r) => r.player_id)).toEqual([
      sleeper,
    ]);
    expect((await portfolio(tenant, expert, { search: "0003" })).map((r) => r.player_id)).toEqual([
      both,
    ]);
    expect(await portfolio(tenant, expert, { search: "   " })).toHaveLength(3);
    expect(await portfolio(tenant, expert, { search: "Davi" })).toEqual([]);
  });
});

describe("expert_lead_timeline", () => {
  /**
   * Walks the timeline with _before = at of the last item of each page. A
   * page may exceed the limit only by items tied with its last timestamp.
   */
  async function walkPages(tenant: string, expert: string, lead: string, limit: number) {
    const seen: string[] = [];
    let before: string | null = null;
    for (;;) {
      const page = await timeline(tenant, expert, lead, before, limit);
      if (page.length === 0) break;
      const lastAt = iso(page[page.length - 1].at);
      for (const extra of page.slice(limit)) expect(iso(extra.at)).toBe(lastAt);
      seen.push(...page.map((r) => `${iso(r.at)} ${r.kind}`));
      before = page[page.length - 1].at;
    }
    return seen;
  }

  /**
   * House with a 24 h window. Expert X registered 2026-02-01, owns AFF-X
   * from 2026-03-01 and is deactivated on 2026-06-01; Y is another expert.
   */
  async function timelineHouse() {
    const tenant = await newTenant();
    await db.query(
      `insert into public.expert_settings (tenant_id, click_window_hours) values ($1, 24)`,
      [tenant],
    );
    const x = await newExpert(tenant, "Expert X", ["AFF-X"], {
      createdAt: "2026-02-01T00:00:00Z",
      affiliateSince: "2026-03-01T00:00:00Z",
    });
    const y = await newExpert(tenant, "Expert Y");
    await db.query(
      `update public.experts set desativado_em = '2026-06-01T00:00:00Z' where id = $1`,
      [x],
    );
    return { tenant, x, y };
  }

  it("timeline marks deposits as creditado with click reason, outra_pessoa, and nao_creditado with the right reason", async () => {
    const { tenant, x, y } = await timelineHouse();

    // l1: click credit, then another expert's credit, then no click.
    const l1 = await newPlayer(tenant);
    const ld1 = await sendLink(tenant, x, l1, "2026-04-01T10:00:00Z");
    await click(tenant, ld1, "2026-04-01T10:30:00Z");
    await click(tenant, ld1, "2026-04-01T10:40:00Z", false); // bot: not in the timeline
    await deposit(tenant, l1, "2026-04-01T11:00:00Z", { valor: 100 });
    await contact(tenant, x, l1, "2026-04-02T12:00:00Z", "respondeu", "Disse que volta amanhã");
    await contact(tenant, y, l1, "2026-04-03T12:00:00Z", "chamei", "Nota do Y"); // never shown
    const ldy = await sendLink(tenant, y, l1, "2026-04-10T10:00:00Z"); // never shown
    await click(tenant, ldy, "2026-04-10T10:30:00Z");
    await deposit(tenant, l1, "2026-04-10T11:00:00Z", { valor: 70 });
    await deposit(tenant, l1, "2026-04-20T11:00:00Z", { valor: 30 });
    await deposit(tenant, l1, "2026-04-21T11:00:00Z", { valor: 999, status: "pendente" });

    // l2 (AFF-X): before X's registration, affiliate not yet X's, affiliate
    // credit. The 2025 link opens the relationship before them.
    const l2 = await newPlayer(tenant, { affiliate: "AFF-X" });
    await sendLink(tenant, x, l2, "2026-01-10T10:00:00Z");
    await deposit(tenant, l2, "2026-01-15T12:00:00Z", { valor: 11 });
    await deposit(tenant, l2, "2026-02-15T12:00:00Z", { valor: 12 });
    await deposit(tenant, l2, "2026-03-15T12:00:00Z", { valor: 13 });

    // l3: X's click right before a deposit made after X's deactivation.
    const l3 = await newPlayer(tenant);
    const ld3 = await sendLink(tenant, x, l3, "2026-05-30T10:00:00Z");
    await click(tenant, ld3, "2026-06-02T10:00:00Z");
    await deposit(tenant, l3, "2026-06-02T11:00:00Z", { valor: 14 });

    await refresh(tenant);

    const t1 = await timeline(tenant, x, l1);
    expect(
      t1.map((r) => [
        iso(r.at),
        r.kind,
        r.status,
        r.detalhe,
        r.valor === null ? null : Number(r.valor),
      ]),
    ).toEqual([
      [
        "2026-04-20T11:00:00.000Z",
        "deposito",
        "nao_creditado",
        "sem clique seu nas 24h anteriores",
        30,
      ],
      [
        "2026-04-10T11:00:00.000Z",
        "deposito",
        "outra_pessoa",
        "contou para outro membro da equipe",
        70,
      ],
      ["2026-04-02T12:00:00.000Z", "contato", null, "Disse que volta amanhã", null],
      ["2026-04-01T11:00:00.000Z", "deposito", "creditado", "clique em 01/04 07:30", 100],
      ["2026-04-01T10:30:00.000Z", "clique", null, "Bônus 100%", null],
      ["2026-04-01T10:00:00.000Z", "link", null, "Bônus 100%", null],
    ]);
    expect(t1.find((r) => r.kind === "contato")?.titulo).toBe("Respondeu");
    expect(t1.every((r) => r.titulo.length > 0)).toBe(true);
    expect(JSON.stringify(t1)).not.toContain("Expert Y");

    const t2 = await timeline(tenant, x, l2);
    expect(t2.map((r) => [iso(r.at), r.kind, r.status, r.detalhe])).toEqual([
      ["2026-03-15T12:00:00.000Z", "deposito", "creditado", "afiliado"],
      [
        "2026-02-15T12:00:00.000Z",
        "deposito",
        "nao_creditado",
        "ID de afiliado não era seu na data",
      ],
      ["2026-01-15T12:00:00.000Z", "deposito", "nao_creditado", "antes do seu cadastro"],
      ["2026-01-10T10:00:00.000Z", "link", null, "Bônus 100%"],
    ]);

    const t3 = await timeline(tenant, x, l3);
    expect(t3[0]).toMatchObject({
      kind: "deposito",
      status: "nao_creditado",
      detalhe: "perfil desativado na data",
    });

    // Y sees only its own items on l1, plus the deposits from its first link on.
    const ty = await timeline(tenant, y, l1);
    expect(ty.map((r) => [iso(r.at), r.kind, r.status])).toEqual([
      ["2026-04-20T11:00:00.000Z", "deposito", "nao_creditado"],
      ["2026-04-10T11:00:00.000Z", "deposito", "creditado"],
      ["2026-04-10T10:30:00.000Z", "clique", null],
      ["2026-04-10T10:00:00.000Z", "link", null],
      ["2026-04-03T12:00:00.000Z", "contato", null],
    ]);
  });

  it("timeline is empty for a lead without any link or credit from the expert", async () => {
    const { tenant, x, y } = await timelineHouse();
    const lead = await newPlayer(tenant);
    const ldy = await sendLink(tenant, y, lead, "2026-04-10T10:00:00Z");
    await click(tenant, ldy, "2026-04-10T10:30:00Z");
    await deposit(tenant, lead, "2026-04-10T11:00:00Z", { valor: 70 });
    await refresh(tenant);
    expect(await timeline(tenant, x, lead)).toEqual([]);
    // Another house cannot read it either.
    expect(await timeline(await newTenant(), y, lead)).toEqual([]);
  });

  it("timeline paginates by _before", async () => {
    const { tenant, x } = await timelineHouse();
    const lead = await newPlayer(tenant);
    const ld = await sendLink(tenant, x, lead, "2026-04-01T10:00:00Z");
    await click(tenant, ld, "2026-04-01T10:30:00Z");
    await deposit(tenant, lead, "2026-04-01T11:00:00Z");
    await contact(tenant, x, lead, "2026-04-02T12:00:00Z");
    await deposit(tenant, lead, "2026-04-05T11:00:00Z");
    await refresh(tenant);

    const full = await timeline(tenant, x, lead);
    expect(full).toHaveLength(5);
    expect(await walkPages(tenant, x, lead, 2)).toEqual(full.map((r) => `${iso(r.at)} ${r.kind}`));
  });

  it("timeline never splits a timestamp across pages", async () => {
    const { tenant, x } = await timelineHouse();
    const lead = await newPlayer(tenant);
    await contact(tenant, x, lead, "2026-03-31T12:00:00Z");
    // A link, its click and the deposit all at the same instant.
    const ld = await sendLink(tenant, x, lead, "2026-04-01T10:00:00Z");
    await click(tenant, ld, "2026-04-01T10:00:00Z");
    await deposit(tenant, lead, "2026-04-01T10:00:00Z");
    await deposit(tenant, lead, "2026-04-05T11:00:00Z");
    await refresh(tenant);

    // limit 2 would cut after the first of the three tied items: the page
    // carries all three instead.
    const first = await timeline(tenant, x, lead, null, 2);
    expect(first.map((r) => `${iso(r.at)} ${r.kind}`)).toEqual([
      "2026-04-05T11:00:00.000Z deposito",
      "2026-04-01T10:00:00.000Z clique",
      "2026-04-01T10:00:00.000Z deposito",
      "2026-04-01T10:00:00.000Z link",
    ]);

    const full = await timeline(tenant, x, lead);
    expect(full).toHaveLength(5);
    expect(await walkPages(tenant, x, lead, 2)).toEqual(full.map((r) => `${iso(r.at)} ${r.kind}`));
  });

  it("timeline shows a deposit not yet computed as pendente", async () => {
    const { tenant } = await timelineHouse();
    const z = await newExpert(tenant, "Expert Z");
    const lead = await newPlayer(tenant);
    await sendLink(tenant, z, lead, "2026-04-01T10:00:00Z");
    await deposit(tenant, lead, "2026-04-02T10:00:00Z", { valor: 5 });
    await refresh(tenant);
    // Arrives after the last cron run.
    await deposit(tenant, lead, new Date(Date.now() - 60_000).toISOString(), { valor: 9 });

    const t = await timeline(tenant, z, lead);
    expect(t.map((r) => [r.kind, r.status, r.detalhe])).toEqual([
      ["deposito", "pendente", "aguardando cálculo (até 10 min)"],
      ["deposito", "nao_creditado", "sem clique seu nas 24h anteriores"],
      ["link", null, "Bônus 100%"],
    ]);
  });

  it("timeline never gives a reason for an old deposit the rule would credit but was never computed", async () => {
    const { tenant, x } = await timelineHouse();
    // Clicked lead and AFF-X lead, with links opening the relationship.
    const clicked = await newPlayer(tenant);
    const ldc = await sendLink(tenant, x, clicked, "2026-04-01T10:00:00Z");
    await click(tenant, ldc, "2026-04-01T10:30:00Z");
    const aff = await newPlayer(tenant, { affiliate: "AFF-X" });
    await sendLink(tenant, x, aff, "2026-01-10T10:00:00Z");
    // Clicked after X's deactivation: ineligible.
    const late = await newPlayer(tenant);
    const ldl = await sendLink(tenant, x, late, "2026-05-30T10:00:00Z");
    await click(tenant, ldl, "2026-06-02T10:00:00Z");
    await refresh(tenant);

    // Late imports, older than any recompute: no credit rows for them.
    await deposit(tenant, clicked, "2026-04-01T11:00:00Z", { valor: 10 }); // eligible click
    await deposit(tenant, clicked, "2026-04-20T11:00:00Z", { valor: 11 }); // outside the window
    await deposit(tenant, aff, "2026-04-15T12:00:00Z", { valor: 12 }); // affiliate covers it
    await deposit(tenant, aff, "2026-02-15T12:00:00Z", { valor: 13 }); // affiliate not yet X's
    await deposit(tenant, aff, "2026-01-15T12:00:00Z", { valor: 14 }); // before X's registration
    await deposit(tenant, late, "2026-06-02T11:00:00Z", { valor: 15 }); // after deactivation

    const deps = async (lead: string) =>
      (await timeline(tenant, x, lead))
        .filter((r) => r.kind === "deposito")
        .map((r) => [iso(r.at), r.status, r.detalhe]);

    expect(await deps(clicked)).toEqual([
      ["2026-04-20T11:00:00.000Z", "nao_creditado", "sem clique seu nas 24h anteriores"],
      ["2026-04-01T11:00:00.000Z", "pendente", "ainda não calculado"],
    ]);
    expect(await deps(aff)).toEqual([
      ["2026-04-15T12:00:00.000Z", "pendente", "ainda não calculado"],
      ["2026-02-15T12:00:00.000Z", "nao_creditado", "ID de afiliado não era seu na data"],
      ["2026-01-15T12:00:00.000Z", "nao_creditado", "antes do seu cadastro"],
    ]);
    expect(await deps(late)).toEqual([
      ["2026-06-02T11:00:00.000Z", "nao_creditado", "perfil desativado na data"],
    ]);
  });
});

describe("access", () => {
  it("authenticated cannot execute the new functions", async () => {
    async function asAuthenticated(sql: string) {
      await db.query("BEGIN");
      try {
        await db.exec("SET LOCAL ROLE authenticated");
        await db.query(sql);
      } finally {
        await db.query("ROLLBACK");
      }
    }
    const u = `'00000000-0000-4000-8000-000000000001'::uuid`;
    const calls = [
      `select * from public.expert_report(${u}, ${u}, now(), now())`,
      `select * from public.expert_report_daily(${u}, ${u}, now(), now())`,
      `select * from public.expert_team_report(${u}, now(), now())`,
      `select * from public.expert_click_conversion(${u}, array[${u}], now(), now())`,
      `select * from public.house_deposit_totals(${u}, now(), now())`,
      `select public.expert_last_computed_at(${u})`,
      `select * from public.expert_portfolio(${u}, ${u}, now(), now(), null, false, false, 50, 0)`,
      `select * from public.expert_lead_timeline(${u}, ${u}, ${u}, null, 100)`,
    ];
    for (const sql of calls) {
      await expect(asAuthenticated(sql), sql).rejects.toThrow(/permission denied/);
    }
  });
});
