// F1 de ESCOPO_META_AQUISICAO_V2_2026-11-14: marketing_overview só com contas marcadas,
// motivo de cada cadastro sem anúncio e gasto de campanha sem cadastro ligado.
// supabase/migrations/20261231100900_aquisicao_f1_overview.sql
// Esquema e fixtures de marketing-overview-filter.db.test.ts, mais meta_ad_accounts.selected
// e um cadastro de cada motivo.

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

const F1 = readFileSync(
  resolve(root, "supabase/migrations/20261231100900_aquisicao_f1_overview.sql"),
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
  currency text, selected boolean not null default true);
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

// Um cadastro de cada motivo de "sem anúncio correspondente" (F1-03), todos em 03/10.
const REASONS_SEED = `
insert into public.players (id, tenant_id, created_at, ftd_em, utm_source, utm_medium) values
  ('${P(20)}', '${T}', '2026-10-03 15:00+00', '2026-10-03 15:10+00', 'instagram', 'live'),
  ('${P(21)}', '${T}', '2026-10-03 15:00+00', null, 'kwai', null),
  ('${P(22)}', '${T}', '2026-10-03 15:00+00', null, 'fb', 'paid'),
  ('${P(23)}', '${T}', '2026-10-03 15:00+00', null, 'fb', 'paid'),
  ('${P(24)}', '${T}', '2026-10-03 15:00+00', null, 'fb', 'paid'),
  ('${P(25)}', '${T}', '2026-10-03 15:00+00', null, 'google', 'cpc');
insert into public.player_attributions
  (tenant_id, player_id, provider, utm_source, utm_medium, utm_campaign, utm_content, utm_term) values
  ('${T}', '${P(20)}', 'meta', 'instagram', 'live', 'live_12_11', 'botao', 'video_novo'),
  ('${T}', '${P(21)}', 'kwai', 'kwai', null, 'teste_pixel', null, null),
  ('${T}', '${P(22)}', 'meta', 'fb', 'paid', '{{campaign.id}}', '{{ad.id}}', null),
  ('${T}', '${P(23)}', 'meta', 'fb', 'paid', '120250000000000001', '120250000000000002', null),
  ('${T}', '${P(24)}', 'meta', 'fb', 'paid', null, null, null),
  ('${T}', '${P(25)}', null, 'google', 'cpc', 'marca', 'anuncio', null);
insert into public.deposits (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(20)}', 80, 'aprovado', '2026-10-03 15:10+00');
`;

type Overview = {
  totals: Record<string, unknown>;
  attributionHealth: Record<string, unknown>;
  campaigns: Array<Record<string, unknown>>;
  orphanAttributions: Array<Record<string, unknown>>;
  orphanReasons: Array<{ reason: string; players: number; ftd: number; revenue: number }>;
  unlinkedCampaigns: Array<{ campaign: string; campaign_id: string | null; spend: number }>;
  [key: string]: unknown;
};

const PERIODS: Array<[string, string, string]> = [
  [T, "2026-10-01", "2026-10-07"],
  [T, "2026-09-01", "2026-10-31"],
  [T, "2026-10-02", "2026-10-02"],
];

let db: PGlite;
const before = new Map<string, Overview>();

async function overview(
  ids: string[] | null = null,
  from = "2026-10-01",
  to = "2026-10-07",
  tenant = T,
): Promise<Overview> {
  const { rows } = await db.query<{ o: Overview }>(
    "select public.marketing_overview($1, $2::date, $3::date, $4::text[]) o",
    [tenant, from, to, ids],
  );
  return rows[0].o;
}

const num = (v: unknown) => Number(v);

const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));

/** Tira o que a F1 acrescentou, para comparar com a saída da MB4. */
function withoutF1(o: Overview) {
  const { orphanReasons: _r, unlinkedCampaigns: _u, ...rest } = o;
  const { spendUnlinked: _s, ...totals } = o.totals;
  const orphans = o.orphanAttributions
    .map(({ reason: _reason, medium: _medium, ...row }) => row)
    .sort(byJson);
  return { ...rest, totals, orphanAttributions: orphans };
}

function sortedOrphans(o: Overview) {
  return { ...o, orphanAttributions: [...o.orphanAttributions].sort(byJson) };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(AL1);
  await db.exec(SEED);
  await db.exec(REASONS_SEED);
  await db.query("select public.reconcile_meta_attributions($1)", [T]);
  await db.query("select public.reconcile_meta_attributions($1)", [OTHER]);
  await db.exec(MB4);
  for (const [tenant, from, to] of PERIODS) {
    before.set(`${tenant}|${from}|${to}`, await overview(null, from, to, tenant));
  }
  await db.exec(F1);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("F1 migration", () => {
  it("mantém a assinatura, os grants e o security definer", async () => {
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
              has_function_privilege('authenticated', '${sig}', 'execute') authenticated`,
    );
    expect(priv[0]).toEqual({ anon: false, authenticated: true });
  });

  it("é idempotente", async () => {
    await expect(db.exec(F1)).resolves.toBeDefined();
  });
});

describe("F1 com todas as contas marcadas = MB4 + chaves novas", () => {
  it("o resto do JSON não muda", async () => {
    for (const [tenant, from, to] of PERIODS) {
      const after = await overview(null, from, to, tenant);
      expect(withoutF1(after)).toEqual(sortedOrphans(before.get(`${tenant}|${from}|${to}`)!));
    }
  });
});

describe("F1-02 só contas marcadas", () => {
  it("desmarcar a conta em dólar tira o gasto dela; a de reais não muda", async () => {
    const all = await overview();
    await db.exec(
      `update public.meta_ad_accounts set selected = false where meta_ad_account_id = '${USD_ACCOUNT}'`,
    );
    try {
      const o = await overview();
      expect(o.totals.spendOther).toEqual([]);
      expect(num(o.totals.spend)).toBe(num(all.totals.spend));
      expect(num(o.totals.impressions)).toBe(num(all.totals.impressions) - 500);
    } finally {
      await db.exec(`update public.meta_ad_accounts set selected = true`);
    }
  });

  it("casa sem conta cadastrada não soma o gasto que sobrou na tabela", async () => {
    const o = await overview(null, "2026-10-01", "2026-10-07", OTHER);
    expect(num(o.totals.spend)).toBe(0);
    expect(o.totals.cpaFtd).toBeNull();
    expect(num(o.totals.paidPlayers)).toBe(1);
  });

  it("gasto de conta sem cadastro em meta_ad_accounts não entra", async () => {
    const all = await overview();
    await db.exec(`insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id,
      campaign_id, campaign_name, ad_id, ad_name, metric_date, spend)
      values ('${T}', 'meta', 'act_solta', 'CX', 'Camp solta', 'ADX', 'Solta', '2026-10-02', 444)`);
    try {
      const o = await overview();
      expect(o.campaigns.some((c) => c.campaign_id === "CX")).toBe(false);
      expect(num(o.totals.spend)).toBe(num(all.totals.spend));
    } finally {
      await db.exec(
        `delete from public.marketing_ad_metrics_daily where ad_account_id = 'act_solta'`,
      );
    }
  });
});

describe("F1-03 motivo do cadastro sem anúncio", () => {
  it("classifica cada cadastro", async () => {
    const o = await overview();
    const by = Object.fromEntries(o.orphanReasons.map((r) => [r.reason, r]));
    expect(num(by.live.players)).toBe(1);
    expect(num(by.live.ftd)).toBe(1);
    expect(num(by.live.revenue)).toBe(80);
    expect(num(by.other_source.players)).toBe(2); // kwai + google
    expect(num(by.macro.players)).toBe(1);
    expect(num(by.id_not_found.players)).toBe(1);
    expect(num(by.source_only.players)).toBe(1);
    expect(num(by.name_not_found?.players ?? 0)).toBeGreaterThanOrEqual(1); // P7 "zzz"
  });

  it("o resumo soma o total de órfãos do banner", async () => {
    const o = await overview();
    const sum = o.orphanReasons.reduce((s, r) => s + num(r.players), 0);
    expect(sum).toBe(num(o.totals.orphanPlayers));
  });

  it("cada linha do diagnóstico traz o motivo e o meio", async () => {
    const o = await overview();
    const live = o.orphanAttributions.find((r) => r.campaign === "live_12_11");
    expect(live).toMatchObject({ reason: "live", medium: "live", source: "instagram" });
    expect(o.orphanAttributions.every((r) => typeof r.reason === "string")).toBe(true);
  });

  it("com filtro de conta não há órfãos nem motivos", async () => {
    const o = await overview([BRL_ACCOUNT]);
    expect(o.orphanReasons).toEqual([]);
  });
});

describe("F1-05 gasto sem cadastro ligado", () => {
  it("soma o gasto das campanhas sem nenhum cadastro ligado", async () => {
    const o = await overview();
    const expected = o.campaigns
      .filter((c) => num(c.players) === 0 && num(c.spend) > 0)
      .reduce((s, c) => s + num(c.spend), 0);
    expect(num(o.totals.spendUnlinked)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    expect(o.unlinkedCampaigns[0]).toMatchObject({ campaign: "Camp longa", campaign_id: "C9" });
    expect(num(o.unlinkedCampaigns[0].spend)).toBe(60);
    expect(o.unlinkedCampaigns.length).toBeLessThanOrEqual(5);
  });

  it("período sem gasto devolve zero e lista vazia", async () => {
    const o = await overview(null, "2025-01-01", "2025-01-02");
    expect(num(o.totals.spendUnlinked)).toBe(0);
    expect(o.unlinkedCampaigns).toEqual([]);
  });
});
