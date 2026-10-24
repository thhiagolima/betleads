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
  const { rows } = await db.query<{ descricao: string; valor: string }>(
    `select descricao, valor::text as valor from public.tenant_finance_other_costs
      where tenant_id = $1 order by descricao`,
    [DEMO],
  );
  return rows;
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

    await seedDemoFinance(db, { demoTenantId: DEMO, days: DAYS });
    const secondDaily = await financeDaily();
    const secondCosts = await otherCosts();

    expect(secondDaily).toEqual(firstDaily);
    expect(secondCosts).toEqual(firstCosts);
    expect(firstDaily).toHaveLength(DAYS);
  });

  it("last two days are pending (no GGR); every earlier day has one", async () => {
    const rows = await financeDaily();
    const pending = rows.slice(-2);
    const settled = rows.slice(0, -2);
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
    expect(costs).toEqual([
      { descricao: "CRM", valor: "1500.00" },
      { descricao: "SMS", valor: "800.00" },
    ]);
  });
});
