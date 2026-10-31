// MB4-04: filtro por conta de anúncio em marketing_overview.
// supabase/migrations/20261127200000_meta_mb4_overview_filter.sql
// Mesmo esquema mínimo e fixtures de aquisicao-ltv.db.test.ts, mais um jogador
// atribuído à conta em dólar, para ter jogadores em duas contas.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const AL1 = readFileSync(
  resolve(root, "supabase/migrations/20261019100000_aquisicao_ltv_al1.sql"),
  "utf8",
);
const MB4 = readFileSync(
  resolve(root, "supabase/migrations/20261127200000_meta_mb4_overview_filter.sql"),
  "utf8",
);

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql as $$
  select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;
create table public.tenants (id uuid primary key, slug text);
create function public.has_tenant_access(_tenant uuid) returns boolean language sql as $$
  select coalesce(nullif(current_setting('test.access', true), ''), 'on') = 'on' $$;
create table public.players (
  id uuid primary key, tenant_id uuid, created_at timestamptz, ftd_em timestamptz,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, utm_id text);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
create table public.meta_ad_accounts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, meta_ad_account_id text,
  currency text);
create table public.marketing_ad_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, provider text not null, ad_account_id text, campaign_id text,
  campaign_name text, adset_id text, adset_name text, ad_id text, ad_name text,
  creative_name text, metric_date date not null, spend numeric(14,2) not null default 0,
  impressions bigint not null default 0, clicks bigint not null default 0, ctr numeric(10,4),
  cpc numeric(14,4), cpm numeric(14,4), raw jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_ad_metrics_daily_tenant_id_provider_metric_date_a_key
    unique (tenant_id, provider, metric_date, ad_account_id, ad_id));
create table public.player_attributions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, player_id uuid not null,
  event_type text not null default 'signup', provider text, utm_source text, utm_medium text,
  utm_campaign text, utm_content text, utm_term text, utm_id text, bl_click_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  match_status text not null default 'unmatched'
    constraint player_attributions_match_status_check check (match_status in (
      'matched_ad_id','matched_ad_name','matched_campaign_name','orphan_campaign','missing_utm','unmatched')),
  match_confidence numeric(5,2) not null default 0, matched_ad_account_id text,
  matched_campaign_id text, matched_adset_id text, matched_ad_id text,
  captured_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, player_id, event_type));
`;

const T = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const P = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const BRL_ACCOUNT = "act_111";
const USD_ACCOUNT = "act_222";

const SEED = `
insert into public.tenants values ('${T}', 'casa'), ('${OTHER}', 'outra');
insert into public.meta_ad_accounts (tenant_id, meta_ad_account_id, currency) values
  ('${T}', '${BRL_ACCOUNT}', 'BRL'), ('${T}', '${USD_ACCOUNT}', 'usd');

insert into public.meta_ads (tenant_id, ad_account_id, ad_id, ad_name, campaign_id, campaign_name,
  adset_id, adset_name, thumbnail_url) values
  ('${T}', '${BRL_ACCOUNT}', 'AD1', 'Video A', 'C1', 'Camp 1', 'S1', 'Publico 1', 'https://img/ad1.jpg'),
  ('${T}', '${BRL_ACCOUNT}', 'AD2', 'Video A', 'C2', 'Camp 2', 'S2', 'Publico 2', null),
  ('${T}', '${USD_ACCOUNT}', 'AD3', 'Video USD', 'C3', 'Camp USD', 'S3', 'Publico 3', null);

insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id, campaign_id,
  campaign_name, adset_id, adset_name, ad_id, ad_name, metric_date, spend, impressions, clicks) values
  ('${T}', 'meta', '${BRL_ACCOUNT}', 'C1', 'Camp 1', 'S1', 'Publico 1', 'AD1', 'Video A', '2026-10-01', 10, 1000, 10),
  ('${T}', 'meta', '${BRL_ACCOUNT}', 'C1', 'Camp 1', 'S1', 'Publico 1', 'AD1', 'Video A', '2026-10-02', 10, 1000, 10),
  ('${T}', 'meta', '${BRL_ACCOUNT}', 'C1', 'Camp 1', 'S1', 'Publico 1', 'AD1', 'Video A', '2026-10-03', 10, 1000, 10),
  ('${T}', 'meta', '${BRL_ACCOUNT}', 'C2', 'Camp 2', 'S2', 'Publico 2', 'AD2', 'Video A', '2026-10-02', 20, 2000, 20),
  ('${T}', 'meta', '${USD_ACCOUNT}', 'C3', 'Camp USD', 'S3', 'Publico 3', 'AD3', 'Video USD', '2026-10-02', 5, 500, 5),
  ('${T}', 'meta', '${BRL_ACCOUNT}', 'C1', 'Camp 1', 'S1', 'Publico 1', 'AD1', 'Video A', '2026-09-30', 999, 0, 0);
insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id, campaign_id,
  campaign_name, adset_id, adset_name, ad_id, ad_name, metric_date, spend, impressions, clicks)
select '${T}', 'meta', '${BRL_ACCOUNT}', 'C9', 'Camp longa', 'S9', 'Publico 9', 'X' || n, 'Extra ' || n,
  '2026-10-04', 1, 100, 1
from generate_series(1, 60) n;
insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id, ad_id, ad_name,
  metric_date, spend) values ('${OTHER}', 'meta', '${BRL_ACCOUNT}', 'AD1', 'Video A', '2026-10-02', 777);

insert into public.players (id, tenant_id, created_at, ftd_em, utm_source) values
  ('${P(1)}', '${T}', '2026-10-01 12:00+00', '2026-10-02 12:00+00', 'fb'),
  ('${P(2)}', '${T}', '2026-10-02 12:00+00', '2026-10-02 13:00+00', 'ig'),
  ('${P(3)}', '${T}', '2026-10-02 12:00+00', null, 'ig'),
  ('${P(4)}', '${T}', '2026-10-03 12:00+00', null, 'fb'),
  ('${P(5)}', '${T}', '2026-10-03 12:00+00', null, 'betleads'),
  ('${P(6)}', '${T}', '2026-10-03 12:00+00', '2026-10-03 13:00+00', null),
  ('${P(7)}', '${T}', '2026-10-04 12:00+00', null, 'fb'),
  ('${P(8)}', '${T}', '2026-10-08 02:30+00', '2026-10-08 02:40+00', 'fb'),
  ('${P(9)}', '${T}', '2026-10-08 03:10+00', '2026-10-08 03:20+00', 'fb'),
  ('${P(10)}', '${OTHER}', '2026-10-02 12:00+00', '2026-10-02 13:00+00', 'fb'),
  ('${P(11)}', '${T}', '2026-10-02 15:00+00', '2026-10-02 16:00+00', 'fb');

insert into public.player_attributions (tenant_id, player_id, utm_source, utm_campaign, utm_content, utm_term) values
  ('${T}', '${P(1)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${T}', '${P(2)}', 'ig', 'Camp 2', 'Video A', null),
  ('${T}', '${P(3)}', 'ig', null, 'Video A', null),
  ('${T}', '${P(4)}', 'fb', 'C1', '999', 'S1'),
  ('${T}', '${P(5)}', 'betleads', 'campanha-crm', 'x', null),
  ('${T}', '${P(7)}', 'fb', 'zzz', 'zzz', null),
  ('${T}', '${P(8)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${T}', '${P(9)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${OTHER}', '${P(10)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${T}', '${P(11)}', 'fb', 'C3', 'AD3', 'S3');

insert into public.deposits (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 100, 'aprovado', '2026-10-02 12:00+00'),
  ('${T}', '${P(1)}', 50, 'aprovado', '2026-10-05 12:00+00'),
  ('${T}', '${P(1)}', 999, 'pendente', '2026-10-05 13:00+00'),
  ('${T}', '${P(1)}', 70, 'aprovado', '2026-10-09 12:00+00'),
  ('${T}', '${P(2)}', 40, 'aprovado', '2026-10-02 13:00+00'),
  ('${T}', '${P(6)}', 500, 'aprovado', '2026-10-03 13:00+00'),
  ('${T}', '${P(8)}', 10, 'aprovado', '2026-10-08 02:40+00'),
  ('${T}', '${P(9)}', 300, 'aprovado', '2026-10-08 03:20+00'),
  ('${OTHER}', '${P(10)}', 5000, 'aprovado', '2026-10-02 13:00+00'),
  ('${T}', '${P(11)}', 25, 'aprovado', '2026-10-02 16:00+00'),
  ('${T}', '${P(11)}', 15, 'aprovado', '2026-10-04 16:00+00');
insert into public.withdrawals (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 30, 'aprovado', '2026-10-06 12:00+00'),
  ('${T}', '${P(11)}', 8, 'aprovado', '2026-10-05 12:00+00');
`;

type Overview = {
  totals: Record<string, unknown>;
  attributionHealth: Record<string, unknown>;
  creatives: Array<Record<string, unknown>>;
  campaigns: Array<Record<string, unknown>>;
  audiences: Array<Record<string, unknown>>;
  orphanAttributions: Array<Record<string, unknown>>;
  daily: Array<Record<string, unknown>>;
  filter?: { ad_account_ids: string[]; players_scope: string } | null;
};

// Períodos usados na comparação "sem filtro = antes".
const PERIODS: Array<[string, string, string]> = [
  [T, "2026-10-01", "2026-10-07"],
  [T, "2026-09-01", "2026-10-31"],
  [T, "2026-10-02", "2026-10-02"],
  [T, "2025-01-01", "2025-01-02"],
  [OTHER, "2026-10-01", "2026-10-07"],
];

let db: PGlite;
const before = new Map<string, string>();

async function raw(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.query<{ o: string }>(sql, params);
  return rows[0].o;
}

async function overview(ids: string[] | null, from = "2026-10-01", to = "2026-10-07"): Promise<Overview> {
  const { rows } = await db.query<{ o: Overview }>(
    "select public.marketing_overview($1, $2::date, $3::date, $4::text[]) o",
    [T, from, to, ids],
  );
  return rows[0].o;
}

const num = (v: unknown) => Number(v);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(AL1);
  await db.exec(SEED);
  await db.query("select public.reconcile_meta_attributions($1)", [T]);
  await db.query("select public.reconcile_meta_attributions($1)", [OTHER]);
  // Saída da versão de 3 argumentos, antes da MB4.
  for (const [tenant, from, to] of PERIODS) {
    before.set(
      `${tenant}|${from}|${to}`,
      await raw("select public.marketing_overview($1, $2::date, $3::date)::text o", [tenant, from, to]),
    );
  }
  await db.exec(MB4);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("MB4-04 migration", () => {
  it("fixture: P11 casou com a conta em dólar e os demais pagos com a de reais", async () => {
    const { rows } = await db.query<{ player_id: string; matched_ad_account_id: string | null }>(
      `select player_id::text, matched_ad_account_id from public.player_attributions
       where tenant_id = $1 order by player_id`,
      [T],
    );
    const byPlayer = Object.fromEntries(rows.map((r) => [r.player_id, r.matched_ad_account_id]));
    expect(byPlayer[P(11)]).toBe(USD_ACCOUNT);
    expect(byPlayer[P(1)]).toBe(BRL_ACCOUNT);
    expect(byPlayer[P(4)]).toBe(BRL_ACCOUNT);
    expect(byPlayer[P(3)]).toBeNull();
    expect(byPlayer[P(5)]).toBeNull();
  });

  it("fica só a versão de 4 argumentos, com os mesmos grants", async () => {
    const { rows } = await db.query<{ sig: string }>(
      `select pg_get_function_identity_arguments(p.oid) sig from pg_proc p
       where p.proname = 'marketing_overview' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows.map((r) => r.sig)).toEqual([
      "_tenant uuid, _from date, _to date, _ad_account_ids text[]",
    ]);
    const sig = "public.marketing_overview(uuid, date, date, text[])";
    const { rows: priv } = await db.query<Record<string, boolean>>(
      `select has_function_privilege('anon', '${sig}', 'execute') anon,
              has_function_privilege('authenticated', '${sig}', 'execute') authenticated,
              has_function_privilege('service_role', '${sig}', 'execute') service_role`,
    );
    expect(priv[0]).toEqual({ anon: false, authenticated: true, service_role: true });
    const { rows: def } = await db.query<{ secdef: boolean; config: string[] }>(
      `select prosecdef secdef, proconfig config from pg_proc
       where proname = 'marketing_overview' and pronamespace = 'public'::regnamespace`,
    );
    expect(def[0]).toEqual({ secdef: true, config: ["search_path=public"] });
  });

  it("é idempotente", async () => {
    await expect(db.exec(MB4)).resolves.toBeDefined();
  });
});

describe("MB4-04 sem filtro = resultado de antes", () => {
  it("3 argumentos (posicionais e nomeados), nulo e vazio devolvem o mesmo texto", async () => {
    for (const [tenant, from, to] of PERIODS) {
      const expected = before.get(`${tenant}|${from}|${to}`)!;
      const calls: Array<[string, unknown[]]> = [
        ["select public.marketing_overview($1, $2::date, $3::date)::text o", [tenant, from, to]],
        [
          "select public.marketing_overview(_tenant => $1, _from => $2::date, _to => $3::date)::text o",
          [tenant, from, to],
        ],
        ["select public.marketing_overview($1, $2::date, $3::date, null)::text o", [tenant, from, to]],
        [
          "select public.marketing_overview($1, $2::date, $3::date, '{}'::text[])::text o",
          [tenant, from, to],
        ],
        [
          "select public.marketing_overview($1, $2::date, $3::date, array[null, '  ']::text[])::text o",
          [tenant, from, to],
        ],
      ];
      for (const [sql, params] of calls) {
        expect(await raw(sql, params)).toBe(expected);
      }
      expect(JSON.parse(expected)).not.toHaveProperty("filter");
    }
  });

  it("sem filtro entram não atribuídos, CRM e orgânicos", async () => {
    const o = await overview(null);
    expect(num(o.totals.players)).toBe(9);
    expect(num(o.attributionHealth.crm)).toBe(1);
    expect(num(o.attributionHealth.missingUtm)).toBe(1);
    expect(o.orphanAttributions.length).toBeGreaterThan(0);
  });
});

describe("MB4-04 com filtro", () => {
  it("uma conta: só o gasto dela", async () => {
    const brl = await overview([BRL_ACCOUNT]);
    expect(num(brl.totals.spend)).toBe(110);
    expect(brl.totals.spendOther).toEqual([]);
    expect(num(brl.totals.impressions)).toBe(3000 + 2000 + 6000);
    expect(brl.creatives.some((r) => r.ad_id === "AD3")).toBe(false);

    const usd = await overview([USD_ACCOUNT]);
    expect(num(usd.totals.spend)).toBe(0);
    expect(usd.totals.spendOther).toEqual([{ currency: "USD", spend: 5 }]);
    expect(num(usd.totals.impressions)).toBe(500);
    expect(usd.daily.reduce((s, d) => s + num(d.spend), 0)).toBe(0);
  });

  it("jogadores atribuídos à outra conta ficam de fora", async () => {
    const brl = await overview([BRL_ACCOUNT]);
    // P1, P2, P4, P8 (P11 é da conta em dólar).
    expect(num(brl.totals.players)).toBe(4);
    expect(num(brl.totals.paidPlayers)).toBe(4);
    expect(num(brl.totals.revenue)).toBe(200);
    expect(num(brl.totals.withdrawals)).toBe(30);
    expect(brl.creatives.find((r) => r.ad_id === "AD1")).toMatchObject({ players: 2 });

    const usd = await overview([USD_ACCOUNT]);
    expect(num(usd.totals.players)).toBe(1);
    expect(num(usd.totals.paidFtd)).toBe(1);
    expect(num(usd.totals.revenue)).toBe(40);
    expect(num(usd.totals.withdrawals)).toBe(8);
    expect(num(usd.totals.ftdRevenue)).toBe(25);
    const ad3 = usd.creatives.find((r) => r.ad_id === "AD3")!;
    expect(num(ad3.players)).toBe(1);
    expect(num(ad3.revenue)).toBe(40);
    expect(usd.campaigns.map((r) => r.campaign_id)).toEqual(["C3"]);
    expect(usd.audiences.map((r) => r.adset)).toEqual(["Publico 3"]);
    expect(usd.creatives.some((r) => num(r.players) > 0 && r.ad_id !== "AD3")).toBe(false);
  });

  it("não atribuídos, UTM sem anúncio, CRM e orgânicos saem só com filtro", async () => {
    const both = await overview([BRL_ACCOUNT, USD_ACCOUNT]);
    expect(num(both.totals.players)).toBe(5);
    expect(num(both.totals.ftd)).toBe(num(both.totals.paidFtd));
    expect(both.attributionHealth).toMatchObject({
      total: 5,
      matched: 5,
      missingUtm: 0,
      crm: 0,
      ambiguous: 0,
      orphan: 0,
      pending: 0,
    });
    expect(both.orphanAttributions).toEqual([]);
  });

  it("partição das contas soma o gasto e os pagos de sem filtro", async () => {
    const all = await overview(null);
    const parts = [await overview([BRL_ACCOUNT]), await overview([USD_ACCOUNT])];
    const sum = (key: string) => parts.reduce((s, o) => s + num(o.totals[key]), 0);
    expect(sum("spend")).toBe(num(all.totals.spend));
    expect(sum("impressions")).toBe(num(all.totals.impressions));
    expect(sum("clicks")).toBe(num(all.totals.clicks));
    expect(sum("paidPlayers")).toBe(num(all.totals.paidPlayers));
    expect(sum("revenue")).toBe(num(all.totals.revenue));
    expect(parts.flatMap((o) => o.totals.spendOther as unknown[])).toEqual(all.totals.spendOther);
    const both = await overview([USD_ACCOUNT, BRL_ACCOUNT]);
    expect(num(both.totals.spend)).toBe(num(all.totals.spend));
    expect(num(both.totals.impressions)).toBe(num(all.totals.impressions));
  });

  it("conta sem dados devolve zeros", async () => {
    const o = await overview(["act_999"]);
    expect(num(o.totals.spend)).toBe(0);
    expect(num(o.totals.players)).toBe(0);
    expect(o.creatives).toEqual([]);
    expect(o.daily).toHaveLength(7);
  });

  it("chave filter só com filtro, ids sem repetição e ordenados", async () => {
    const o = await overview([USD_ACCOUNT, " act_111 ", BRL_ACCOUNT, ""]);
    expect(o.filter).toEqual({
      ad_account_ids: [BRL_ACCOUNT, USD_ACCOUNT],
      players_scope: "matched_only",
    });
    expect(await overview(null)).not.toHaveProperty("filter");
    expect(await overview([])).not.toHaveProperty("filter");
  });

  it("acesso e limite do período valem com filtro", async () => {
    await expect(overview([BRL_ACCOUNT], "2026-10-07", "2026-10-01")).rejects.toThrow(
      /Período inválido/,
    );
    await expect(overview([BRL_ACCOUNT], "2025-01-01", "2026-10-01")).rejects.toThrow(
      /período máximo/,
    );
    await db.exec("set test.access = 'off'");
    try {
      await expect(overview([BRL_ACCOUNT])).rejects.toThrow(/Sem acesso/);
      await db.exec("set test.role = 'service_role'");
      await expect(overview([BRL_ACCOUNT])).resolves.toHaveProperty("filter");
    } finally {
      await db.exec("reset test.role");
      await db.exec("set test.access = 'on'");
    }
  });
});
