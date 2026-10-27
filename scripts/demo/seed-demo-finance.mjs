// Demo financial data (Task 9, spec §8 "Casa demo"): invented daily ad spend
// and GGR, a fee-rate history, two FTD/cost goals and two monthly "other
// costs", plus the "Grupo Demo" (is_demo) group holding the demo house, so
// the finance and group panels show something in the demo instead of empty
// states. Deterministic by `seed` (defaults to demoTenantId, NOT the clone's
// per-run secret): the numbers stay the same across resets so a demo walk-
// through doesn't have to relearn the figures every time.
//
// Runs inside the caller's open transaction (clone-core.mjs calls this right
// after REBUILT_TABLES, in the same transaction as the rest of the clone).
import { createHash } from "node:crypto";

import { makeFaker } from "./anonymize.mjs";

const DEMO_GROUP_NAME = "Grupo Demo";
const OTHER_COSTS = [
  { descricao: "CRM", valor: 1500 },
  { descricao: "SMS", valor: 800 },
];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Deterministic RFC-4122-shaped (v3-like) uuid from an arbitrary string key.
 * `makeFaker` (anonymize.mjs) only draws numbers/picks from a seed — it has
 * no uuid shape of its own, and `demoUuid` there requires its input to
 * already BE a uuid (it remaps real ids, it doesn't mint synthetic ones) —
 * so this stays a small, separate helper rather than reusing either.
 */
function seededUuid(key) {
  const h = createHash("md5").update(String(key)).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-3${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic uniform [min, max) from a string key, drawn from the same
 * seeded faker `clone-core.mjs` uses for fake players/phones elsewhere. */
function uniform(min, max, key) {
  return min + (max - min) * (makeFaker(key).uint() / 2 ** 32);
}

/** Finds (or creates) the demo group and makes sure it holds the demo tenant. */
async function ensureDemoGroup(client, { demoTenantId, seed }) {
  const { rows: current } = await client.query(
    `select tg.id
       from public.tenant_groups tg
       join public.tenant_group_tenants gt on gt.group_id = tg.id
      where tg.is_demo and gt.tenant_id = $1`,
    [demoTenantId],
  );
  if (current.length) return current[0].id;

  const { rows: byName } = await client.query(
    `select id from public.tenant_groups where is_demo and nome = $1`,
    [DEMO_GROUP_NAME],
  );
  const groupId = byName[0]?.id ?? seededUuid(`${seed}:tenant_groups:${DEMO_GROUP_NAME}`);
  if (!byName.length)
    await client.query(
      `insert into public.tenant_groups (id, nome, is_demo, created_by) values ($1, $2, true, null)
       on conflict (id) do nothing`,
      [groupId, DEMO_GROUP_NAME],
    );

  await client.query(
    `insert into public.tenant_group_tenants (group_id, tenant_id) values ($1, $2)
     on conflict (tenant_id) do update set group_id = excluded.group_id`,
    [groupId, demoTenantId],
  );
  return groupId;
}

/**
 * Seeds invented finance for the demo tenant: daily ad spend/GGR (only the
 * most recent day left pending, no GGR — normally today, which never grays a
 * goal, so the demo shows goal colours), a single fee-rate row and two goals (both
 * from the earliest seeded day), two current-month "other costs", and the
 * "Grupo Demo" group with the demo house in it. If `demoUserIds` is given,
 * those users become managers of that group.
 */
export async function seedDemoFinance(client, { demoTenantId, days = 60, seed = demoTenantId, demoUserIds = [] } = {}) {
  if (!demoTenantId) throw new Error("seedDemoFinance: demoTenantId is required");

  const { rows: metricRows } = await client.query(
    `select metric_date::text as metric_date, ftds, approved_deposit_amount, approved_withdrawal_amount
       from public.tenant_daily_metrics
      where tenant_id = $1
      order by metric_date desc
      limit $2`,
    [demoTenantId, days],
  );
  const groupId = await ensureDemoGroup(client, { demoTenantId, seed });
  for (const userId of demoUserIds ?? [])
    await client.query(
      `insert into public.tenant_group_managers (group_id, user_id, created_by) values ($1, $2, null)
       on conflict (group_id, user_id) do nothing`,
      [groupId, userId],
    );

  if (!metricRows.length) return { days: 0, groupId };

  const sorted = [...metricRows].sort((a, b) => (a.metric_date < b.metric_date ? -1 : 1));
  const pendingDates = new Set(sorted.slice(-1).map((m) => m.metric_date));
  const firstDate = sorted[0].metric_date;

  for (const m of sorted) {
    const ftds = Number(m.ftds ?? 0);
    const deposits = Number(m.approved_deposit_amount ?? 0);
    const withdrawals = Number(m.approved_withdrawal_amount ?? 0);
    const adSpend = round2(ftds * uniform(60, 110, `${seed}:ad_spend:${m.metric_date}`));
    const ggr = pendingDates.has(m.metric_date)
      ? null
      : round2((deposits - withdrawals) * uniform(0.7, 1.2, `${seed}:ggr:${m.metric_date}`));
    await client.query(
      `insert into public.tenant_finance_daily (tenant_id, metric_date, ad_spend, ggr, updated_by)
       values ($1, $2, $3, $4, null)
       on conflict (tenant_id, metric_date)
       do update set ad_spend = excluded.ad_spend, ggr = excluded.ggr, updated_by = null`,
      [demoTenantId, m.metric_date, adSpend, ggr],
    );
  }

  await client.query(
    `insert into public.tenant_finance_rates (tenant_id, valid_from, ggr_fee_pct, movement_fee_pct, updated_by)
     values ($1, $2, 16, 2.7, null)
     on conflict (tenant_id, valid_from)
     do update set ggr_fee_pct = excluded.ggr_fee_pct, movement_fee_pct = excluded.movement_fee_pct, updated_by = null`,
    [demoTenantId, firstDate],
  );

  const avgFtds = sorted.reduce((acc, m) => acc + Number(m.ftds ?? 0), 0) / sorted.length;
  const ftdGoal = Math.ceil(avgFtds * 1.1);
  await client.query(
    `insert into public.tenant_goals (tenant_id, metric, valid_from, direction, daily_value, updated_by)
     values ($1, 'ftds', $2, 'gte', $3, null),
            ($1, 'cost_per_ftd', $2, 'lte', 90, null)
     on conflict (tenant_id, metric, valid_from)
     do update set direction = excluded.direction, daily_value = excluded.daily_value, updated_by = null`,
    [demoTenantId, firstDate, ftdGoal],
  );

  const { rows: monthRows } = await client.query(`select date_trunc('month', current_date)::date as month`);
  const month = monthRows[0].month;
  await client.query(
    `delete from public.tenant_finance_other_costs
      where tenant_id = $1 and month = $2 and descricao = any($3::text[])`,
    [demoTenantId, month, OTHER_COSTS.map((c) => c.descricao)],
  );
  for (const cost of OTHER_COSTS)
    await client.query(
      `insert into public.tenant_finance_other_costs (id, tenant_id, month, descricao, valor, created_by)
       values ($1, $2, $3, $4, $5, null)`,
      [seededUuid(`${seed}:other_cost:${cost.descricao}:${month}`), demoTenantId, month, cost.descricao, cost.valor],
    );

  return { days: sorted.length, groupId, ftdGoal, firstDate };
}
