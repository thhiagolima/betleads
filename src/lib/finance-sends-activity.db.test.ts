// SQL test for
// supabase/migrations/20261113100000_finance_sends_activity.sql:
//   - finance_send_usage: one row per house x Sao Paulo day x item over
//     usage_reservation/usage_refund wallet_ledger rows (same window filter
//     and distinct-tenant handling as finance_betleads_usage,
//     20261112100000). Paying houses report -sum(amount); exempt houses
//     report units x provider_unit_cost over rows that have a cost, plus
//     the net units of rows missing a cost (missing_cost_units).
//   - finance_activity_days: one row per house x day (generate_series, like
//     finance_days, 20261101100100), left-joining tenant_daily_metrics,
//     crm_results_daily (summed) and marketing_ad_metrics_daily (meta only),
//     all coalesced to 0.
//
// Tables are minimal stubs with only the columns these two functions read;
// billing_tenant_exempt is copied from 20261022100000_billing_price_book.sql
// (same as finance-exempt-provider-cost.db.test.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261113100000_finance_sends_activity.sql"),
  "utf8",
);

const EXEMPT = "00000000-0000-4000-8000-00000000f0a1";
const PAYING = "00000000-0000-4000-8000-00000000f0a2";

const SCHEMA = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE TABLE public.tenants (
    id uuid PRIMARY KEY,
    nome text NOT NULL,
    plano text
  );

  CREATE TABLE public.billing_plans (
    code text PRIMARY KEY,
    exempt_all boolean NOT NULL DEFAULT false
  );
  INSERT INTO public.billing_plans (code, exempt_all) VALUES
    ('crm_unico', false),
    ('interno', true);

  -- Same body as prod (20261022100000_billing_price_book.sql).
  CREATE OR REPLACE FUNCTION public.billing_tenant_exempt(_tenant uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
    SELECT coalesce(
      (
        SELECT bp.exempt_all
        FROM public.tenants t
        JOIN public.billing_plans bp ON bp.code = t.plano
        WHERE t.id = _tenant
      ),
      false
    )
  $$;

  -- Minimal wallet_ledger (real columns in 20261022100100_billing_wallet.sql).
  CREATE TABLE public.wallet_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    entry_type text NOT NULL CHECK (
      entry_type IN ('purchase', 'manual_adjustment', 'usage_reservation', 'usage_refund', 'migration')
    ),
    item text NULL,
    units integer NULL,
    provider_unit_cost numeric(12,4) NULL,
    amount numeric(14,4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Minimal tenant_daily_metrics (real in 20261002170000_optimize_analytics_queries.sql).
  CREATE TABLE public.tenant_daily_metrics (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    metric_date date NOT NULL,
    approved_deposit_count integer NOT NULL DEFAULT 0,
    approved_depositor_count integer NOT NULL DEFAULT 0,
    approved_withdrawal_count integer NOT NULL DEFAULT 0,
    generated_pix_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, metric_date)
  );

  -- Minimal crm_results_daily (real in 20261016130000_crm_results_daily.sql).
  CREATE TABLE public.crm_results_daily (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    metric_date date NOT NULL,
    sent integer NOT NULL DEFAULT 0,
    human_clicks integer NOT NULL DEFAULT 0,
    direct_conversions integer NOT NULL DEFAULT 0,
    direct_revenue numeric NOT NULL DEFAULT 0,
    influenced_revenue numeric NOT NULL DEFAULT 0
  );

  -- Minimal marketing_ad_metrics_daily (real in
  -- 20260917164000_create_marketing_ads_tables.sql + link_clicks added by
  -- 20261019100000_aquisicao_ltv_al1.sql).
  CREATE TABLE public.marketing_ad_metrics_daily (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    provider text NOT NULL,
    metric_date date NOT NULL,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    link_clicks bigint NOT NULL DEFAULT 0
  );
`;

let db: PGlite;

function isoDay(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function sendUsageRows(tenants: string[], from: string, to: string) {
  const { rows } = await db.query<{
    tenant_id: string;
    metric_date: string | Date;
    item: string;
    units: string;
    amount: string;
    missing_cost_units: string;
  }>(
    `select * from public.finance_send_usage(array[${tenants
      .map((t) => `'${t}'`)
      .join(",")}]::uuid[], '${from}', '${to}') order by tenant_id, metric_date, item`,
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    date: isoDay(r.metric_date),
    item: r.item,
    units: Number(r.units),
    amount: Number(r.amount),
    missing_cost_units: Number(r.missing_cost_units),
  }));
}

async function activityDaysRows(tenants: string[], from: string, to: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from public.finance_activity_days(array[${tenants
      .map((t) => `'${t}'`)
      .join(",")}]::uuid[], '${from}', '${to}') order by tenant_id, metric_date`,
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id as string,
    date: isoDay(r.metric_date as string | Date),
    deposit_count: Number(r.deposit_count),
    depositor_count: Number(r.depositor_count),
    withdrawal_count: Number(r.withdrawal_count),
    generated_pix_count: Number(r.generated_pix_count),
    crm_sent: Number(r.crm_sent),
    crm_clicks: Number(r.crm_clicks),
    crm_direct_conversions: Number(r.crm_direct_conversions),
    crm_direct_revenue: Number(r.crm_direct_revenue),
    crm_influenced_revenue: Number(r.crm_influenced_revenue),
    ad_impressions: Number(r.ad_impressions),
    ad_clicks: Number(r.ad_clicks),
  }));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION);
  await db.exec(`
    INSERT INTO public.tenants (id, nome, plano) VALUES
      ('${EXEMPT}', 'Casa Interna', 'interno'),
      ('${PAYING}', 'Casa Paga', 'crm_unico');
  `);
});

afterAll(async () => {
  await db.close();
});

describe("finance_send_usage for a paying house", () => {
  it("splits by channel with units and amount", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, item, units, provider_unit_cost, amount, created_at) values
        ('${PAYING}', 'usage_reservation', 'sms', 10, null, -0.8, '2026-11-01T15:00:00Z'),
        ('${PAYING}', 'usage_refund', 'sms', 2, null, 0.16, '2026-11-01T16:00:00Z'),
        ('${PAYING}', 'usage_reservation', 'email', 5, null, -0.25, '2026-11-01T17:00:00Z')
    `);

    const rows = await sendUsageRows([PAYING], "2026-11-01", "2026-11-01");
    expect(rows).toEqual([
      {
        tenant_id: PAYING,
        date: "2026-11-01",
        item: "email",
        units: 5,
        amount: 0.25,
        missing_cost_units: 0,
      },
      {
        tenant_id: PAYING,
        date: "2026-11-01",
        item: "sms",
        units: 8,
        amount: 0.64,
        missing_cost_units: 0,
      },
    ]);
  });
});

describe("finance_send_usage for an exempt house", () => {
  it("uses provider cost and reports missing-cost units", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, item, units, provider_unit_cost, amount, created_at) values
        ('${EXEMPT}', 'usage_reservation', 'voice_30s', 4, null, 0, '2026-11-02T15:00:00Z'),
        ('${EXEMPT}', 'usage_reservation', 'sms', 10, 0.059, 0, '2026-11-02T15:00:00Z')
    `);

    const rows = await sendUsageRows([EXEMPT], "2026-11-02", "2026-11-02");
    expect(rows).toEqual([
      {
        tenant_id: EXEMPT,
        date: "2026-11-02",
        item: "sms",
        units: 10,
        amount: 0.59,
        missing_cost_units: 0,
      },
      {
        tenant_id: EXEMPT,
        date: "2026-11-02",
        item: "voice_30s",
        units: 4,
        amount: 0,
        missing_cost_units: 4,
      },
    ]);
  });

  it("a tenant listed twice is counted once", async () => {
    const rows = await sendUsageRows([EXEMPT, EXEMPT], "2026-11-02", "2026-11-02");
    expect(rows).toHaveLength(2);
  });
});

describe("finance_activity_days", () => {
  it("returns one row per day with zeros", async () => {
    await db.query(`
      insert into public.tenant_daily_metrics
        (tenant_id, metric_date, approved_deposit_count, approved_depositor_count, approved_withdrawal_count, generated_pix_count)
      values ('${PAYING}', '2026-11-05', 3, 2, 1, 4)
    `);

    const rows = await activityDaysRows([PAYING], "2026-11-04", "2026-11-06");
    expect(rows.map((r) => r.date)).toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(rows[0]).toMatchObject({
      deposit_count: 0,
      depositor_count: 0,
      withdrawal_count: 0,
      generated_pix_count: 0,
      crm_sent: 0,
      ad_impressions: 0,
    });
    expect(rows[1]).toMatchObject({
      deposit_count: 3,
      depositor_count: 2,
      withdrawal_count: 1,
      generated_pix_count: 4,
    });
    expect(rows[2]).toMatchObject({ deposit_count: 0 });
  });

  it("sums crm_results_daily rows and meta metrics per day", async () => {
    await db.exec(`
      insert into public.crm_results_daily
        (tenant_id, metric_date, sent, human_clicks, direct_conversions, direct_revenue, influenced_revenue)
      values
        ('${PAYING}', '2026-11-05', 100, 10, 2, 50, 20),
        ('${PAYING}', '2026-11-05', 50, 5, 1, 25, 10);

      insert into public.marketing_ad_metrics_daily
        (tenant_id, provider, metric_date, impressions, clicks, link_clicks)
      values
        ('${PAYING}', 'meta', '2026-11-05', 1000, 40, 30),
        ('${PAYING}', 'meta', '2026-11-05', 500, 10, 0),
        ('${PAYING}', 'google', '2026-11-05', 9999, 9999, 9999);
    `);

    const rows = await activityDaysRows([PAYING], "2026-11-05", "2026-11-05");
    expect(rows).toEqual([
      {
        tenant_id: PAYING,
        date: "2026-11-05",
        deposit_count: 3,
        depositor_count: 2,
        withdrawal_count: 1,
        generated_pix_count: 4,
        crm_sent: 150,
        crm_clicks: 15,
        crm_direct_conversions: 3,
        crm_direct_revenue: 75,
        crm_influenced_revenue: 30,
        // meta row 1 has link_clicks=30 (used), row 2 has link_clicks=0 (the
        // not-null default, like prod) so falls back to clicks=10; google
        // is excluded.
        ad_impressions: 1500,
        ad_clicks: 40,
      },
    ]);
  });

  it("ad_clicks falls back to clicks only when link_clicks is 0", async () => {
    const tenant = "00000000-0000-4000-8000-00000000f0a3";
    await db.query(`insert into public.tenants (id, nome, plano) values ('${tenant}', 'Casa Clicks', 'crm_unico')`);
    await db.exec(`
      insert into public.marketing_ad_metrics_daily
        (tenant_id, provider, metric_date, impressions, clicks, link_clicks)
      values
        ('${tenant}', 'meta', '2026-11-07', 100, 7, 0),
        ('${tenant}', 'meta', '2026-11-07', 100, 9, 5);
    `);

    const rows = await activityDaysRows([tenant], "2026-11-07", "2026-11-07");
    // link_clicks=0, clicks=7 -> falls back to 7; link_clicks=5, clicks=9 ->
    // uses 5 (nullif(0, 0) is null so coalesce falls back; nullif(5, 0) is
    // 5 so coalesce keeps it). Total: 7 + 5 = 12.
    expect(rows[0].ad_clicks).toBe(12);
  });

  it("duplicate tenant ids do not double rows", async () => {
    const rows = await activityDaysRows([PAYING, PAYING], "2026-11-05", "2026-11-05");
    expect(rows).toHaveLength(1);
  });
});

describe("function grants", () => {
  it("authenticated and anon cannot execute", async () => {
    const { rows } = await db.query<{ auth: boolean; anon: boolean; service: boolean }>(`
      select
        has_function_privilege('authenticated', 'public.finance_send_usage(uuid[], date, date)', 'execute')
          or has_function_privilege('authenticated', 'public.finance_activity_days(uuid[], date, date)', 'execute') as auth,
        has_function_privilege('anon', 'public.finance_send_usage(uuid[], date, date)', 'execute')
          or has_function_privilege('anon', 'public.finance_activity_days(uuid[], date, date)', 'execute') as anon,
        has_function_privilege('service_role', 'public.finance_send_usage(uuid[], date, date)', 'execute')
          and has_function_privilege('service_role', 'public.finance_activity_days(uuid[], date, date)', 'execute') as service
    `);
    expect(rows[0]).toEqual({ auth: false, anon: false, service: true });
  });
});
