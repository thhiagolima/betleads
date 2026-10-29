// SQL test for
// supabase/migrations/20261112100000_finance_exempt_provider_cost.sql:
// finance_betleads_usage reports the provider cost (units x
// provider_unit_cost) for exempt houses, which reserve with amount = 0, and
// keeps -sum(amount) for paying houses. Also finance_tenants_exempt, the
// per-house exemption flag the server uses to label the cost line.
//
// Loads the previous definition (20261103100000_finance_dashboard.sql) first,
// so the new migration is checked as a `create or replace` over it. The
// billing tables are minimal stubs; billing_tenant_exempt is copied from
// 20261022100000_billing_price_book.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_DASHBOARD = readFileSync(
  resolve(__dirname, "../..", "supabase/migrations/20261103100000_finance_dashboard.sql"),
  "utf8",
);
const MIGRATION_EXEMPT = readFileSync(
  resolve(
    __dirname,
    "../..",
    "supabase/migrations/20261112100000_finance_exempt_provider_cost.sql",
  ),
  "utf8",
);

const EXEMPT = "00000000-0000-4000-8000-00000000e0a1";
const PAYING = "00000000-0000-4000-8000-00000000e0a2";
const NO_PLAN = "00000000-0000-4000-8000-00000000e0a3";

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

  -- Minimal wallet_ledger (real columns are in 20261022100100_billing_wallet.sql).
  CREATE TABLE public.wallet_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    entry_type text NOT NULL CHECK (
      entry_type IN ('purchase', 'manual_adjustment', 'usage_reservation', 'usage_refund', 'migration')
    ),
    units integer NULL,
    provider_unit_cost numeric(12,4) NULL,
    amount numeric(14,4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Stubs the previous migration's other objects need.
  CREATE TABLE public.billing_invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    period_start date NOT NULL,
    amount_cents bigint NOT NULL,
    status text NOT NULL
  );
  CREATE TABLE public.tenant_finance_other_costs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid()
  );
`;

let db: PGlite;

function isoDay(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function usageRows(tenants: string[], from: string, to: string) {
  const { rows } = await db.query<{
    tenant_id: string;
    metric_date: string | Date;
    amount: string;
  }>(
    `select * from public.finance_betleads_usage(array[${tenants
      .map((t) => `'${t}'`)
      .join(",")}]::uuid[], '${from}', '${to}') order by tenant_id, metric_date`,
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    date: isoDay(r.metric_date),
    amount: Number(r.amount),
  }));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION_DASHBOARD);
  await db.exec(MIGRATION_EXEMPT);
  // Idempotent: a second run changes nothing and does not fail.
  await db.exec(MIGRATION_EXEMPT);
  await db.exec(`
    INSERT INTO public.tenants (id, nome, plano) VALUES
      ('${EXEMPT}', 'Casa Interna', 'interno'),
      ('${PAYING}', 'Casa Paga', 'crm_unico'),
      ('${NO_PLAN}', 'Casa Sem Plano', null);
  `);
});

afterAll(async () => {
  await db.close();
});

describe("finance_betleads_usage for an exempt house", () => {
  it("is reservation units x provider cost minus refunded units x provider cost", async () => {
    // Reservation of 100 SMS at 0,059 = 5,90; a settle-like refund gives back
    // 40 units at the reservation's provider cost = 2,36 → 3,54.
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, units, provider_unit_cost, amount, created_at) values
        ('${EXEMPT}', 'usage_reservation', 100, 0.059, 0, '2026-10-05T15:00:00Z'),
        ('${EXEMPT}', 'usage_refund', 40, 0.059, 0, '2026-10-05T16:00:00Z'),
        ('${EXEMPT}', 'usage_reservation', 10, 0.5, 0, '2026-10-06T02:30:00Z')
    `);

    const rows = await usageRows([EXEMPT], "2026-10-05", "2026-10-05");
    // 2026-10-06T02:30Z is still 2026-10-05 in São Paulo: +10 x 0,50 = 5,00.
    expect(rows).toEqual([{ tenant_id: EXEMPT, date: "2026-10-05", amount: 8.54 }]);
  });

  it("a tenant listed twice is counted once", async () => {
    const rows = await usageRows([EXEMPT, EXEMPT], "2026-10-05", "2026-10-05");
    expect(rows).toEqual([{ tenant_id: EXEMPT, date: "2026-10-05", amount: 8.54 }]);
  });

  it("a null provider cost counts as 0", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, units, provider_unit_cost, amount, created_at) values
        ('${EXEMPT}', 'usage_reservation', 50, null, 0, '2026-10-08T15:00:00Z'),
        ('${EXEMPT}', 'usage_reservation', 2, 1.25, 0, '2026-10-08T15:00:00Z'),
        ('${EXEMPT}', 'usage_refund', null, 1.25, 0, '2026-10-08T16:00:00Z')
    `);

    const rows = await usageRows([EXEMPT], "2026-10-08", "2026-10-08");
    expect(rows).toEqual([{ tenant_id: EXEMPT, date: "2026-10-08", amount: 2.5 }]);
  });

  it("ignores purchases and rows outside the window", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, units, provider_unit_cost, amount, created_at) values
        ('${EXEMPT}', 'purchase', 1000, 1, 100, '2026-10-09T15:00:00Z'),
        ('${EXEMPT}', 'usage_reservation', 3, 1, 0, '2026-10-10T15:00:00Z')
    `);

    expect(await usageRows([EXEMPT], "2026-10-09", "2026-10-09")).toEqual([]);
  });
});

describe("finance_betleads_usage for a paying house", () => {
  it("stays -sum(amount), ignoring units and provider cost", async () => {
    await db.query(`
      insert into public.wallet_ledger (tenant_id, entry_type, units, provider_unit_cost, amount, created_at) values
        ('${PAYING}', 'usage_reservation', 100, 0.059, -12, '2026-10-05T15:00:00Z'),
        ('${PAYING}', 'usage_refund', 40, 0.059, 4.8, '2026-10-05T16:00:00Z'),
        ('${NO_PLAN}', 'usage_reservation', 10, 0.059, -1.2, '2026-10-05T15:00:00Z')
    `);

    const rows = await usageRows([PAYING, NO_PLAN, EXEMPT], "2026-10-05", "2026-10-05");
    expect(rows).toEqual(
      expect.arrayContaining([
        { tenant_id: PAYING, date: "2026-10-05", amount: 7.2 },
        { tenant_id: NO_PLAN, date: "2026-10-05", amount: 1.2 },
        { tenant_id: EXEMPT, date: "2026-10-05", amount: 8.54 },
      ]),
    );
    expect(rows).toHaveLength(3);
  });
});

describe("finance_tenants_exempt", () => {
  it("returns one row per house with its current exemption", async () => {
    const { rows } = await db.query<{ tenant_id: string; exempt: boolean }>(
      `select * from public.finance_tenants_exempt(array['${EXEMPT}', '${PAYING}', '${NO_PLAN}']::uuid[]) order by tenant_id`,
    );
    expect(rows).toEqual([
      { tenant_id: EXEMPT, exempt: true },
      { tenant_id: PAYING, exempt: false },
      { tenant_id: NO_PLAN, exempt: false },
    ]);
  });
});

describe("function grants", () => {
  it("only service_role can execute", async () => {
    const { rows } = await db.query<{ auth: boolean; anon: boolean; service: boolean }>(`
      select
        has_function_privilege('authenticated', 'public.finance_betleads_usage(uuid[], date, date)', 'execute')
          or has_function_privilege('authenticated', 'public.finance_tenants_exempt(uuid[])', 'execute') as auth,
        has_function_privilege('anon', 'public.finance_betleads_usage(uuid[], date, date)', 'execute')
          or has_function_privilege('anon', 'public.finance_tenants_exempt(uuid[])', 'execute') as anon,
        has_function_privilege('service_role', 'public.finance_betleads_usage(uuid[], date, date)', 'execute')
          and has_function_privilege('service_role', 'public.finance_tenants_exempt(uuid[])', 'execute') as service
    `);
    expect(rows[0]).toEqual({ auth: false, anon: false, service: true });
  });
});
