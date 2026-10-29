// Task 9 — invented demo finance data (daily ad spend/GGR, rates, goals,
// other costs) and the "Grupo Demo" group, on a PGlite database with every
// migration applied (real columns, constraints and triggers).
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KEEP_ON_RESET } from "./clone-plan.mjs";
import { seedDemoFinance } from "./seed-demo-finance.mjs";
import { createMigratedDb } from "./test-support/migrated-pglite.mjs";

const DEMO = "6a1d2c3b-0000-4000-8000-000000000f01";
const DAYS = 10;

let db: PGlite;

async function financeDaily() {
  const { rows } = await db.query<{ metric_date: string; ad_spend: string; ggr: string | null }>(
    `select metric_date::text as metric_date, ad_spend::text as ad_spend, ggr::text as ggr
       from public.tenant_finance_daily where tenant_id = $1 order by metric_date`,
    [DEMO],
  );
  return rows;
}

async function otherCosts() {
  const { rows } = await db.query<{ descricao: string; categoria: string | null; valor: string }>(
    `select descricao, categoria, valor::text as valor from public.tenant_finance_other_costs
      where tenant_id = $1 order by descricao`,
    [DEMO],
  );
  return rows;
}

// Mirrors src/lib/finance/categories.ts' BETLEADS_COST_PATTERN: the real
// check the finance dashboard applies to flag a cost as a duplicated
// Betleads charge.
const BETLEADS_COST_PATTERN = /\b(sms|betleads|mensalidade|voz|e-?mail|crm)\b/i;

async function betleadsUsage() {
  const { rows } = await db.query<{ metric_date: string; amount: string }>(
    `select metric_date::text as metric_date, amount::text as amount
       from public.finance_betleads_usage($1::uuid[], (current_date - 400), current_date)
      order by metric_date`,
    [[DEMO]],
  );
  return rows;
}

async function walletIntegrity() {
  const { rows } = await db.query<{ tenant_id: string }>(`select tenant_id from public.billing_wallet_integrity()`);
  return rows;
}

async function betleadsFees(fromMonth: string, toMonth: string) {
  const { rows } = await db.query<{ month: string; amount: string }>(
    `select month::text as month, amount::text as amount
       from public.finance_betleads_fees($1::uuid[], $2::date, $3::date)
      order by month`,
    [[DEMO], fromMonth, toMonth],
  );
  return rows;
}

async function invoiceCount() {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.billing_invoices where tenant_id = $1`,
    [DEMO],
  );
  return rows[0].n;
}

beforeAll(async () => {
  ({ db } = await createMigratedDb());
  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo) values ($1, 'Casa Betleads', 'demo-9', 'active', 'pro', true)`,
    [DEMO],
  );
  // DAYS consecutive days ending today, increasing ftds/deposits so the two
  // most recent days are easy to tell apart from the rest.
  await db.query(
    `insert into public.tenant_daily_metrics (tenant_id, metric_date, ftds, approved_deposit_amount, approved_withdrawal_amount)
     select $1, (current_date - (${DAYS - 1} - i)), 10 + i, 1000 + i * 10, 200 + i * 2
       from generate_series(0, ${DAYS - 1}) i`,
    [DEMO],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("seedDemoFinance", () => {
  it("is deterministic: running twice leaves the same rows", async () => {
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const firstDaily = await financeDaily();
    const firstCosts = await otherCosts();
    const firstUsage = await betleadsUsage();

    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const secondDaily = await financeDaily();
    const secondCosts = await otherCosts();
    const secondUsage = await betleadsUsage();

    expect(secondDaily).toEqual(firstDaily);
    expect(secondCosts).toEqual(firstCosts);
    expect(secondUsage).toEqual(firstUsage);
    expect(firstDaily).toHaveLength(DAYS);
    expect(firstUsage).toHaveLength(DAYS);
  });

  it("seeds a Betleads usage ledger row for every day, keeping the wallet consistent", async () => {
    const usage = await betleadsUsage();
    expect(usage).toHaveLength(DAYS);
    // uniform(80, 200, ...): every day's net cost falls in that range.
    for (const row of usage) expect(Number(row.amount)).toBeGreaterThan(0);
    for (const row of usage) expect(Number(row.amount)).toBeLessThan(200);

    const integrity = await walletIntegrity();
    expect(integrity).toEqual([]);

    const { rows: wallet } = await db.query<{ balance: string }>(
      `select balance::text as balance from public.tenant_wallets where tenant_id = $1`,
      [DEMO],
    );
    expect(Number(wallet[0].balance)).toBeGreaterThanOrEqual(0);
  });

  // Every `__demo_seed__` invoice (the ones this function controls) is a
  // paid 400000-cent invoice dated the 1st. Fix round 1: a month the
  // `tenants_billing_plano` trigger already billed (through its own, not
  // `__demo_seed__`, invoice) is deliberately skipped — see the
  // finance_betleads_fees test below for the no-double-billing guarantee.
  it("seeds one paid invoice per seeded month not already billed by the trigger, amount_cents 400000, period_start on the 1st", async () => {
    const { rows: invoices } = await db.query<{
      period_start: string;
      status: string;
      amount_cents: number;
    }>(
      `select period_start::text as period_start, status, amount_cents
         from public.billing_invoices where tenant_id = $1 and manual_note = '__demo_seed__'
        order by period_start`,
      [DEMO],
    );
    for (const inv of invoices) {
      expect(inv.status).toBe("paid");
      expect(inv.amount_cents).toBe(400000);
      expect(inv.period_start.endsWith("-01")).toBe(true);
    }

    // Every seeded month is billed exactly once, by either the seed's own
    // invoice or some other (the trigger's).
    const { rows: months } = await db.query<{ month: string }>(
      `select distinct date_trunc('month', metric_date)::date::text as month
         from public.tenant_daily_metrics where tenant_id = $1`,
      [DEMO],
    );
    expect(months.length).toBeGreaterThan(0);
    for (const { month } of months) {
      const { rows: billed } = await db.query<{ n: number }>(
        `select count(*)::int as n from public.billing_invoices
          where tenant_id = $1 and status in ('open', 'paid')
            and date_trunc('month', period_start)::date = $2::date`,
        [DEMO, month],
      );
      expect(billed[0].n).toBe(1);
    }
  });

  // Fix round 1: the `tenants_billing_plano` trigger (fired by the demo
  // tenant insert in beforeAll, through the real trigger path — not
  // bypassed here) already issued its own `open`, upfront, 400000-cent
  // invoice for the month of billing_today() (= today, since no test clock
  // is set). finance_betleads_fees must still show exactly R$ 4000 for that
  // month (not R$ 8000 from double-counting both invoices), and for every
  // other seeded month.
  it("finance_betleads_fees is exactly 4000 per seeded month, including the trigger's own invoice month", async () => {
    const { rows: range } = await db.query<{ first_month: string; current_month: string }>(
      `select date_trunc('month', min(metric_date))::date::text as first_month,
              date_trunc('month', current_date)::date::text as current_month
         from public.tenant_daily_metrics where tenant_id = $1`,
      [DEMO],
    );
    const fees = await betleadsFees(range[0].first_month, range[0].current_month);
    expect(fees.length).toBeGreaterThan(0);
    for (const fee of fees) expect(Number(fee.amount)).toBe(4000);
  });

  it("seeding twice does not change the demo house's total invoice count", async () => {
    const before = await invoiceCount();
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const after = await invoiceCount();
    expect(after).toBe(before);
  });

  it("no seeded other cost looks like a duplicated Betleads charge", async () => {
    const costs = await otherCosts();
    expect(costs.length).toBeGreaterThan(0);
    for (const cost of costs) {
      expect(BETLEADS_COST_PATTERN.test(cost.descricao)).toBe(false);
      if (cost.categoria) expect(BETLEADS_COST_PATTERN.test(cost.categoria)).toBe(false);
    }
  });

  it("other costs are dated the 5th (the month's last seeded day when earlier) and Equipe repeats as one series", async () => {
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const { rows } = await db.query<{
      descricao: string;
      cost_date: string;
      expected: string;
      repeat_monthly: boolean;
      series_id: string | null;
    }>(
      `select c.descricao, c.cost_date::text as cost_date, c.repeat_monthly, c.series_id,
              least(c.month + 4, (select max(m.metric_date) from public.tenant_daily_metrics m
                                   where m.tenant_id = c.tenant_id
                                     and date_trunc('month', m.metric_date)::date = c.month))::text as expected
         from public.tenant_finance_other_costs c
        where c.tenant_id = $1
        order by c.cost_date, c.descricao`,
      [DEMO],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.cost_date).toBe(row.expected);
    const equipe = rows.filter((row) => row.descricao === "Equipe de atendimento");
    const others = rows.filter((row) => row.descricao !== "Equipe de atendimento");
    expect(equipe.every((row) => row.repeat_monthly && row.series_id !== null)).toBe(true);
    expect(new Set(equipe.map((row) => row.series_id)).size).toBe(1);
    expect(others.every((row) => !row.repeat_monthly && row.series_id === null)).toBe(true);
    // The latest Equipe is already in the current month: nothing to copy.
    const { rows: made } = await db.query<{ n: number }>(
      `select public.finance_materialize_recurring_costs(current_date) as n`,
    );
    expect(made[0].n).toBe(0);
  });

  it("removes a previous seed's CRM/SMS other costs", async () => {
    await db.query(
      `insert into public.tenant_finance_other_costs (id, tenant_id, month, descricao, valor, created_by)
       values (gen_random_uuid(), $1, date_trunc('month', current_date)::date, 'CRM', 1500, null)`,
      [DEMO],
    );
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const costs = await otherCosts();
    expect(costs.some((c) => c.descricao === "CRM")).toBe(false);
  });

  it("only the most recent day is pending (no GGR); every earlier day has one", async () => {
    const rows = await financeDaily();
    const pending = rows.slice(-1);
    const settled = rows.slice(0, -1);
    expect(pending).toHaveLength(1);
    expect(pending.every((r) => r.ggr === null)).toBe(true);
    expect(settled.every((r) => r.ggr !== null)).toBe(true);
    // Ad spend is filled for every day, including the pending ones.
    expect(rows.every((r) => r.ad_spend !== null)).toBe(true);
  });

  it("demo group exists with the demo tenant and survives a reset-style delete", async () => {
    const { rows } = await db.query<{ id: string; is_demo: boolean }>(
      `select tg.id, tg.is_demo from public.tenant_groups tg
         join public.tenant_group_tenants gt on gt.group_id = tg.id
        where gt.tenant_id = $1`,
      [DEMO],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_demo).toBe(true);
    expect(rows[0].id).toBeTruthy();

    // Simulate the reset/clone delete loop in clone-core.mjs: every
    // tenant_id table is wiped for the demo tenant unless KEEP_ON_RESET.
    const { rows: tables } = await db.query<{ table_name: string }>(
      `select distinct c.table_name from information_schema.columns c
         join information_schema.tables x using (table_schema, table_name)
        where c.table_schema = 'public' and x.table_type = 'BASE TABLE' and c.column_name = 'tenant_id'`,
    );
    for (const { table_name } of tables) {
      if (KEEP_ON_RESET(table_name)) continue;
      await db.query(`delete from public.${table_name} where tenant_id = $1`, [DEMO]);
    }

    const { rows: after } = await db.query<{ tenant_id: string }>(
      `select tenant_id from public.tenant_group_tenants where tenant_id = $1`,
      [DEMO],
    );
    expect(after).toHaveLength(1);
    // tenant_finance_daily has tenant_id and is NOT KEEP_ON_RESET: it is
    // wiped by the same loop, same as every other invented finance table —
    // seedDemoFinance repopulates it afterwards in the real clone run.
    expect(await financeDaily()).toEqual([]);

    // In the real clone, REBUILT_TABLES (tenant_daily_metrics included) is
    // recomputed between the wipe and the seedDemoFinance call; redo that
    // part of the fixture here, then reseed so later tests see the data again.
    await db.query(
      `insert into public.tenant_daily_metrics (tenant_id, metric_date, ftds, approved_deposit_amount, approved_withdrawal_amount)
       select $1, (current_date - (${DAYS - 1} - i)), 10 + i, 1000 + i * 10, 200 + i * 2
         from generate_series(0, ${DAYS - 1}) i`,
      [DEMO],
    );
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
  });

  it("rates and goals seeded from the earliest day, and current-month other costs", async () => {
    const { rows: rates } = await db.query<{ ggr_fee_pct: string; movement_fee_pct: string }>(
      `select ggr_fee_pct::text as ggr_fee_pct, movement_fee_pct::text as movement_fee_pct
         from public.tenant_finance_rates where tenant_id = $1`,
      [DEMO],
    );
    expect(rates).toHaveLength(1);
    expect(Number(rates[0].ggr_fee_pct)).toBe(16);
    expect(Number(rates[0].movement_fee_pct)).toBe(2.7);

    const { rows: goals } = await db.query<{ metric: string; direction: string; daily_value: string }>(
      `select metric, direction, daily_value::text as daily_value from public.tenant_goals
        where tenant_id = $1 order by metric`,
      [DEMO],
    );
    expect(goals).toHaveLength(2);
    const ftdsGoal = goals.find((g) => g.metric === "ftds")!;
    const costGoal = goals.find((g) => g.metric === "cost_per_ftd")!;
    expect(ftdsGoal.direction).toBe("gte");
    // 10 days of ftds = 10..19, mean 14.5; ceil(14.5 * 1.1) = 16.
    expect(Number(ftdsGoal.daily_value)).toBe(16);
    expect(costGoal.direction).toBe("lte");
    expect(Number(costGoal.daily_value)).toBe(90);

    const costs = await otherCosts();
    expect(costs.map((c) => c.descricao).sort()).toEqual(["Equipe de atendimento", "Influenciador X"]);
    expect(costs.map((c) => c.categoria).sort()).toEqual(["Afiliados e influenciadores", "Equipe"]);
    for (const cost of costs) expect(Number(cost.valor)).toBeGreaterThan(0);
  });

  it("demoUserIds become managers of the demo group", async () => {
    const userId = "6a1d2c3b-0000-4000-8000-00000000da01";
    await db.query(
      `insert into auth.users (id, email, raw_app_meta_data) values ($1, 'demo+x@betleads.io', '{"is_demo_user":true}'::jsonb)`,
      [userId],
    );

    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS, demoUserIds: [userId] });

    const { rows: group } = await db.query<{ id: string }>(
      `select tg.id from public.tenant_groups tg
         join public.tenant_group_tenants gt on gt.group_id = tg.id
        where gt.tenant_id = $1`,
      [DEMO],
    );
    const { rows: managers } = await db.query<{ group_id: string; user_id: string }>(
      `select group_id, user_id from public.tenant_group_managers where group_id = $1`,
      [group[0].id],
    );
    expect(managers).toEqual([{ group_id: group[0].id, user_id: userId }]);

    // Rerunning (as a reseed would) doesn't duplicate the manager row.
    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS, demoUserIds: [userId] });
    const { rows: again } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.tenant_group_managers where group_id = $1`,
      [group[0].id],
    );
    expect(again[0].n).toBe(1);
  });
});
