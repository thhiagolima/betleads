// Demo financial data (Task 9, spec §8 "Casa demo"; extended by Task 8 of the
// 2026-10-27 finance-dashboard redesign): invented daily ad spend and GGR, a
// fee-rate history, two FTD/cost goals, categorized monthly "other costs",
// Betleads' own usage cost (wallet_ledger + one paid invoice per month) and
// the "Grupo Demo" (is_demo) group holding the demo house, so the finance
// and group panels show something in the demo instead of empty states.
// Deterministic by `seed` (defaults to demoTenantId, NOT the clone's
// per-run secret): the numbers stay the same across resets so a demo walk-
// through doesn't have to relearn the figures every time. Defaults to a
// year of history (`days`) so the finance dashboard's chart has as many
// months as the demo's tenant_daily_metrics covers.
//
// Runs inside the caller's open transaction (clone-core.mjs calls this right
// after REBUILT_TABLES, in the same transaction as the rest of the clone).
import { createHash } from "node:crypto";

import { makeFaker } from "./anonymize.mjs";

const DEMO_GROUP_NAME = "Grupo Demo";

// Fixed categorized "other costs" seeded for every month the demo has
// metrics for (Task 8): neither description nor category may look like a
// Betleads charge (see BETLEADS_COST_PATTERN below) — the whole point is to
// show costs that are NOT the Betleads line, which is seeded separately
// (seedBetleadsCost) from real wallet/invoice data.
const OTHER_COST_TEMPLATES = [
  { key: "afiliados", descricao: "Influenciador X", categoria: "Afiliados e influenciadores", min: 900, max: 2200 },
  { key: "equipe", descricao: "Equipe de atendimento", categoria: "Equipe", min: 1800, max: 3500 },
];

// Mirrors src/lib/finance/categories.ts' looksLikeBetleadsCost: a .mjs demo
// script can't import that .ts module directly, so the pattern is kept here
// in lockstep (see categories.test.ts for the source of truth). Used to
// purge any pre-Task-8 "CRM"/"SMS" other-cost rows a previous seed left
// behind, which the real dashboard would now flag as duplicated.
const BETLEADS_COST_PATTERN = /\b(sms|betleads|mensalidade|voz|e-?mail|crm)\b/i;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Distinct "YYYY-MM" months among the seeded days, ascending. */
function monthsOf(sortedDays) {
  return [...new Set(sortedDays.map((m) => m.metric_date.slice(0, 7)))].sort();
}

/** Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD". */
function lastDayOfMonth(month) {
  const [y, mm] = month.split("-").map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
}

// Brazil has had no DST since 2019, so São Paulo is always UTC-03:00 — a
// fixed offset is safe for every seeded date.
const spNoon = (date) => `${date}T12:00:00-03:00`;
const spMidnight = (date) => `${date}T00:00:00-03:00`;

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
export async function seedDemoFinance(client, { demoTenantId, days = 365, seed = demoTenantId, demoUserIds = [] } = {}) {
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

  const months = monthsOf(sorted);
  await seedOtherCosts(client, { demoTenantId, seed, months });
  await seedBetleadsUsage(client, { demoTenantId, seed, sorted, firstDate });
  await seedBetleadsInvoices(client, { demoTenantId, seed, months });

  return { days: sorted.length, groupId, ftdGoal, firstDate };
}

/**
 * Categorized "other costs" for every seeded month (Task 8): purges any
 * pre-Task-8 cost (whole-tenant, any month) that now reads as a duplicated
 * Betleads charge, then (re)writes the fixed templates per month.
 */
async function seedOtherCosts(client, { demoTenantId, seed, months }) {
  const { rows: existing } = await client.query(
    `select id, descricao, categoria from public.tenant_finance_other_costs where tenant_id = $1`,
    [demoTenantId],
  );
  const staleIds = existing
    .filter((c) => BETLEADS_COST_PATTERN.test(c.descricao) || (c.categoria && BETLEADS_COST_PATTERN.test(c.categoria)))
    .map((c) => c.id);
  if (staleIds.length)
    await client.query(`delete from public.tenant_finance_other_costs where id = any($1::uuid[])`, [staleIds]);

  for (const month of months) {
    const monthStart = `${month}-01`;
    await client.query(
      `delete from public.tenant_finance_other_costs
        where tenant_id = $1 and month = $2 and descricao = any($3::text[])`,
      [demoTenantId, monthStart, OTHER_COST_TEMPLATES.map((t) => t.descricao)],
    );
    for (const tpl of OTHER_COST_TEMPLATES) {
      const valor = round2(uniform(tpl.min, tpl.max, `${seed}:other_cost:${tpl.key}:${month}`));
      await client.query(
        `insert into public.tenant_finance_other_costs (id, tenant_id, month, descricao, categoria, valor, created_by)
         values ($1, $2, $3, $4, $5, $6, null)`,
        [seededUuid(`${seed}:other_cost:${tpl.descricao}:${month}`), demoTenantId, monthStart, tpl.descricao, tpl.categoria, valor],
      );
    }
  }
}

/**
 * Betleads' own usage cost (Task 8): one `usage_reservation` wallet_ledger
 * row per seeded day (amount uniform(80, 200), created_at noon São Paulo
 * that day — what finance_betleads_usage groups by), preceded by a single
 * `purchase` row covering 1.25x the total so the wallet balance never dips
 * below zero. The demo wallet/ledger only ever holds what this function
 * writes, so it is rebuilt from scratch each run (delete then reinsert)
 * rather than patched — the simplest way to stay idempotent and keep
 * `tenant_wallets.balance` exactly equal to `sum(wallet_ledger.amount)`
 * (what billing_wallet_integrity() checks).
 */
async function seedBetleadsUsage(client, { demoTenantId, seed, sorted, firstDate }) {
  const usageDays = sorted.map((m) => ({
    date: m.metric_date,
    amount: round2(uniform(80, 200, `${seed}:betleads_usage:${m.metric_date}`)),
  }));
  const totalUsage = round2(usageDays.reduce((acc, d) => acc + d.amount, 0));
  const purchaseAmount = round2(totalUsage * 1.25);

  await client.query(`delete from public.wallet_ledger where tenant_id = $1`, [demoTenantId]);
  await client.query(`delete from public.tenant_wallets where tenant_id = $1`, [demoTenantId]);

  await client.query(
    `insert into public.tenant_wallets (tenant_id, balance, lifetime_purchased, lifetime_used)
     values ($1, $2, $3, $4)`,
    [demoTenantId, round2(purchaseAmount - totalUsage), purchaseAmount, totalUsage],
  );

  await client.query(
    `insert into public.wallet_ledger
       (id, tenant_id, entry_type, amount, balance_after, reference_type, reference_id, idempotency_key, reason, created_at)
     values ($1, $2, 'purchase', $3, $3, 'demo_seed', 'purchase', $4, 'Compra de créditos (demo)', $5)`,
    [seededUuid(`${seed}:wallet_purchase`), demoTenantId, purchaseAmount, `${seed}:wallet_purchase`, spMidnight(firstDate)],
  );

  let balance = purchaseAmount;
  for (const { date, amount } of usageDays) {
    balance = round2(balance - amount);
    const key = `${seed}:wallet_usage:${date}`;
    await client.query(
      `insert into public.wallet_ledger
         (id, tenant_id, entry_type, amount, balance_after, reference_type, reference_id, idempotency_key, reason, created_at)
       values ($1, $2, 'usage_reservation', $3, $4, 'demo_seed', $5, $6, 'Consumo Betleads (demo)', $7)`,
      [seededUuid(key), demoTenantId, round2(-amount), balance, date, key, spNoon(date)],
    );
  }
}

/**
 * One `paid` invoice per seeded month (Task 8): amount_cents 400000,
 * period_start the 1st, due dates equal to period_start (prepaid monthly
 * plan fee). Rebuilt from scratch on every run (marked `manual_note =
 * '__demo_seed__'` so the delete never touches the real tenant_billing
 * trigger's own invoice for the demo tenant, which has no such marker).
 */
async function seedBetleadsInvoices(client, { demoTenantId, seed, months }) {
  await client.query(
    `delete from public.billing_invoices where tenant_id = $1 and manual_note = '__demo_seed__'`,
    [demoTenantId],
  );
  for (const month of months) {
    const periodStart = `${month}-01`;
    const periodEnd = lastDayOfMonth(month);
    await client.query(
      `insert into public.billing_invoices
         (id, tenant_id, period_start, period_end, cycle_due_date, due_date,
          base_amount_cents, discount_cents, one_off_discount_cents, amount_cents,
          status, upfront, paid_at, paid_via, paid_amount_cents, manual_note)
       values ($1, $2, $3, $4, $3, $3, 400000, 0, 0, 400000, 'paid', false, $5, 'pix', 400000, '__demo_seed__')`,
      [seededUuid(`${seed}:invoice:${month}`), demoTenantId, periodStart, periodEnd, spNoon(periodStart)],
    );
  }
}
