// Aquisição e LTV, fase AL1: testes SQL de
// supabase/migrations/20261019100000_aquisicao_ltv_al1.sql
// Um período "golden" com resultados conhecidos (escopo, seção 8, blocos D, F, G e K).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261019100000_aquisicao_ltv_al1.sql"),
  "utf8",
);

// Esquema mínimo com os nomes de constraint de produção.
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

-- Catálogo: dois anúncios com o mesmo nome em campanhas diferentes.
insert into public.meta_ads (tenant_id, ad_account_id, ad_id, ad_name, campaign_id, campaign_name,
  adset_id, adset_name, thumbnail_url) values
  ('${T}', '${BRL_ACCOUNT}', 'AD1', 'Video A', 'C1', 'Camp 1', 'S1', 'Publico 1', 'https://img/ad1.jpg'),
  ('${T}', '${BRL_ACCOUNT}', 'AD2', 'Video A', 'C2', 'Camp 2', 'S2', 'Publico 2', null);

-- Gasto: AD1 R$ 10/dia em 3 dias, AD2 R$ 20, AD3 US$ 5, 60 anúncios de R$ 1.
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
-- Outra casa com o mesmo anúncio: não pode vazar.
insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id, ad_id, ad_name,
  metric_date, spend) values ('${OTHER}', 'meta', '${BRL_ACCOUNT}', 'AD1', 'Video A', '2026-10-02', 777);

-- Jogadores (horários em UTC; Brasília = UTC-3).
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
  ('${P(10)}', '${OTHER}', '2026-10-02 12:00+00', '2026-10-02 13:00+00', 'fb');

insert into public.player_attributions (tenant_id, player_id, utm_source, utm_campaign, utm_content, utm_term) values
  ('${T}', '${P(1)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${T}', '${P(2)}', 'ig', 'Camp 2', 'Video A', null),
  ('${T}', '${P(3)}', 'ig', null, 'Video A', null),
  ('${T}', '${P(4)}', 'fb', 'C1', '999', 'S1'),
  ('${T}', '${P(5)}', 'betleads', 'campanha-crm', 'x', null),
  ('${T}', '${P(7)}', 'fb', 'zzz', 'zzz', null),
  ('${T}', '${P(8)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${T}', '${P(9)}', 'fb', 'C1', 'AD1', 'S1'),
  ('${OTHER}', '${P(10)}', 'fb', 'C1', 'AD1', 'S1');

insert into public.deposits (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 100, 'aprovado', '2026-10-02 12:00+00'),
  ('${T}', '${P(1)}', 50, 'aprovado', '2026-10-05 12:00+00'),
  ('${T}', '${P(1)}', 999, 'pendente', '2026-10-05 13:00+00'),
  ('${T}', '${P(1)}', 888, 'falhou', '2026-10-05 14:00+00'),
  ('${T}', '${P(1)}', 70, 'aprovado', '2026-10-09 12:00+00'),
  ('${T}', '${P(2)}', 40, 'aprovado', '2026-10-02 13:00+00'),
  ('${T}', '${P(6)}', 500, 'aprovado', '2026-10-03 13:00+00'),
  ('${T}', '${P(8)}', 10, 'aprovado', '2026-10-08 02:40+00'),
  ('${T}', '${P(9)}', 300, 'aprovado', '2026-10-08 03:20+00'),
  ('${OTHER}', '${P(10)}', 5000, 'aprovado', '2026-10-02 13:00+00');
insert into public.withdrawals (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 30, 'aprovado', '2026-10-06 12:00+00'),
  ('${T}', '${P(1)}', 1000, 'pendente', '2026-10-06 12:00+00');
`;

type Overview = {
  totals: Record<string, unknown>;
  attributionHealth: Record<string, unknown>;
  creatives: Array<Record<string, unknown>>;
  creativesOthers: Record<string, unknown>;
  campaigns: Array<Record<string, unknown>>;
  audiences: Array<Record<string, unknown>>;
  orphanAttributions: Array<Record<string, unknown>>;
  daily: Array<Record<string, unknown>>;
};

let db: PGlite;

async function overview(from = "2026-10-01", to = "2026-10-07", tenant = T): Promise<Overview> {
  const { rows } = await db.query<{ o: Overview }>(
    "select public.marketing_overview($1, $2::date, $3::date) o",
    [tenant, from, to],
  );
  return rows[0].o;
}

async function status(player: string) {
  const { rows } = await db.query<Record<string, string | null>>(
    `select match_status, matched_ad_id, matched_campaign_id, matched_adset_id
     from public.player_attributions where player_id = $1`,
    [player],
  );
  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // Linhas existentes antes da migration: precisam ficar válidas depois dela.
  await db.exec(`insert into public.tenants values ('${T}', 'casa'), ('${OTHER}', 'outra')`);
  // Importado direto em players (sem linha de atribuição), fora do período golden.
  await db.exec(`insert into public.players (id, tenant_id, created_at, utm_source, utm_content)
    values ('${P(30)}', '${T}', '2026-09-15 12:00+00', 'ig', 'AD1')`);
  await db.exec(MIGRATION);
  await db.exec(SEED.replace(/insert into public\.tenants[^;]+;/, ""));
  await db.query("select public.reconcile_meta_attributions($1)", [T]);
  await db.query("select public.reconcile_meta_attributions($1)", [OTHER]);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("AL1-05 reconciliação", () => {
  it("casa pelo ID do anúncio em utm_content (padrão Sorte Alta)", async () => {
    expect(await status(P(1))).toEqual({
      match_status: "matched_ad_id",
      matched_ad_id: "AD1",
      matched_campaign_id: "C1",
      matched_adset_id: "S1",
    });
  });

  it("nome repetido desempata pela campanha", async () => {
    expect(await status(P(2))).toMatchObject({
      match_status: "matched_ad_name",
      matched_ad_id: "AD2",
    });
  });

  it("nome repetido sem campanha fica ambiguous, sem anúncio", async () => {
    expect(await status(P(3))).toMatchObject({ match_status: "ambiguous", matched_ad_id: null });
  });

  it("casa pela campanha por ID e acha o conjunto por utm_term", async () => {
    expect(await status(P(4))).toEqual({
      match_status: "matched_campaign_id",
      matched_ad_id: null,
      matched_campaign_id: "C1",
      matched_adset_id: "S1",
    });
  });

  it("clique do CRM nunca vira mídia paga", async () => {
    expect(await status(P(5))).toMatchObject({ match_status: "crm", matched_campaign_id: null });
  });

  it("marcação sem anúncio correspondente fica orphan_campaign", async () => {
    expect(await status(P(7))).toMatchObject({ match_status: "orphan_campaign" });
  });

  it("jogador importado só com UTM em players ganha linha de atribuição e é reconciliado", async () => {
    expect(await status(P(30))).toMatchObject({
      match_status: "matched_ad_id",
      matched_ad_id: "AD1",
    });
    const { rows } = await db.query<{ provider: string; source: string }>(
      `select provider, raw_payload->>'source' source from public.player_attributions where player_id = $1`,
      [P(30)],
    );
    expect(rows[0]).toEqual({ provider: "meta", source: "players_backfill_20261019" });
  });

  it("é idempotente", async () => {
    const { rows } = await db.query<{ n: number }>(
      "select public.reconcile_meta_attributions($1) n",
      [T],
    );
    expect(rows[0].n).toBe(0);
  });

  it("novas atribuições entram como pending e o worker reconcilia só elas", async () => {
    await db.exec(`
      insert into public.players (id, tenant_id, created_at) values ('${P(20)}', '${T}', '2026-10-05 12:00+00');
      insert into public.player_attributions (tenant_id, player_id, utm_source, utm_content)
      values ('${T}', '${P(20)}', 'fb', 'AD2');`);
    expect((await status(P(20))).match_status).toBe("pending");
    const { rows } = await db.query<{ n: number }>(
      "select public.reconcile_pending_meta_attributions() n",
    );
    expect(rows[0].n).toBe(1);
    expect(await status(P(20))).toMatchObject({
      match_status: "matched_ad_id",
      matched_ad_id: "AD2",
    });
    await db.exec(`
      delete from public.player_attributions where player_id = '${P(20)}';
      delete from public.players where id = '${P(20)}';`);
  });
});

describe("AL1-01 marketing_overview", () => {
  it("totais sobre todas as linhas, só em BRL, e moeda estrangeira separada", async () => {
    const o = await overview();
    expect(Number(o.totals.spend)).toBe(110);
    expect(o.totals.spendOther).toEqual([{ currency: "USD", spend: 5 }]);
    expect(Number(o.totals.impressions)).toBe(3000 + 2000 + 500 + 6000);
  });

  it("recorta cadastros no dia de Brasília", async () => {
    const o = await overview();
    // P8 (23:30 BRT do dia 7) entra; P9 (00:10 BRT do dia 8) e a outra casa ficam fora.
    expect(Number(o.totals.players)).toBe(8);
  });

  it("receita bruta, saques e líquido só dos jogadores pagos, dentro do período", async () => {
    const o = await overview();
    expect(Number(o.totals.paidPlayers)).toBe(4);
    expect(Number(o.totals.revenue)).toBe(200);
    expect(Number(o.totals.withdrawals)).toBe(30);
    expect(Number(o.totals.net)).toBe(170);
    expect(Number(o.totals.ftdRevenue)).toBe(150);
    expect(Number(o.totals.redepositRevenue)).toBe(50);
  });

  it("CAC e custo por FTD dividem o gasto só pelos jogadores pagos", async () => {
    const o = await overview();
    expect(Number(o.totals.ftd)).toBe(4);
    expect(Number(o.totals.paidFtd)).toBe(3);
    expect(Number(o.totals.cpaFtd)).toBe(36.67);
    expect(Number(o.totals.cacSignup)).toBe(27.5);
    expect(Number(o.totals.roas)).toBeCloseTo(170 / 110, 4);
    expect(Number(o.totals.roasGross)).toBeCloseTo(200 / 110, 4);
  });

  it("saúde da atribuição soma todos os cadastros", async () => {
    const h = (await overview()).attributionHealth;
    expect(h).toMatchObject({
      total: 8,
      marked: 7,
      matched: 4,
      missingUtm: 1,
      crm: 1,
      ambiguous: 1,
      orphan: 1,
      pending: 0,
    });
    expect(Number(h.matchRate)).toBeCloseTo((4 / 6) * 100, 2);
  });

  it("lista as 50 primeiras e agrega o resto em outros", async () => {
    const o = await overview();
    expect(o.creatives).toHaveLength(50);
    expect(Number(o.creativesOthers.count)).toBe(13);
    const listed = o.creatives.reduce((sum, row) => sum + Number(row.spend), 0);
    expect(listed + Number(o.creativesOthers.spend)).toBe(110);
  });

  it("agrupa por ID do anúncio, sem fundir homônimos, com miniatura do catálogo", async () => {
    const o = await overview();
    const ad1 = o.creatives.find((row) => row.ad_id === "AD1")!;
    const ad2 = o.creatives.find((row) => row.ad_id === "AD2")!;
    expect(ad1).toMatchObject({
      creative: "Video A",
      campaign: "Camp 1",
      thumbnail_url: "https://img/ad1.jpg",
    });
    expect(Number(ad1.spend)).toBe(30);
    expect(Number(ad1.players)).toBe(2);
    expect(Number(ad1.revenue)).toBe(160);
    expect(Number(ad1.net)).toBe(130);
    expect(Number(ad2.spend)).toBe(20);
    expect(Number(ad2.players)).toBe(1);
  });

  it("campanha soma anúncios e jogadores casados só pela campanha", async () => {
    const c1 = (await overview()).campaigns.find((row) => row.campaign_id === "C1")!;
    expect(Number(c1.players)).toBe(3);
    expect(Number(c1.spend)).toBe(30);
  });

  it("órfãos e ambíguos aparecem no diagnóstico", async () => {
    const rows = (await overview()).orphanAttributions;
    expect(rows.map((row) => row.creative).sort()).toEqual(["Video A", "zzz"]);
  });

  it("série diária cobre o período inteiro", async () => {
    const daily = (await overview()).daily;
    expect(daily).toHaveLength(7);
    expect(daily[0]).toMatchObject({ date: "2026-10-01", label: "01/10" });
    expect(Number(daily[3].spend)).toBe(60);
    expect(Number(daily[6].ftd)).toBe(1);
  });

  it("período sem dados devolve zeros, sem divisão por zero", async () => {
    const o = await overview("2025-01-01", "2025-01-02");
    expect(Number(o.totals.spend)).toBe(0);
    expect(o.totals.roas).toBeNull();
    expect(o.totals.cpaFtd).toBeNull();
    expect(o.creatives).toEqual([]);
  });

  it("recusa período invertido e acesso a outra casa", async () => {
    await expect(overview("2026-10-07", "2026-10-01")).rejects.toThrow(/Período inválido/);
    await db.exec("set test.access = 'off'");
    try {
      await expect(overview()).rejects.toThrow(/Sem acesso/);
    } finally {
      await db.exec("set test.access = 'on'");
    }
  });
});

describe("AL1-09 replace_meta_ad_metrics", () => {
  it("substitui a janela e remove o que a Meta deixou de devolver", async () => {
    const rows = JSON.stringify([
      {
        ad_id: "AD1",
        ad_name: "Video A",
        campaign_id: "C1",
        metric_date: "2026-10-02",
        spend: 12,
        currency: "brl",
        link_clicks: 7,
      },
    ]);
    await db.query("select public.replace_meta_ad_metrics($1, $2, $3::date, $4::date, $5::jsonb)", [
      T,
      BRL_ACCOUNT,
      "2026-10-02",
      "2026-10-03",
      rows,
    ]);
    const { rows: left } = await db.query<{
      metric_date: string;
      spend: string;
      currency: string;
      link_clicks: string;
    }>(
      `select metric_date::text, spend::text, currency, link_clicks::text from public.marketing_ad_metrics_daily
       where tenant_id = $1 and ad_account_id = $2 and metric_date between '2026-10-02' and '2026-10-03'
       order by metric_date, ad_id`,
      [T, BRL_ACCOUNT],
    );
    expect(left).toEqual([
      { metric_date: "2026-10-02", spend: "12.00", currency: "BRL", link_clicks: "7" },
    ]);
    // O dia 01 ficou intacto.
    const { rows: kept } = await db.query<{ n: number }>(
      `select count(*)::int n from public.marketing_ad_metrics_daily
       where tenant_id = $1 and ad_id = 'AD1' and metric_date = '2026-10-01'`,
      [T],
    );
    expect(kept[0].n).toBe(1);
  });

  it("linha sem ad_id não duplica", async () => {
    const insert = `insert into public.marketing_ad_metrics_daily (tenant_id, provider, ad_account_id, metric_date, spend)
      values ('${T}', 'csv', null, '2026-10-01', 1)`;
    await db.exec(insert);
    await expect(db.exec(insert)).rejects.toThrow(/unique|duplicate/i);
  });
});
