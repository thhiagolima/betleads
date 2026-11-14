// U1 de ESCOPO_ORIGEM_UTM_2026-11-14: attribution_channel e origin_breakdown.
// supabase/migrations/20261231101000_origem_utm_u1.sql

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const U1 = readFileSync(
  resolve(root, "supabase/migrations/20261231101000_origem_utm_u1.sql"),
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
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, utm_id text,
  affiliate_id text, expert text);
create table public.deposits (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
create table public.withdrawals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, player_id uuid,
  valor numeric, status text, created_at timestamptz);
create table public.meta_ads (
  tenant_id uuid, ad_account_id text, ad_id text, ad_name text, campaign_id text,
  campaign_name text, adset_id text, adset_name text);
create table public.player_attributions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, player_id uuid not null,
  event_type text not null default 'signup', provider text, utm_source text, utm_medium text,
  utm_campaign text, utm_content text, utm_term text, utm_id text,
  fbclid text, gclid text, gbraid text, wbraid text, ttclid text, bl_click_id uuid,
  unique (tenant_id, player_id, event_type));
`;

const T = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const P = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const CAMP = "120250280510370075";
const AD = "120250280510370900";
const AD2 = "120250280510370901";
const SET = "120250280510370800";

// Tudo entre 01/10 e 03/10 (BRT), exceto P(9) (fora do período) e P(10) (outra casa).
const SEED = `
insert into public.tenants values ('${T}', 'casa'), ('${OTHER}', 'outra');
insert into public.meta_ads (tenant_id, ad_account_id, ad_id, ad_name, campaign_id, campaign_name,
  adset_id, adset_name) values
  ('${T}', 'act_1', '${AD}', 'Video Pastel', '${CAMP}', 'CBO Novembro', '${SET}', 'Publico Amplo');

insert into public.players (id, tenant_id, created_at, ftd_em, utm_source, affiliate_id, expert) values
  ('${P(1)}', '${T}', '2026-10-01 12:00+00', '2026-10-01 13:00+00', null, null, null),
  ('${P(2)}', '${T}', '2026-10-01 12:00+00', null, null, null, null),
  ('${P(3)}', '${T}', '2026-10-02 12:00+00', '2026-10-02 13:00+00', null, null, null),
  ('${P(4)}', '${T}', '2026-10-02 12:00+00', null, null, null, null),
  ('${P(5)}', '${T}', '2026-10-02 12:00+00', null, 'betleads', null, null),
  ('${P(6)}', '${T}', '2026-10-03 12:00+00', null, null, null, null),
  ('${P(7)}', '${T}', '2026-10-03 12:00+00', null, null, 'AFF9', 'Fulano'),
  ('${P(8)}', '${T}', '2026-10-03 12:00+00', '2026-09-01 00:00+00', null, null, null),
  ('${P(9)}', '${T}', '2026-10-20 12:00+00', null, 'ig', null, null),
  ('${P(10)}', '${OTHER}', '2026-10-01 12:00+00', null, 'ig', null, null),
  ('${P(11)}', '${T}', '2026-10-03 12:00+00', null, null, null, null),
  ('${P(12)}', '${T}', '2026-10-03 12:00+00', null, null, 'AFF9', 'Fulano');

insert into public.player_attributions
  (tenant_id, player_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, bl_click_id) values
  ('${T}', '${P(1)}', 'ig', 'paid', '${CAMP}', '${AD}', '${SET}', 'fb.1', null),
  ('${T}', '${P(2)}', 'IG ', 'paid', '${CAMP}', '${AD2}', '${SET}', null, null),
  ('${T}', '${P(3)}', 'instagram', 'live', 'live_12_11', 'botao', null, null, null),
  ('${T}', '${P(4)}', 'fb', 'paid', 'CBO LA ELE', 'AD - 4', 'CONJUNTO - 4', null, null),
  ('${T}', '${P(6)}', null, null, null, null, null, 'fb.2', null),
  -- Link do SMS do CRM com a utm_source da casa: o bl_click_id manda.
  ('${T}', '${P(11)}', 'instagram', 'paid', 'x', null, null, null, gen_random_uuid()),
  ('${T}', '${P(12)}', 'kwai', null, 'k1', null, null, null, null);

insert into public.deposits (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 100, 'aprovado', '2026-10-01 13:00+00'),
  ('${T}', '${P(1)}', 50, 'aprovado', '2026-11-05 12:00+00'),
  ('${T}', '${P(1)}', 999, 'pendente', '2026-10-05 13:00+00'),
  ('${T}', '${P(3)}', 40, 'aprovado', '2026-10-02 13:00+00'),
  ('${T}', '${P(8)}', 70, 'aprovado', '2026-10-03 13:00+00'),
  ('${T}', '${P(7)}', 30, 'aprovado', '2026-10-03 13:00+00'),
  ('${T}', '${P(5)}', 500, 'aprovado', '2026-10-03 13:00+00');
insert into public.withdrawals (tenant_id, player_id, valor, status, created_at) values
  ('${T}', '${P(1)}', 20, 'aprovado', '2026-10-06 12:00+00'),
  ('${T}', '${P(1)}', 900, 'pendente', '2026-10-06 12:00+00');
`;

type Row = {
  key: string | null;
  raw: string | null;
  channel: string;
  metaName: string | null;
  signups: number;
  ftd: number;
  ftdValue: number;
  deposits: number;
  withdrawals: number;
};
type Breakdown = {
  totals: Record<string, number>;
  coverage: Record<string, number>;
  noOrigin: Record<string, number>;
  crm: { signups: number; byLink: number };
  totalRows: number;
  rows: Row[];
  others: Record<string, number>;
  daily: Array<{ date: string; signups: number; withOrigin: number; ftd: number }>;
};

let db: PGlite;

async function breakdown(
  group = "channel",
  filters: Record<string, unknown> = {},
  opts: { from?: string; to?: string; includeCrm?: boolean; limit?: number; tenant?: string } = {},
): Promise<Breakdown> {
  const { rows } = await db.query<{ o: Breakdown }>(
    "select public.origin_breakdown($1, $2::date, $3::date, $4, $5::jsonb, $6, $7) o",
    [
      opts.tenant ?? T,
      opts.from ?? "2026-10-01",
      opts.to ?? "2026-10-07",
      group,
      JSON.stringify(filters),
      opts.includeCrm ?? false,
      opts.limit ?? 100,
    ],
  );
  return rows[0].o;
}

const channel = async (...args: unknown[]) => {
  const { rows } = await db.query<{ c: string }>(
    "select public.attribution_channel($1, $2, $3, $4, $5, $6) c",
    args,
  );
  return rows[0].c;
};

const byKey = (b: Breakdown) => Object.fromEntries(b.rows.map((r) => [r.key, r]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(U1);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("attribution_channel", () => {
  it("junta fontes sujas da Meta e separa live", async () => {
    expect(await channel("ig", "paid", true, false, false, false)).toBe("meta");
    expect(await channel(" FB ", null, false, false, false, false)).toBe("meta");
    expect(await channel("an", "paid", false, false, false, false)).toBe("meta");
    expect(await channel("instagram", "live", true, false, false, false)).toBe("live");
  });

  it("reconhece outros canais", async () => {
    expect(await channel("kwai", null, true, false, false, false)).toBe("kwai");
    expect(await channel("ifluxhub", "sms", true, false, false, false)).toBe("mensagens");
    expect(await channel("chatgpt.com", null, false, false, false, false)).toBe("busca");
    expect(await channel("wa", "paid", false, false, false, false)).toBe("whatsapp");
    expect(await channel("betleads", "sms", true, false, false, false)).toBe("crm");
    expect(await channel("parceiro", "afiliado", false, false, false, false)).toBe("afiliados");
    expect(await channel("xpto", null, false, false, false, false)).toBe("outros");
  });

  it("sem fonte nem meio usa o click ID", async () => {
    expect(await channel(null, null, false, true, false, false)).toBe("meta_sem_campanha");
    expect(await channel(null, null, true, true, false, false)).toBe("meta");
    expect(await channel(null, null, false, false, true, false)).toBe("google");
    expect(await channel(null, null, false, false, false, true)).toBe("tiktok");
    expect(await channel("", " ", false, false, false, false)).toBe("sem_origem");
  });
});

describe("origin_breakdown", () => {
  it("agrupa por canal, com CRM e sem origem fora das linhas", async () => {
    const b = await breakdown();
    const rows = byKey(b);
    expect(rows.meta.signups).toBe(3);
    expect(rows.live.signups).toBe(1);
    expect(rows.meta_sem_campanha.signups).toBe(1);
    expect(rows.afiliados.signups).toBe(1);
    expect(rows.kwai.signups).toBe(1);
    expect(rows.sem_origem).toBeUndefined();
    expect(rows.crm).toBeUndefined();

    // P(5) betleads e P(11) com bl_click_id.
    expect(b.crm).toEqual({ signups: 2, byLink: 1 });
    // P(8) sem nada.
    expect(b.noOrigin.signups).toBe(1);
    // Fora: CRM (2), outro período, outra casa.
    expect(b.totals.signups).toBe(8);
    expect(b.coverage).toEqual({
      signups: 8,
      withUtm: 5,
      affiliateOnly: 1,
      clickOnly: 1,
      noOrigin: 1,
    });
  });

  it("soma a coorte desde o cadastro até hoje, só aprovados", async () => {
    const b = await breakdown();
    const meta = byKey(b).meta;
    expect(meta.ftd).toBe(1);
    expect(meta.ftdValue).toBe(100);
    expect(meta.deposits).toBe(150);
    expect(meta.withdrawals).toBe(20);
    // ftd_em da casa um mês antes: o depósito não é o 1º.
    expect(b.noOrigin.ftd).toBe(0);
    expect(b.noOrigin.deposits).toBe(70);
    expect(b.totals.ftd).toBe(3);
    expect(b.totals.net).toBe(100 + 50 + 40 + 70 + 30 - 20);
  });

  it("inclui o CRM quando pedido", async () => {
    const b = await breakdown("channel", {}, { includeCrm: true });
    expect(byKey(b).crm.signups).toBe(2);
    expect(b.totals.signups).toBe(10);
  });

  it("normaliza a chave e guarda o valor bruto mais comum", async () => {
    const b = await breakdown("source", { channel: "meta" });
    const rows = byKey(b);
    expect(rows.ig.signups).toBe(2);
    expect(rows.fb.signups).toBe(1);
    expect(b.noOrigin.signups).toBe(0);
  });

  it("drill-down com nome do catálogo da Meta para IDs", async () => {
    const camp = byKey(await breakdown("campaign", { channel: "meta" }));
    expect(camp[CAMP].metaName).toBe("CBO Novembro");
    expect(camp[CAMP].signups).toBe(2);
    expect(camp["cbo la ele"].raw).toBe("CBO LA ELE");
    expect(camp["cbo la ele"].metaName).toBeNull();

    const ads = byKey(await breakdown("content", { channel: "meta", campaign: CAMP }));
    expect(ads[AD].metaName).toBe("Video Pastel");
    expect(ads[AD2].metaName).toBeNull();

    const sets = byKey(await breakdown("term", { campaign: CAMP }));
    expect(sets[SET].metaName).toBe("Publico Amplo");
  });

  it("filtro por valor vazio pega quem não tem o campo", async () => {
    const b = await breakdown("campaign", { channel: "meta_sem_campanha", campaign: null });
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].key).toBeNull();
  });

  it("agrupa por afiliado com o nome do expert", async () => {
    const b = await breakdown("affiliate");
    const aff = byKey(b).aff9;
    // P(7) sem UTM e P(12) com UTM do Kwai: o afiliado vale nos dois.
    expect(aff.signups).toBe(2);
    expect(aff.raw).toBe("AFF9");
    expect(aff.metaName).toBe("Fulano");
  });

  it("busca e só com 1º depósito", async () => {
    expect((await breakdown("channel", { search: "pastel" })).totals.signups).toBe(0);
    expect((await breakdown("channel", { search: "live_12" })).totals.signups).toBe(1);
    expect((await breakdown("channel", { search: "fulano" })).totals.signups).toBe(2);
    const ftd = await breakdown("channel", { onlyFtd: true });
    expect(ftd.totals.signups).toBe(3);
    expect(ftd.totals.ftd).toBe(3);
  });

  it("corta em _limit e soma o resto em others", async () => {
    const b = await breakdown("channel", {}, { limit: 2 });
    expect(b.rows).toHaveLength(2);
    expect(b.totalRows).toBe(5);
    expect(b.others.count).toBe(3);
    expect(b.rows[0].key).toBe("meta");
  });

  it("série diária por dia de Brasília", async () => {
    const b = await breakdown("channel", {}, { from: "2026-10-01", to: "2026-10-03" });
    expect(b.daily.map((d) => [d.signups, d.withOrigin, d.ftd])).toEqual([
      [2, 2, 1],
      [2, 2, 1],
      [4, 3, 1],
    ]);
  });

  it("isola a casa e recusa sem acesso ou período longo", async () => {
    const other = await breakdown("channel", {}, { tenant: OTHER });
    expect(other.totals.signups).toBe(1);

    await expect(
      breakdown("channel", {}, { from: "2026-01-01", to: "2026-10-01" }),
    ).rejects.toThrow(/93 dias/);
    await expect(breakdown("nope")).rejects.toThrow(/Agrupamento/);
    await db.exec("set test.access = 'off'");
    try {
      await expect(breakdown()).rejects.toThrow(/Sem acesso/);
    } finally {
      await db.exec("set test.access = 'on'");
    }
  });
});
