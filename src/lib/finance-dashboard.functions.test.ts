// Financeiro — painel de resultado, Task 3: dashboard data for the house,
// group and "Todas as casas" scopes. Same createFakeDb stand-in and permission
// model as finance.functions.test.ts; the three Betleads SQL functions
// (20261103100000_finance_dashboard.sql) return fixed rows filtered by
// tenant and window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { getFinanceDashboardFor, listDashboardScopesFor } from "./finance-dashboard.functions";
import { getTenantFinanceMonthFor } from "./finance.functions";
import { planRpcChunks } from "./finance/finance-data.server";
import { createFakeDb } from "./sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_A = "00000000-0000-4000-8000-0000000000dd";
const G1 = "00000000-0000-4000-8000-00000000a001";
const G2 = "00000000-0000-4000-8000-00000000b001";
const G_EMPTY = "00000000-0000-4000-8000-00000000c001";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const INACTIVE = "00000000-0000-4000-8000-000000000104";
const DEMO = "00000000-0000-4000-8000-00000000d3d0";

type Ctx = Parameters<typeof getFinanceDashboardFor>[0];
const ctxFor = (userId: string) => ({ userId }) as Ctx;

type Row = Record<string, unknown>;
const PGRST_MAX_ROWS = 1000;
let financeDayRows: Row[];
let goalDayRows: Row[];
/** finance_send_usage rows; `item` defaults to "sms", `units` to 1, `missing_cost_units` to 0. */
let usageRows: Row[];
/** finance_activity_days rows (one per house and day); missing columns are 0. */
let activityRows: Row[];
let feeRows: Row[];
let sinceRows: Row[];
/** Houses billing_tenant_exempt reports as exempt (finance_tenants_exempt). */
let exemptTenants: Set<string>;
let financeDaysCalls: Row[];

function dayRow(tenantId: string, date: string, overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    metric_date: date,
    registrations: 0,
    ftds: 0,
    ftd_deposit_amount: 0,
    deposit_amount: 0,
    withdrawal_amount: 0,
    ad_spend: null,
    ad_spend_suggested: null,
    ggr: null,
    ggr_fee_pct: 0,
    movement_fee_pct: 0,
    ...overrides,
  };
}

/** A complete day: result = deposit - adSpend (no fees, no withdrawals, GGR 0). */
const complete = (tenantId: string, date: string, deposit: number, adSpend: number) =>
  dayRow(tenantId, date, { deposit_amount: deposit, ad_spend: adSpend, ggr: 0 });

let otherCostSeq = 0;
/** An other cost dated `costDate` ("YYYY-MM-DD"); month is its first day, as in the table. */
const otherCost = (
  id: string,
  tenantId: string,
  costDate: string,
  descricao: string,
  valor: number,
  categoria: string | null = null,
) => ({
  id,
  tenant_id: tenantId,
  month: `${costDate.slice(0, 7)}-01`,
  cost_date: costDate,
  repeat_monthly: false,
  series_id: null,
  descricao,
  valor,
  categoria,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ++otherCostSeq)).toISOString(),
});

const roles = () => fake.admin.rows("user_roles");
const groupHouses = (userId: string) => {
  const groups = fake.admin
    .rows("tenant_group_managers")
    .filter((m) => m.user_id === userId)
    .map((m) => m.group_id);
  return fake.admin
    .rows("tenant_group_tenants")
    .filter((link) => groups.includes(link.group_id))
    .map((link) => link.tenant_id);
};
const hasRole = (user: unknown, tenant: unknown, role: string) =>
  roles().some((r) => r.user_id === user && r.tenant_id === tenant && r.role === role);

const monthToDate = {
  range: { from: "2026-10-01", to: "2026-10-24" },
  compare: "previous" as const,
  preset: "month" as const,
};
const last7Days = {
  range: { from: "2026-10-18", to: "2026-10-24" },
  compare: "previous" as const,
  preset: "7d" as const,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 12:00 in São Paulo on 2026-10-24.
  vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
  fake.admin.reset();
  financeDayRows = [];
  goalDayRows = [];
  usageRows = [];
  activityRows = [];
  feeRows = [];
  sinceRows = [];
  exemptTenants = new Set();
  financeDaysCalls = [];

  const isSuper = (u: unknown) => u === SUPER;
  const isGroupManager = (u: unknown, t: unknown) => groupHouses(String(u)).includes(t);
  fake.admin.onRpc("is_super_admin", ({ _user_id: u }) => ({ data: isSuper(u), error: null }));
  fake.admin.onRpc("finance_can_view", ({ _user: u, _tenant: t }) => ({
    data:
      isSuper(u) ||
      hasRole(u, t, "admin") ||
      isGroupManager(u, t) ||
      (hasRole(u, t, "gestor") &&
        fake.admin
          .rows("tenant_finance_viewers")
          .some((v) => v.user_id === u && v.tenant_id === t)),
    error: null,
  }));
  fake.admin.onRpc("group_ids_managed_by", ({ _user: u }) => ({
    data: isSuper(u)
      ? fake.admin.rows("tenant_groups").map((g) => g.id)
      : fake.admin
          .rows("tenant_group_managers")
          .filter((m) => m.user_id === u)
          .map((m) => m.group_id),
    error: null,
  }));
  // Permission RPCs needed by getTenantFinanceMonthFor (the "tenant scope
  // month total equals the month view total" test calls it directly).
  fake.admin.onRpc("finance_can_edit_values", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin"),
    error: null,
  }));
  fake.admin.onRpc("finance_can_edit_rates", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin") || isGroupManager(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_viewers", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin") || isGroupManager(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_goals", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || isGroupManager(u, t),
    error: null,
  }));
  (fake.admin.client as unknown as Record<string, unknown>).auth = {
    admin: {
      listUsers: async () => ({
        data: {
          users: [
            { id: ADMIN_A, email: "admin.a@example.com" },
            { id: GESTOR_A, email: "gestor.a@example.com" },
          ],
        },
        error: null,
      }),
    },
  };
  // PostgREST returns at most 1000 rows per RPC call and drops the rest
  // without an error; the fake does the same.
  const capped = (rows: Row[]) => rows.slice(0, PGRST_MAX_ROWS);
  const ofTenants = (row: Row, args: Row) =>
    (args._tenants as string[]).includes(String(row.tenant_id));
  const inWindow = (row: Row, args: Row) =>
    ofTenants(row, args) &&
    String(row.metric_date) >= String(args._from) &&
    String(row.metric_date) <= String(args._to);
  fake.admin.onRpc("finance_days", (args) => {
    financeDaysCalls.push(args);
    return { data: capped(financeDayRows.filter((row) => inWindow(row, args))), error: null };
  });
  fake.admin.onRpc("finance_goal_days", (args) => ({
    data: capped(goalDayRows.filter((row) => inWindow(row, args))),
    error: null,
  }));
  fake.admin.onRpc("finance_send_usage", (args) => ({
    data: capped(
      usageRows
        .filter((row) => inWindow(row, args))
        .map((row) => ({ item: "sms", units: 1, missing_cost_units: 0, ...row })),
    ),
    error: null,
  }));
  fake.admin.onRpc("finance_activity_days", (args) => ({
    data: capped(activityRows.filter((row) => inWindow(row, args))),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_fees", (args) => ({
    data: capped(
      feeRows.filter(
        (row) =>
          ofTenants(row, args) &&
          String(row.month) >= String(args._from_month) &&
          String(row.month) <= String(args._to_month),
      ),
    ),
    error: null,
  }));
  fake.admin.onRpc("finance_tenants_exempt", (args) => ({
    data: capped(
      [...new Set(args._tenants as string[])].map((id) => ({
        tenant_id: id,
        exempt: exemptTenants.has(id),
      })),
    ),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_since", (args) => ({
    data: capped(sinceRows.filter((row) => ofTenants(row, args))),
    error: null,
  }));

  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", status: "active", is_demo: false },
      { id: HOUSE_B, nome: "Casa B", status: "active", is_demo: false },
      { id: HOUSE_C, nome: "Casa C", status: "active", is_demo: false },
      { id: INACTIVE, nome: "Casa Inativa", status: "inactive", is_demo: false },
      { id: DEMO, nome: "Casa Demo", status: "active", is_demo: true },
    );
  fake.admin
    .rows("tenant_groups")
    .push(
      { id: G1, nome: "Grupo 1", is_demo: false },
      { id: G2, nome: "Grupo 2", is_demo: false },
      { id: G_EMPTY, nome: "Grupo Vazio", is_demo: false },
    );
  fake.admin
    .rows("tenant_group_tenants")
    .push(
      { group_id: G1, tenant_id: HOUSE_B },
      { group_id: G1, tenant_id: HOUSE_A },
      { group_id: G2, tenant_id: HOUSE_C },
    );
  fake.admin.rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  roles().push(
    { id: "r1", user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin", created_at: "2026-01-01" },
    { id: "r2", user_id: GESTOR_A, tenant_id: HOUSE_A, role: "gestor", created_at: "2026-01-02" },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Betleads cost", () => {
  it("Betleads usage enters any window; fee only a closed month", async () => {
    financeDayRows.push(complete(HOUSE_A, "2026-10-20", 1000, 100));
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-20", amount: 5 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-22", amount: 3.5 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-12", amount: 2 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-05", amount: 100 },
      { tenant_id: HOUSE_B, metric_date: "2026-10-21", amount: 50 },
    );
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-10-01", amount: 4000 },
      { tenant_id: HOUSE_A, month: "2026-09-01", amount: 3000 },
    );

    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.label).toBe("Casa A");
    expect(week.totals.current.betleadsUsage).toBe(8.5);
    expect(week.totals.current.betleadsFee).toBeNull();
    expect(week.totals.current.cashResult).toBe(900 - 8.5);
    // Previous 7 days: 2026-10-11..17.
    expect(week.totals.previous.betleadsUsage).toBe(2);
    expect(week.totals.previous.betleadsFee).toBeNull();

    const month = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(month.totals.current.betleadsUsage).toBe(110.5);
    expect(month.totals.current.betleadsFee).toBe(4000);
    expect(month.totals.current.cashResult).toBe(900 - 110.5 - 4000);
    expect(month.totals.previous.betleadsFee).toBe(3000);
    expect(month.costs.find((line) => line.key === "sends")).toMatchObject({
      key: "sends",
      label: "Envios",
      amount: 110.5,
      auto: true,
    });
    expect(month.costs.find((line) => line.key === "fee")).toEqual({
      key: "fee",
      label: "Mensalidade",
      amount: 4000,
      previous: 3000,
      auto: true,
    });
  });

  it("a closed month with no invoice has fee 0, not null", async () => {
    const month = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(month.totals.current.betleadsFee).toBe(0);
    expect(month.totals.current.betleadsUsage).toBe(0);
    expect(month.betleadsSince).toBeNull();
  });

  it('duplicateBetleadsCosts counts an "SMS" other cost only from the since month on', async () => {
    sinceRows.push({ tenant_id: HOUSE_A, since: "2026-10-03" });
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-10-01", "SMS", 30),
        otherCost(
          "c2",
          HOUSE_A,
          "2026-10-01",
          "Influenciador X",
          500,
          "Afiliados e influenciadores",
        ),
        otherCost("c3", HOUSE_A, "2026-10-01", "Pacote", 20, "Betleads"),
        otherCost("c4", HOUSE_A, "2026-09-01", "SMS", 99),
        otherCost("c5", HOUSE_A, "2026-10-20", "E-mail", 5),
      );

    const october = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(october.betleadsSince).toBe("2026-10-03");
    expect(october.duplicateBetleadsCosts).toBe(3);

    // September is before the since month: the manual SMS is the only data.
    const september = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
      preset: "custom",
    });
    expect(september.duplicateBetleadsCosts).toBe(0);

    // Any window flags the costs dated inside it: only the e-mail of the 20th.
    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.duplicateBetleadsCosts).toBe(1);
  });

  it("tenant scope of an exempt house still uses the Envios line", async () => {
    exemptTenants.add(HOUSE_A);
    usageRows.push({ tenant_id: HOUSE_A, metric_date: "2026-10-20", amount: 7.5 });

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });

    const line = dashboard.costs.find((l) => l.key === "sends");
    expect(line).toMatchObject({
      label: "Envios",
      amount: 7.5,
      auto: true,
    });
    expect(dashboard.tenants[0].exempt).toBe(true);
  });

  it("tenant scope of a paying house uses the Envios line too", async () => {
    usageRows.push({ tenant_id: HOUSE_A, metric_date: "2026-10-20", amount: 7.5 });

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });

    expect(dashboard.costs.find((l) => l.key === "sends")?.label).toBe("Envios");
    expect(dashboard.tenants[0].exempt).toBe(false);
  });

  it("group scope sums Envios across an exempt and a paying house", async () => {
    exemptTenants.add(HOUSE_A);
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-20", amount: 7.5 },
      { tenant_id: HOUSE_B, metric_date: "2026-10-20", amount: 2.5 },
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...last7Days,
    });

    expect(dashboard.costs.find((l) => l.key === "sends")).toMatchObject({
      label: "Envios",
      amount: 10,
    });
    expect(dashboard.tenants.map((row) => [row.nome, row.exempt])).toEqual([
      ["Casa A", true],
      ["Casa B", false],
    ]);
  });

  it("the month view says whether the house is exempt", async () => {
    exemptTenants.add(HOUSE_A);
    const exempt = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(exempt.betleadsExempt).toBe(true);

    exemptTenants.clear();
    const paying = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(paying.betleadsExempt).toBe(false);
  });

  it("a house without since never flags duplicates", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(otherCost("c1", HOUSE_A, "2026-10-01", "SMS", 30));
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(dashboard.duplicateBetleadsCosts).toBe(0);
  });
});

describe("months", () => {
  it("months has 12 points, oldest first, flags incomplete and betleadsMissing", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2025-10-15", 9999, 1), // 13 months back: left out
      complete(HOUSE_A, "2025-11-15", 300, 100),
      complete(HOUSE_A, "2026-09-10", 500, 100),
      complete(HOUSE_A, "2026-10-05", 1000, 100),
      // Pending past day: still incomplete, but its 50 of deposits count.
      dayRow(HOUSE_A, "2026-10-06", { deposit_amount: 50 }),
    );
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(otherCost("c1", HOUSE_A, "2026-09-01", "Equipe", 50, "Equipe"));
    usageRows.push({ tenant_id: HOUSE_A, metric_date: "2026-09-03", amount: 10 });
    feeRows.push({ tenant_id: HOUSE_A, month: "2026-09-01", amount: 40 });
    sinceRows.push({ tenant_id: HOUSE_A, since: "2026-09-03" });

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });

    // One finance_days call covering the 12 months and both windows.
    expect(financeDaysCalls).toEqual([
      { _tenants: [HOUSE_A], _from: "2025-11-01", _to: "2026-10-24" },
    ]);
    expect(dashboard.months.map((point) => point.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(dashboard.months[0]).toEqual({
      month: "2025-11",
      cashResult: 200,
      adSpend: 100,
      net: 300,
      depositAmount: 300,
      roi: 2,
      incomplete: false,
      inProgress: false,
      betleadsMissing: true,
      byTenant: { [HOUSE_A]: 200 },
    });
    expect(dashboard.months[10]).toEqual({
      month: "2026-09",
      cashResult: 500 - 100 - 50 - 10 - 40,
      adSpend: 100,
      net: 500,
      depositAmount: 500,
      roi: 3,
      incomplete: false,
      inProgress: false,
      betleadsMissing: false,
      byTenant: { [HOUSE_A]: 300 },
    });
    expect(dashboard.months[11]).toMatchObject({
      month: "2026-10",
      cashResult: 950,
      incomplete: true,
      inProgress: true,
      betleadsMissing: false,
    });
    expect(dashboard.months[9].betleadsMissing).toBe(true);
  });

  it("months of a past range end at that range's month and are not in progress", async () => {
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-03-01", to: "2026-03-31" },
      compare: "previous",
      preset: "custom",
    });
    expect(dashboard.months).toHaveLength(12);
    expect(dashboard.months[0].month).toBe("2025-04");
    expect(dashboard.months[11].month).toBe("2026-03");
    expect(dashboard.months.some((point) => point.inProgress)).toBe(false);
    expect(financeDaysCalls).toEqual([
      { _tenants: [HOUSE_A], _from: "2025-04-01", _to: "2026-03-31" },
    ]);
  });
});

describe("tenant scope", () => {
  it("lists one row with pending past dates and labels the GGR rate of range.to", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-19", { deposit_amount: 50, ggr_fee_pct: 15 }), // no Anúncios
      dayRow(HOUSE_A, "2026-10-20", { deposit_amount: 50, ad_spend: 10, ggr_fee_pct: 15 }), // no GGR
      dayRow(HOUSE_A, "2026-10-21", {
        deposit_amount: 1000,
        ad_spend: 100,
        ggr: 100,
        ggr_fee_pct: 16,
      }),
      dayRow(HOUSE_A, "2026-10-24", { deposit_amount: 10, ggr_fee_pct: 12.5 }), // pending today
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });

    expect(dashboard.scope).toEqual({ kind: "tenant", tenantId: HOUSE_A });
    expect(dashboard.range).toEqual(last7Days.range);
    expect(dashboard.compareRange).toEqual({ from: "2026-10-11", to: "2026-10-17" });
    expect(dashboard.tenants).toHaveLength(1);
    expect(dashboard.tenants[0]).toMatchObject({ id: HOUSE_A, nome: "Casa A" });
    expect(dashboard.tenants[0].pendingDates).toEqual(["2026-10-19", "2026-10-20"]);
    expect(dashboard.tenants[0].current.cashResult).toBe(dashboard.totals.current.cashResult);
    expect(dashboard.costs.find((line) => line.key === "ggr_fee")?.label).toBe(
      "Taxa de GGR (12,5%)",
    );
  });
});

const activity = (tenantId: string, date: string, overrides: Row = {}): Row => ({
  tenant_id: tenantId,
  metric_date: date,
  deposit_count: 0,
  depositor_count: 0,
  withdrawal_count: 0,
  generated_pix_count: 0,
  crm_sent: 0,
  crm_clicks: 0,
  crm_direct_conversions: 0,
  crm_direct_revenue: 0,
  crm_influenced_revenue: 0,
  ad_impressions: 0,
  ad_clicks: 0,
  ...overrides,
});

describe("sends, activity and KPIs", () => {
  it("dashboard returns send lines per channel and envios equals summary.betleadsUsage", async () => {
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-20", item: "sms", units: 10, amount: 0.8 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-21", item: "email", units: 3, amount: 0.0012 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-21", item: "voice_30s", units: 4, amount: 0.136 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-22", item: "sms", units: 5, amount: 0.4 },
      // Previous window (2026-10-11..17).
      { tenant_id: HOUSE_A, metric_date: "2026-10-15", item: "sms", units: 6, amount: 0.48 },
      // Another house: only in the group scope.
      { tenant_id: HOUSE_B, metric_date: "2026-10-20", item: "sms", units: 100, amount: 8 },
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });

    expect(dashboard.sends.map((line) => [line.item, line.units, line.amount])).toEqual([
      ["sms", 15, 1.2],
      ["voice_30s", 4, 0.14],
      ["email", 3, 0],
    ]);
    expect(dashboard.sends[0]).toMatchObject({
      label: "SMS",
      unitCost: 0.08,
      previousAmount: 0.48,
    });
    expect(dashboard.sends[1].previousAmount).toBeNull();
    const envios = dashboard.sends.reduce((total, line) => total + line.amount, 0);
    expect(envios).toBeCloseTo(dashboard.totals.current.betleadsUsage, 10);
    expect(dashboard.totals.current.betleadsUsage).toBe(1.34);
    expect(dashboard.costs.find((line) => line.key === "sends")?.amount).toBe(1.34);
    expect(dashboard.kpis.current.sendCost).toBe(1.34);
    expect(dashboard.tenants[0].sendCost).toBe(1.34);

    const group = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...last7Days,
    });
    expect(group.sends[0]).toMatchObject({ item: "sms", units: 115, amount: 9.2 });
    expect(group.totals.current.betleadsUsage).toBe(9.34);
    expect(group.tenants.map((row) => [row.nome, row.sendCost])).toEqual([
      ["Casa A", 1.34],
      ["Casa B", 8],
    ]);
  });

  it("kpis come from activity of the window", async () => {
    financeDayRows.push(
      // Anúncios 100 + 50; of it, Meta spend 60 + 30 (CPM and CPC use the Meta spend).
      dayRow(HOUSE_A, "2026-10-20", {
        deposit_amount: 1000,
        withdrawal_amount: 200,
        ad_spend: 100,
        ad_spend_suggested: 60,
        ggr: 0,
      }),
      dayRow(HOUSE_A, "2026-10-21", {
        deposit_amount: 500,
        ad_spend: 50,
        ad_spend_suggested: "30",
        ggr: 0,
      }),
      // Another house's Meta spend stays out.
      dayRow(HOUSE_B, "2026-10-20", { ad_spend_suggested: 999 }),
      dayRow(HOUSE_A, "2026-10-15", { deposit_amount: 300, ad_spend: 0, ggr: 0 }),
    );
    usageRows.push({ tenant_id: HOUSE_A, metric_date: "2026-10-20", units: 100, amount: 10 });
    activityRows.push(
      activity(HOUSE_A, "2026-10-20", {
        deposit_count: 10,
        depositor_count: 7,
        withdrawal_count: 2,
        generated_pix_count: 20,
        crm_direct_revenue: 40,
        crm_influenced_revenue: "100",
        ad_impressions: 2000,
        ad_clicks: 30,
      }),
      activity(HOUSE_A, "2026-10-21", {
        deposit_count: 5,
        depositor_count: 7,
        generated_pix_count: 10,
        ad_impressions: 1000,
        ad_clicks: 0,
      }),
      // Previous window (2026-10-11..17).
      activity(HOUSE_A, "2026-10-15", { deposit_count: 3, depositor_count: 3 }),
      // Outside both windows.
      activity(HOUSE_A, "2026-10-05", { deposit_count: 1000, depositor_count: 1000 }),
      // Another house.
      activity(HOUSE_B, "2026-10-20", { deposit_count: 1000 }),
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });

    const { current, previous } = dashboard.kpis;
    expect(current.ticketMedio).toBe(1500 / 15);
    expect(current.saqueMedio).toBe(100);
    expect(current.depositorsPerDay).toBe(14 / 7);
    expect(current.pixConversion).toBe(15 / 30);
    expect(current.withdrawalShare).toBe(200 / 1500);
    expect(current.cpm).toBe((90 / 3000) * 1000);
    expect(current.ctr).toBe(30 / 3000);
    expect(current.costPerClick).toBe(90 / 30);
    expect(current.sendCost).toBe(10);
    expect(current.crmDirectRevenue).toBe(40);
    expect(current.crmDirectReturn).toBe(4);
    expect(current.crmInfluencedReturn).toBe(10);
    // cashResult 1300 - 150 - 10 = 1140 over net 1300.
    expect(current.margin).toBe(1140 / 1300);
    expect(dashboard.tenants[0].margin).toBe(1140 / 1300);

    expect(previous.ticketMedio).toBe(100);
    expect(previous.depositorsPerDay).toBe(3 / 7);
    expect(previous.pixConversion).toBeNull();
    expect(previous.crmDirectReturn).toBeNull();
    expect(previous.cpm).toBeNull();
  });

  it("roiReference is the previous month cut at the same day while in progress", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-09-10", 1000, 100),
      // After the cut (the 24th): left out of the reference.
      complete(HOUSE_A, "2026-09-28", 5000, 100),
      complete(HOUSE_A, "2026-07-10", 700, 100),
    );
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(otherCost("c1", HOUSE_A, "2026-09-01", "Equipe", 50, "Equipe"));

    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.roiReference.range).toEqual({ from: "2026-09-01", to: "2026-09-24" });
    expect(week.roiReference.roi).toBe((1000 - 100 - 50) / 100);

    // A past month: the whole previous month.
    const august = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-08-01", to: "2026-08-31" },
      compare: "previous",
      preset: "custom",
    });
    expect(august.roiReference.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(august.roiReference.roi).toBe(6);
  });

  it("waterfall total equals totals.current.cashResult", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-10", {
        deposit_amount: 1000.33,
        withdrawal_amount: 200.17,
        ad_spend: 100.11,
        ggr: 300.07,
        ggr_fee_pct: 17,
        movement_fee_pct: 2.7,
      }),
      dayRow(HOUSE_B, "2026-10-11", {
        deposit_amount: 500,
        withdrawal_amount: 50,
        ad_spend: 20,
        ggr: 40,
        ggr_fee_pct: 16,
        movement_fee_pct: 2.7,
      }),
    );
    fake.admin.rows("tenant_finance_other_costs").push(
      otherCost("c1", HOUSE_A, "2026-10-01", "Equipe", 33.33, "Equipe"),
      otherCost("c2", HOUSE_A, "2026-10-01", "Aluguel", 66.67, "Aluguel"),
      otherCost("c3", HOUSE_A, "2026-10-01", "Diversos", 10.01),
      otherCost("c4", HOUSE_B, "2026-10-01", "Equipe", 70, "Equipe"),
      // Another month: never in the waterfall.
      otherCost("c5", HOUSE_A, "2026-09-01", "Infra", 999, "Infra"),
    );
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-10", item: "sms", units: 3, amount: 0.177 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-10", item: "voice_30s", units: 3, amount: 0.102 },
      { tenant_id: HOUSE_B, metric_date: "2026-10-11", item: "email", units: 3, amount: 0.0012 },
    );
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-10-01", amount: 400 },
      { tenant_id: HOUSE_B, month: "2026-10-01", amount: 300 },
    );

    const house = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    const houseTotal = house.waterfall.at(-1);
    expect(houseTotal).toMatchObject({ key: "profit", kind: "total" });
    expect(houseTotal?.end).toBeCloseTo(house.totals.current.cashResult, 2);
    expect(house.waterfall[0]).toMatchObject({ key: "deposits", end: 1000.33 });
    // Only the house's own other costs of the window, by category.
    expect(
      house.waterfall.filter((step) => step.key.startsWith("category:")).map((s) => s.label),
    ).toEqual(["Equipe", "Aluguel", "Outros"]);
    expect(house.waterfall.some((step) => step.key === "other_costs")).toBe(false);
    expect(house.waterfall.find((step) => step.key === "fee")).toMatchObject({
      start: expect.any(Number),
    });

    const group = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...monthToDate,
    });
    expect(group.waterfall.at(-1)?.end).toBeCloseTo(group.totals.current.cashResult, 2);
    const equipe = group.waterfall.find((step) => step.key === "category:Equipe");
    expect(equipe && round(equipe.start - equipe.end)).toBe(103.33);

    // A 7-day window has no other costs: no category steps.
    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.waterfall.at(-1)?.end).toBeCloseTo(week.totals.current.cashResult, 2);
    expect(week.waterfall.some((step) => step.key.startsWith("category:"))).toBe(false);
  });

  it("a send without provider cost marks Envios partial (kpis and waterfall label)", async () => {
    financeDayRows.push(dayRow(HOUSE_A, "2026-10-20", { deposit_amount: 100, ad_spend: 0, ggr: 0 }));
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-20", item: "sms", units: 10, amount: 0.8 },
      {
        tenant_id: HOUSE_A,
        metric_date: "2026-10-20",
        item: "voice_30s",
        units: 4,
        amount: 0,
        missing_cost_units: 4,
      },
      // Previous window: complete.
      { tenant_id: HOUSE_A, metric_date: "2026-10-15", item: "sms", units: 6, amount: 0.48 },
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(dashboard.kpis.current.sendCostIncomplete).toBe(true);
    expect(dashboard.kpis.previous.sendCostIncomplete).toBe(false);
    expect(dashboard.waterfall.find((step) => step.key === "sends")?.label).toBe(
      "Envios (parcial)",
    );
    expect(dashboard.waterfall.at(-1)?.end).toBeCloseTo(dashboard.totals.current.cashResult, 2);
  });

  it("a house margin is n.a. when its net is zero or negative", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-20", {
        deposit_amount: 100,
        withdrawal_amount: 300,
        ad_spend: 0,
        ggr: 0,
      }),
    );
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(dashboard.totals.current.net).toBe(-200);
    expect(dashboard.tenants[0].margin).toBeNull();
    expect(dashboard.kpis.current.margin).toBeNull();
  });

  it("exemptHouse is true only for the tenant scope of an exempt house", async () => {
    exemptTenants.add(HOUSE_A);
    const house = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(house.exemptHouse).toBe(true);

    const group = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...last7Days,
    });
    expect(group.exemptHouse).toBe(false);

    exemptTenants.clear();
    const paying = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(paying.exemptHouse).toBe(false);
  });

  it("months carry net and deposits", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-09-10", {
        deposit_amount: 800,
        withdrawal_amount: 300,
        ad_spend: 0,
        ggr: 0,
      }),
    );
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(dashboard.months.at(-2)).toMatchObject({
      month: "2026-09",
      net: 500,
      depositAmount: 800,
    });
    expect(dashboard.months.at(-1)).toMatchObject({ net: 0, depositAmount: 0 });
  });
});

const round = (value: number) => Math.round(value * 100) / 100;

describe("tenant scope month total equals the month view total", () => {
  it("dashboard cashResult matches the month view's, for a closed past month and the in-progress current month", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-08-15", 1000, 100),
      complete(HOUSE_A, "2026-10-10", 2000, 200),
    );
    fake.admin.rows("tenant_finance_other_costs").push(
      otherCost("c1", HOUSE_A, "2026-08-01", "CRM", 50),
      otherCost("c2", HOUSE_A, "2026-10-01", "CRM", 80),
      // Dated costs: mid-month, and the last day of a closed month.
      otherCost("c3", HOUSE_A, "2026-10-20", "Equipe", 120.5, "Equipe"),
      otherCost("c4", HOUSE_A, "2026-08-31", "Aluguel", 70.25, "Aluguel"),
    );
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-08-10", amount: 20 },
      { tenant_id: HOUSE_A, metric_date: "2026-08-10", item: "voice_30s", units: 7, amount: 0.238 },
      { tenant_id: HOUSE_A, metric_date: "2026-08-11", item: "email", units: 9, amount: 0.0036 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-05", amount: 15 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-06", item: "voice_30s", units: 5, amount: 0.17 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-07", item: "voice_30s", units: 1, amount: 0.034 },
    );
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-08-01", amount: 300 },
      { tenant_id: HOUSE_A, month: "2026-10-01", amount: 400 },
    );

    const augustDashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-08-01", to: "2026-08-31" },
      compare: "previous",
      preset: "custom",
    });
    const augustMonth = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-08",
    });
    expect(augustDashboard.totals.current.cashResult).toBe(augustMonth.summary.cashResult);
    expect(augustMonth.summary.otherCosts).toBe(120.25);
    expect(augustDashboard.totals.current.otherCosts).toBe(120.25);

    const octoberDashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    const octoberMonth = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(octoberDashboard.totals.current.cashResult).toBe(octoberMonth.summary.cashResult);
    expect(octoberMonth.summary.otherCosts).toBe(200.5);
    expect(octoberDashboard.totals.current.otherCosts).toBe(200.5);
    // The channels are the same on both screens.
    expect(octoberDashboard.sends).toEqual(
      octoberMonth.monthSends.map((line) => ({
        ...line,
        previousAmount: octoberDashboard.sends.find((d) => d.item === line.item)?.previousAmount,
      })),
    );
    expect(augustDashboard.waterfall.at(-1)?.end).toBeCloseTo(augustMonth.summary.cashResult, 2);
  });

  it("also matches for months with a monthly GGR total (closed and in progress)", async () => {
    const day = (date: string, deposit: number, ggr: number | null) =>
      dayRow(HOUSE_A, date, {
        deposit_amount: deposit,
        ad_spend: 10,
        ggr,
        ggr_fee_pct: 17,
        movement_fee_pct: 2.7,
      });
    financeDayRows.push(
      day("2026-09-01", 333.33, 999),
      day("2026-09-15", 100, 999),
      day("2026-09-30", 0, null),
      day("2026-10-01", 120.5, 5),
      day("2026-10-10", 80.25, 5),
      day("2026-10-20", 0, 5),
      day("2026-10-22", 50, 5),
    );
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push(
        { tenant_id: HOUSE_A, month: "2026-09-01", ggr: 1497.15, valid_through: "2026-09-30" },
        { tenant_id: HOUSE_A, month: "2026-10-01", ggr: -321.07, valid_through: "2026-10-20" },
      );

    const septemberDashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
      preset: "custom",
    });
    const septemberMonth = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-09",
    });
    expect(septemberMonth.summary.ggr).toBe(1497.15);
    expect(septemberDashboard.totals.current.ggr).toBe(1497.15);
    expect(septemberDashboard.totals.current.cashResult).toBe(septemberMonth.summary.cashResult);
    expect(septemberDashboard.totals.current.ggrEstimated).toBe(false);

    const octoberDashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    const octoberMonth = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(octoberMonth.summary.ggr).toBe(-321.07);
    expect(octoberDashboard.totals.current.ggr).toBe(-321.07);
    expect(octoberDashboard.totals.current.cashResult).toBe(octoberMonth.summary.cashResult);
    // The months series reads the same days.
    expect(octoberDashboard.months.at(-1)?.cashResult).toBe(octoberMonth.summary.cashResult);
    expect(octoberDashboard.months.at(-2)?.cashResult).toBe(septemberMonth.summary.cashResult);
  });
});

describe("monthly GGR total in the dashboard", () => {
  beforeEach(() => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-01", 100, 10),
      complete(HOUSE_A, "2026-10-19", 100, 10),
      complete(HOUSE_A, "2026-10-20", 200, 10),
      complete(HOUSE_A, "2026-10-21", 100, 10),
      complete(HOUSE_A, "2026-10-22", 100, 10),
      complete(HOUSE_A, "2026-10-23", 100, 10),
      complete(HOUSE_B, "2026-10-20", 100, 10),
    );
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push({ tenant_id: HOUSE_A, month: "2026-10-01", ggr: 400, valid_through: "2026-10-20" });
  });

  it("a window with part of the allocated days is flagged as estimated; later days are pending", async () => {
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    // 400 split 100/100/200 over 01, 19, 20: the window (18..24) holds 19 and 20.
    expect(dashboard.totals.current.ggr).toBe(300);
    expect(dashboard.totals.current.ggrEstimated).toBe(true);
    expect(dashboard.tenants[0].current.ggrEstimated).toBe(true);
    expect(dashboard.tenants[0].pendingDates).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(dashboard.tenants[0].ggrUpdatedThrough).toBe("2026-10-20");

    const monthDashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(monthDashboard.totals.current.ggr).toBe(400);
    expect(monthDashboard.totals.current.ggrEstimated).toBe(false);
  });

  it("group scope: only the house with the total is estimated; others keep daily GGR", async () => {
    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...last7Days,
    });
    const [a, b] = dashboard.tenants;
    expect(a.id).toBe(HOUSE_A);
    expect(a.current.ggrEstimated).toBe(true);
    expect(b.current.ggrEstimated).toBe(false);
    expect(b.ggrUpdatedThrough).toBeNull();
    expect(dashboard.totals.current.ggrEstimated).toBe(true);
  });

  it("pending days not explained by the total keep ggrUpdatedThrough null", async () => {
    financeDayRows.push(dayRow(HOUSE_A, "2026-10-18", { deposit_amount: 10 })); // no Anúncios
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(dashboard.tenants[0].pendingDates[0]).toBe("2026-10-18");
    expect(dashboard.tenants[0].ggrUpdatedThrough).toBeNull();
  });

  it("allocates over the whole month even when the fetch span starts mid-month", async () => {
    // Previous window of this ~10-month range starts on 2025-03-10.
    financeDayRows.push(
      complete(HOUSE_A, "2025-03-01", 100, 0),
      complete(HOUSE_A, "2025-03-20", 100, 0),
    );
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push({ tenant_id: HOUSE_A, month: "2025-03-01", ggr: 1000, valid_through: "2025-03-31" });

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-01-01", to: "2026-10-24" },
      compare: "previous",
      preset: "custom",
    });
    expect(dashboard.compareRange?.from).toBe("2025-03-10");
    expect(dashboard.totals.previous.ggr).toBe(500);
    expect(dashboard.totals.previous.ggrEstimated).toBe(true);
  });
});

describe("group and all scopes", () => {
  it("group scope sums houses and lists one row per house", async () => {
    financeDayRows.push(
      // A: result 300 - 100 = 200 on 100 of ads -> ROI 2.
      complete(HOUSE_A, "2026-10-23", 300, 100),
      // A: GGR 100 at 10% -> fee 10, result 0, no ads.
      dayRow(HOUSE_A, "2026-10-21", {
        deposit_amount: 10,
        ad_spend: 0,
        ggr: 100,
        ggr_fee_pct: 10,
      }),
      // B: result 300 - 300 = 0 on 300 of ads -> ROI 0.
      complete(HOUSE_B, "2026-10-23", 300, 300),
      // B: pending day (no Anúncios/GGR) still counts its 1 of deposits.
      dayRow(HOUSE_B, "2026-10-22", { deposit_amount: 1 }),
      complete(HOUSE_C, "2026-10-23", 999, 1),
    );
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-23", amount: 10 },
      { tenant_id: HOUSE_B, metric_date: "2026-10-23", amount: 20 },
    );
    goalDayRows.push({
      tenant_id: HOUSE_A,
      metric_date: "2026-10-23",
      metric: "roi",
      direction: "gte",
      daily_value: 0,
    });

    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...last7Days,
    });

    expect(dashboard.label).toBe("Grupo 1");
    expect(dashboard.tenants.map((row) => row.nome)).toEqual(["Casa A", "Casa B"]);
    const [a, b] = dashboard.tenants;
    expect(a.current.cashResult).toBe(190);
    expect(b.current.cashResult).toBe(-19);
    expect(b.pendingDates).toEqual(["2026-10-22"]);
    // Row-level ROI: each house's own result over its own Anúncios.
    expect(a.current.roi).toBe(190 / 100);
    expect(b.current.roi).toBe(-19 / 300);
    expect(dashboard.totals.current.cashResult).toBe(171);
    expect(dashboard.totals.current.betleadsUsage).toBe(30);
    // Σresult / Σads = 171 / 400, not the mean of the houses.
    expect(dashboard.totals.current.roi).toBe(171 / 400);
    expect(a.goals).toEqual([
      { metric: "roi", direction: "gte", target: 0, value: 1.9, status: "green" },
    ]);
    expect(b.goals).toEqual([]);
    expect(dashboard.months.at(-1)!.byTenant).toEqual({ [HOUSE_A]: 190, [HOUSE_B]: -19 });
    // Group scope does not put a rate in the GGR label.
    expect(dashboard.costs.find((line) => line.key === "ggr_fee")?.label).toBe("Taxa de GGR");
    expect(financeDaysCalls[0]._tenants).toEqual([HOUSE_A, HOUSE_B]);
  });

  it("group scope: other costs enter by date; the fee only a whole calendar month and its whole previous month", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-09-01", "CRM", 100),
        otherCost("c2", HOUSE_B, "2026-09-01", "CRM", 25),
        otherCost("c3", HOUSE_C, "2026-09-01", "CRM", 999),
        otherCost("c4", HOUSE_A, "2026-08-01", "CRM", 40),
      );
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-09-01", amount: 4000 },
      { tenant_id: HOUSE_B, month: "2026-08-01", amount: 3000 },
    );

    const full = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
      preset: "custom",
    });
    expect(full.compareRange).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(full.totals.current.otherCosts).toBe(125);
    expect(full.totals.current.betleadsFee).toBe(4000);
    expect(full.totals.previous.otherCosts).toBe(40);
    expect(full.totals.previous.betleadsFee).toBe(3000);

    const partial = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      range: { from: "2026-09-01", to: "2026-09-29" },
      compare: "previous",
      preset: "custom",
    });
    // Dated on the 1st, inside the window; the fee waits for the month's close.
    expect(partial.totals.current.otherCosts).toBe(125);
    expect(partial.totals.current.betleadsFee).toBeNull();
  });

  it("a cost dated inside a 7d window enters cashResult; the fee does not", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-20", 1000, 100),
      complete(HOUSE_A, "2026-10-12", 500, 50),
    );
    fake.admin.rows("tenant_finance_other_costs").push(
      otherCost("c1", HOUSE_A, "2026-10-19", "Designer", 60, "Equipe"),
      // Before the week (Oct 18-24), inside its comparison (Oct 11-17).
      otherCost("c2", HOUSE_A, "2026-10-17", "Freela", 30, "Equipe"),
    );
    feeRows.push({ tenant_id: HOUSE_A, month: "2026-10-01", amount: 400 });

    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.compareRange).toEqual({ from: "2026-10-11", to: "2026-10-17" });
    expect(week.totals.current.otherCosts).toBe(60);
    expect(week.totals.current.betleadsFee).toBeNull();
    expect(week.totals.current.cashResult).toBe(1000 - 100 - 60);
    expect(week.totals.previous.otherCosts).toBe(30);
    expect(week.totals.previous.cashResult).toBe(500 - 50 - 30);
    const house = week.tenants.find((tenant) => tenant.id === HOUSE_A);
    expect(house?.current.otherCosts).toBe(60);
    // Waterfall and cost lines carry the window's categories.
    const equipe = week.waterfall.find((step) => step.key === "category:Equipe");
    expect(equipe && round(equipe.start - equipe.end)).toBe(60);
    expect(week.costs.find((line) => line.key === "category:Equipe")).toMatchObject({
      amount: 60,
      previous: 30,
    });
    // The month's point of the series has both costs and the fee.
    expect(week.months.at(-1)?.cashResult).toBe(1000 - 100 + 500 - 50 - 60 - 30 - 400);
  });

  it("costs merges categories with the same name across houses", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-10-01", "João", 100, "Equipe"),
        otherCost("c2", HOUSE_B, "2026-10-01", "Maria", 50, " equipe "),
        otherCost("c3", HOUSE_B, "2026-10-01", "Antigo", 30, null),
        otherCost("c4", HOUSE_A, "2026-09-01", "Pedro", 70, "EQUIPE"),
      );

    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...monthToDate,
    });

    const categoryLines = dashboard.costs.filter((line) => !line.auto);
    expect(categoryLines).toEqual([
      { key: "category:Equipe", label: "Equipe", amount: 150, previous: 70, auto: false },
      { key: "category:Outros", label: "Outros", amount: 30, previous: null, auto: false },
    ]);
  });

  it("a category that drops to zero this month still shows with its variation", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-10-01", "João", 100, "Equipe"),
        otherCost("c2", HOUSE_B, "2026-09-01", "Agência", 70, "Marketing"),
      );

    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "group", groupId: G1 },
      ...monthToDate,
    });

    expect(dashboard.costs.filter((line) => !line.auto)).toEqual([
      { key: "category:Equipe", label: "Equipe", amount: 100, previous: null, auto: false },
      { key: "category:Marketing", label: "Marketing", amount: 0, previous: 70, auto: false },
    ]);
  });

  it("all scope excludes demo and inactive houses", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-23", 300, 100),
      complete(HOUSE_C, "2026-10-23", 500, 100),
      complete(DEMO, "2026-10-23", 99999, 1),
      complete(INACTIVE, "2026-10-23", 99999, 1),
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: { kind: "all" },
      ...last7Days,
    });

    expect(dashboard.label).toBe("Todas as casas");
    expect(dashboard.tenants.map((row) => row.id)).toEqual([HOUSE_A, HOUSE_B, HOUSE_C]);
    expect(dashboard.totals.current.cashResult).toBe(600);
    expect(financeDaysCalls.flatMap((call) => call._tenants as string[]).sort()).toEqual([
      HOUSE_A,
      HOUSE_B,
      HOUSE_C,
    ]);
  });

  it("empty group and all-with-no-houses return zeros and empty arrays", async () => {
    const empty = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: { kind: "group", groupId: G_EMPTY },
      ...monthToDate,
    });
    expect(empty.label).toBe("Grupo Vazio");
    expect(empty.tenants).toEqual([]);
    expect(empty.costs).toEqual([]);
    expect(empty.months).toEqual([]);
    expect(empty.totals.current.cashResult).toBe(0);
    expect(empty.totals.current.adSpend).toBe(0);
    expect(empty.totals.current.roi).toBeNull();
    expect(empty.betleadsSince).toBeNull();
    expect(empty.duplicateBetleadsCosts).toBe(0);

    for (const tenant of fake.admin.rows("tenants")) tenant.status = "inactive";
    const all = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: { kind: "all" },
      ...last7Days,
    });
    expect(all.tenants).toEqual([]);
    expect(all.months).toEqual([]);
    expect(all.totals.previous.cashResult).toBe(0);
    expect(financeDaysCalls).toHaveLength(0);
  });
});

// Ported from the retired getGroupOverview tests (finance.functions.test.ts):
// the cost-month rule's preset/compare edge cases, per-house values and the
// pending-today goal rule, now against the dashboard's group scope.
describe("group scope: cost-month rule and goals (ported from the group overview)", () => {
  const g1 = { kind: "group" as const, groupId: G1 };
  const row = (dashboard: { tenants: Array<{ id: string }> }, id: string) =>
    dashboard.tenants.find((tenant) => tenant.id === id) as Awaited<
      ReturnType<typeof getFinanceDashboardFor>
    >["tenants"][number];

  it("a whole calendar month puts other costs in each house's row; one finance_days call spans both windows", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-09-10", 1000, 100),
      complete(HOUSE_A, "2026-08-10", 400, 100),
    );
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-09-01", "CRM", 100),
        otherCost("c2", HOUSE_A, "2026-09-01", "SMS", 50),
        otherCost("c3", HOUSE_B, "2026-09-01", "CRM", 25),
        otherCost("c4", HOUSE_A, "2026-08-01", "CRM", 40),
      );

    const full = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: g1,
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
      preset: "custom",
    });
    // One call covers both windows (and the 12-month chart).
    expect(financeDaysCalls).toHaveLength(1);
    expect(financeDaysCalls[0]._tenants).toEqual([HOUSE_A, HOUSE_B]);
    expect(String(financeDaysCalls[0]._from) <= "2026-08-01").toBe(true);
    expect(financeDaysCalls[0]._to).toBe("2026-09-30");
    const a = row(full, HOUSE_A);
    expect(a.current.otherCosts).toBe(150);
    expect(a.current.cashResult).toBe(1000 - 100 - 150);
    expect(a.previous.otherCosts).toBe(40);
    expect(a.previous.cashResult).toBe(400 - 100 - 40);
    expect(row(full, HOUSE_B).current.otherCosts).toBe(25);

    const partial = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: g1,
      range: { from: "2026-09-01", to: "2026-09-29" },
      compare: "previous",
      preset: "custom",
    });
    expect(row(partial, HOUSE_A).current.otherCosts).toBe(150);
    expect(row(partial, HOUSE_A).current.betleadsFee).toBeNull();
  });

  it("other costs enter the Mês preset and the same window as Personalizado alike (by date)", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-05", 1000, 100),
      complete(HOUSE_A, "2026-09-05", 500, 100),
    );
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-10-01", "CRM", 40),
        otherCost("c2", HOUSE_A, "2026-09-01", "CRM", 150),
        otherCost("c3", HOUSE_B, "2026-10-01", "SMS", 10),
      );

    const month = await getFinanceDashboardFor(ctxFor(G1_MANAGER), { scope: g1, ...monthToDate });
    expect(month.compareRange).toEqual({ from: "2026-09-01", to: "2026-09-24" });
    const a = row(month, HOUSE_A);
    expect(a.current.otherCosts).toBe(40);
    expect(a.previous.otherCosts).toBe(150);
    expect(month.totals.current.otherCosts).toBe(50);
    expect(month.totals.previous.otherCosts).toBe(150);

    const custom = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: g1,
      ...monthToDate,
      preset: "custom",
    });
    expect(row(custom, HOUSE_A).current.otherCosts).toBe(40);
    expect(custom.totals.current.otherCosts).toBe(50);
    // The previous 24 days (Sep 7-30) do not hold the cost dated Sep 1.
    expect(custom.compareRange).toEqual({ from: "2026-09-07", to: "2026-09-30" });
    expect(custom.totals.previous.otherCosts).toBe(0);
  });

  it("Mês preset with a week-shifted comparison counts the costs dated inside that comparison", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        otherCost("c1", HOUSE_A, "2026-10-01", "CRM", 40),
        otherCost("c2", HOUSE_A, "2026-09-01", "CRM", 150),
      );
    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: g1,
      ...monthToDate,
      compare: "last_week",
    });
    expect(dashboard.compareRange).toEqual({ from: "2026-09-24", to: "2026-10-17" });
    expect(row(dashboard, HOUSE_A).current.otherCosts).toBe(40);
    // Sep 24 - Oct 17 holds the cost of Oct 1, not the one of Sep 1.
    expect(row(dashboard, HOUSE_A).previous.otherCosts).toBe(40);
    expect(dashboard.totals.previous.otherCosts).toBe(40);
    expect(dashboard.totals.previous.betleadsFee).toBeNull();
  });

  it("a range starting after a cost's date leaves it out", async () => {
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(otherCost("c1", HOUSE_A, "2026-10-01", "CRM", 40));
    const dashboard = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: g1,
      range: { from: "2026-10-05", to: "2026-10-24" },
      compare: "previous",
      preset: "month",
    });
    expect(row(dashboard, HOUSE_A).current.otherCosts).toBe(0);
    expect(dashboard.totals.current.otherCosts).toBe(0);
    // The Mês preset is not trusted for a range that is not month-to-date: no fee.
    expect(dashboard.totals.current.betleadsFee).toBeNull();
  });

  it("Ontem compared with the same weekday last week", async () => {
    const dashboard = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: g1,
      range: { from: "2026-10-23", to: "2026-10-23" },
      compare: "same_weekday_last_week",
      preset: "yesterday",
    });
    expect(dashboard.compareRange).toEqual({ from: "2026-10-16", to: "2026-10-16" });
  });

  it("a pending today is not a pending day; its computed result enters the goal", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-23", 300, 100),
      dayRow(HOUSE_A, "2026-10-24", { deposit_amount: 50 }),
      complete(HOUSE_B, "2026-10-23", 300, 100),
      dayRow(HOUSE_B, "2026-10-24", { deposit_amount: 50 }),
    );
    goalDayRows.push(
      ...["2026-10-23", "2026-10-24"].map((date) => ({
        tenant_id: HOUSE_A,
        metric_date: date,
        metric: "cash_result",
        direction: "gte",
        daily_value: 150,
      })),
    );

    const dashboard = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: g1,
      range: { from: "2026-10-23", to: "2026-10-24" },
      compare: "previous",
      preset: "custom",
    });

    const a = row(dashboard, HOUSE_A);
    expect(a.current.pendingDays).toBe(0);
    expect(a.pendingDates).toEqual([]);
    // Today (pending) counts its 50 of deposits: 200 + 50.
    expect(a.current.cashResult).toBe(250);
    // Both goal days (2 × 150) against 250: yellow (≥ 80% of 300), not gray.
    expect(a.goals).toEqual([
      { metric: "cash_result", direction: "gte", target: 300, value: 250, status: "yellow" },
    ]);
    expect(dashboard.totals.current.pendingDays).toBe(0);
  });
});

describe("permissions", () => {
  it("group manager cannot read a house outside their groups", async () => {
    await expect(
      getFinanceDashboardFor(ctxFor(G1_MANAGER), {
        scope: { kind: "tenant", tenantId: HOUSE_C },
        ...monthToDate,
      }),
    ).rejects.toThrow("Sem permissão");
    // Inside their group it works (read-only).
    const inside = await getFinanceDashboardFor(ctxFor(G1_MANAGER), {
      scope: { kind: "tenant", tenantId: HOUSE_B },
      ...monthToDate,
    });
    expect(inside.label).toBe("Casa B");
  });

  it("group manager cannot read another group", async () => {
    await expect(
      getFinanceDashboardFor(ctxFor(G1_MANAGER), {
        scope: { kind: "group", groupId: G2 },
        ...monthToDate,
      }),
    ).rejects.toThrow("Sem permissão");
    expect(financeDaysCalls).toHaveLength(0);
  });

  it("house admin cannot read a group", async () => {
    await expect(
      getFinanceDashboardFor(ctxFor(ADMIN_A), {
        scope: { kind: "group", groupId: G1 },
        ...monthToDate,
      }),
    ).rejects.toThrow("Sem permissão");
  });

  it("only the super admin reads all houses", async () => {
    for (const user of [G1_MANAGER, ADMIN_A]) {
      await expect(
        getFinanceDashboardFor(ctxFor(user), { scope: { kind: "all" }, ...monthToDate }),
      ).rejects.toThrow("Sem permissão");
    }
    expect(financeDaysCalls).toHaveLength(0);
  });

  it("gestor without grant cannot read the house; with grant can", async () => {
    await expect(
      getFinanceDashboardFor(ctxFor(GESTOR_A), {
        scope: { kind: "tenant", tenantId: HOUSE_A },
        ...monthToDate,
      }),
    ).rejects.toThrow("Sem permissão");

    fake.admin.rows("tenant_finance_viewers").push({ tenant_id: HOUSE_A, user_id: GESTOR_A });
    const granted = await getFinanceDashboardFor(ctxFor(GESTOR_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(granted.label).toBe("Casa A");
  });
});

describe("listDashboardScopes", () => {
  it("lists groups and active non-demo houses for the super admin only", async () => {
    const scopes = await listDashboardScopesFor(ctxFor(SUPER));
    expect(scopes).toEqual({
      groups: [
        { id: G1, nome: "Grupo 1" },
        { id: G2, nome: "Grupo 2" },
        { id: G_EMPTY, nome: "Grupo Vazio" },
      ],
      tenants: [
        { id: HOUSE_A, nome: "Casa A" },
        { id: HOUSE_B, nome: "Casa B" },
        { id: HOUSE_C, nome: "Casa C" },
      ],
    });

    await expect(listDashboardScopesFor(ctxFor(G1_MANAGER))).rejects.toThrow("Sem permissão");
  });
});

/** Every "YYYY-MM-DD" from `from` to `to`, inclusive. */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const last = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= last; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

describe("PostgREST 1000-row cap", () => {
  const EXTRA_D = "00000000-0000-4000-8000-000000000105";
  const EXTRA_E = "00000000-0000-4000-8000-000000000106";
  const G_BIG = "00000000-0000-4000-8000-00000000e001";
  const HOUSES = [HOUSE_A, HOUSE_B, HOUSE_C, EXTRA_D, EXTRA_E];
  const ALL_METRICS = [
    "registrations",
    "ftds",
    "deposits",
    "net",
    "cash_result",
    "cost_per_registration",
    "cost_per_ftd",
    "roi",
  ];

  it("5 houses over ~13 months + comparison: totals, rows, months and goals are complete", async () => {
    fake.admin
      .rows("tenants")
      .push(
        { id: EXTRA_D, nome: "Casa D", status: "active", is_demo: false },
        { id: EXTRA_E, nome: "Casa E", status: "active", is_demo: false },
      );
    fake.admin.rows("tenant_groups").push({ id: G_BIG, nome: "Grupo Grande", is_demo: false });
    fake.admin
      .rows("tenant_group_tenants")
      .push(...HOUSES.map((tenantId) => ({ group_id: G_BIG, tenant_id: tenantId })));

    // Current: the last 30 days; previous: the 30 days before; the series
    // reaches back to 2025-11-01, so ~360 finance_days rows per house are
    // read (and the fixture has ~395 per house).
    const range = { from: "2026-09-25", to: "2026-10-24" };
    const span = eachDay("2025-09-25", "2026-10-24");
    for (const tenantId of HOUSES) {
      for (const date of span) {
        financeDayRows.push(complete(tenantId, date, 10, 1));
        // Three channels a day (≤ 3 send rows per house-day) adding up to 1.
        usageRows.push(
          { tenant_id: tenantId, metric_date: date, item: "sms", units: 5, amount: 0.5 },
          { tenant_id: tenantId, metric_date: date, item: "voice_30s", units: 3, amount: 0.3 },
          { tenant_id: tenantId, metric_date: date, item: "email", units: 2, amount: 0.2 },
        );
        activityRows.push(activity(tenantId, date, { deposit_count: 2, depositor_count: 1 }));
      }
      for (const date of eachDay(range.from, range.to)) {
        for (const metric of ALL_METRICS) {
          goalDayRows.push({
            tenant_id: tenantId,
            metric_date: date,
            metric,
            direction: "gte",
            daily_value: 1,
          });
        }
      }
    }
    expect(financeDayRows.length).toBeGreaterThanOrEqual(5 * 395);

    const dashboard = await getFinanceDashboardFor(ctxFor(SUPER), {
      scope: { kind: "group", groupId: G_BIG },
      range,
      compare: "previous",
      preset: "custom",
    });

    // Each day: 10 deposited - 1 of ads - 1 of Betleads usage = 8.
    expect(dashboard.tenants).toHaveLength(5);
    expect(dashboard.totals.current.days).toBe(5 * 30);
    expect(dashboard.totals.current.cashResult).toBe(5 * 30 * 8);
    expect(dashboard.totals.current.betleadsUsage).toBe(5 * 30);
    expect(dashboard.totals.previous.cashResult).toBe(5 * 30 * 8);
    // Every send and activity row of both windows was read.
    expect(dashboard.sends.map((line) => [line.item, line.units, line.amount])).toEqual([
      ["sms", 5 * 30 * 5, 5 * 30 * 0.5],
      ["voice_30s", 5 * 30 * 3, 5 * 30 * 0.3],
      ["email", 5 * 30 * 2, 5 * 30 * 0.2],
    ]);
    expect(dashboard.kpis.current.ticketMedio).toBe(5);
    expect(dashboard.kpis.current.depositorsPerDay).toBe(5);
    expect(dashboard.kpis.previous.ticketMedio).toBe(5);
    for (const row of dashboard.tenants) {
      expect(row.current.cashResult).toBe(30 * 8);
      expect(row.previous.cashResult).toBe(30 * 8);
      expect(row.goals).toHaveLength(ALL_METRICS.length);
      expect(row.goals.find((goal) => goal.metric === "deposits")?.target).toBe(30);
    }
    // November 2025 (30 days) is the oldest point; every month has every house.
    expect(dashboard.months[0]).toMatchObject({ month: "2025-11", cashResult: 5 * 30 * 8 });
    expect(dashboard.months[0].byTenant).toEqual(
      Object.fromEntries(HOUSES.map((tenantId) => [tenantId, 30 * 8])),
    );
    // Every call stays under the cap.
    for (const call of financeDaysCalls) {
      const days = eachDay(String(call._from), String(call._to)).length;
      expect((call._tenants as string[]).length * days).toBeLessThanOrEqual(900);
    }
  });

  it("one house with a year of goals (8 metrics a day) is split by date", async () => {
    const range = { from: "2025-10-25", to: "2026-10-24" };
    for (const date of eachDay(range.from, range.to)) {
      financeDayRows.push(complete(HOUSE_A, date, 10, 1));
      for (const metric of ALL_METRICS) {
        goalDayRows.push({
          tenant_id: HOUSE_A,
          metric_date: date,
          metric,
          direction: "gte",
          daily_value: 1,
        });
      }
    }
    expect(goalDayRows.length).toBeGreaterThan(PGRST_MAX_ROWS);

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range,
      compare: "previous",
      preset: "custom",
    });

    expect(dashboard.totals.current.days).toBe(365);
    expect(dashboard.totals.current.cashResult).toBe(365 * 9);
    const [row] = dashboard.tenants;
    expect(row.goals).toHaveLength(ALL_METRICS.length);
    // Every goal day was read: the targets sum the whole year.
    expect(row.goals.find((goal) => goal.metric === "deposits")?.target).toBe(365);
    expect(row.goals.find((goal) => goal.metric === "registrations")?.target).toBe(365);
  });
});

describe("planRpcChunks", () => {
  it("one call for a single house month; houses batched under 900 rows; long ranges split by date", () => {
    expect(planRpcChunks(["a"], { from: "2026-10-01", to: "2026-10-31" }, 8)).toEqual([
      { tenantIds: ["a"], range: { from: "2026-10-01", to: "2026-10-31" } },
    ]);
    const houses = ["a", "b", "c", "d", "e"];
    const year = planRpcChunks(houses, { from: "2025-10-25", to: "2026-10-24" }, 1);
    expect(year.map((part) => part.tenantIds)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    const goals = planRpcChunks(["a"], { from: "2025-10-25", to: "2026-10-24" }, 8);
    // floor(900 / 8) = 112 days per call.
    expect(goals.map((part) => part.range)).toEqual([
      { from: "2025-10-25", to: "2026-02-13" },
      { from: "2026-02-14", to: "2026-06-05" },
      { from: "2026-06-06", to: "2026-09-25" },
      { from: "2026-09-26", to: "2026-10-24" },
    ]);
    expect(planRpcChunks([], { from: "2026-10-01", to: "2026-10-31" }, 1)).toEqual([]);
  });
});

describe("other costs paging", () => {
  it("reads every other cost of the month past one page", async () => {
    for (let index = 0; index < 2100; index++) {
      fake.admin
        .rows("tenant_finance_other_costs")
        .push(otherCost(`p${index}`, HOUSE_A, "2026-10-01", "Item", 1, "Equipe"));
    }
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(dashboard.totals.current.otherCosts).toBe(2100);
  });
});

describe("fetch span", () => {
  it("a comparison window before the 12-month series is still fetched", async () => {
    // A ~10-month range: its previous window reaches back to early 2025,
    // well before the series' first month (2025-11).
    const range = { from: "2026-01-01", to: "2026-10-24" };
    financeDayRows.push(complete(HOUSE_A, "2025-04-10", 500, 100));

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range,
      compare: "previous",
      preset: "custom",
    });

    expect(dashboard.months[0].month).toBe("2025-11");
    expect((dashboard.compareRange?.from ?? "") <= "2025-04-10").toBe(true);
    const fetchedFrom = financeDaysCalls.map((call) => String(call._from)).sort()[0];
    expect(fetchedFrom).toBe(dashboard.compareRange?.from);
    expect(dashboard.totals.previous.cashResult).toBe(400);
  });
});

describe("comparison modes", () => {
  const houseA = { kind: "tenant" as const, tenantId: HOUSE_A };

  it("none fetches no previous window and returns an empty previous", async () => {
    // A ~10-month range: with "previous" its comparison would reach 2025-03.
    const range = { from: "2026-01-01", to: "2026-10-24" };
    financeDayRows.push(
      complete(HOUSE_A, "2025-04-10", 500, 100),
      complete(HOUSE_A, "2026-09-10", 300, 100),
      complete(HOUSE_A, "2026-10-10", 200, 50),
    );
    activityRows.push({ tenant_id: HOUSE_A, metric_date: "2025-04-10", depositors: 3 });
    usageRows.push({ tenant_id: HOUSE_A, metric_date: "2025-04-10", amount: 7 });

    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: houseA,
      range,
      compare: "none",
      preset: "custom",
    });

    expect(dashboard.compareRange).toBeNull();
    // Only the 12-month series and the current window are read.
    const fetchedFrom = financeDaysCalls.map((call) => String(call._from)).sort()[0];
    expect(fetchedFrom).toBe("2025-11-01");
    expect(dashboard.totals.previous.days).toBe(0);
    expect(dashboard.totals.previous.cashResult).toBe(0);
    expect(dashboard.totals.previous.depositAmount).toBe(0);
    expect(dashboard.totals.previous.betleadsFee).toBeNull();
    expect(dashboard.tenants[0].previous.days).toBe(0);
    expect(dashboard.tenants[0].previous.cashResult).toBe(0);
    expect(dashboard.kpis.previous.sendCost).toBe(0);
    expect(dashboard.sends.every((line) => line.previousAmount === null)).toBe(true);
    // The current window and the ROI reference are unaffected.
    expect(dashboard.totals.current.cashResult).toBe(350);
    expect(dashboard.roiReference.range).toEqual({ from: "2026-09-01", to: "2026-09-24" });
    expect(dashboard.roiReference.roi).toBe(2);
  });

  it("same_period_last_year of the Mês preset is the same days a year before, with its fee", async () => {
    financeDayRows.push(complete(HOUSE_A, "2025-10-05", 900, 100));
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-10-01", amount: 400 },
      { tenant_id: HOUSE_A, month: "2025-10-01", amount: 300 },
    );
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: houseA,
      ...monthToDate,
      compare: "same_period_last_year",
    });
    expect(dashboard.compareRange).toEqual({ from: "2025-10-01", to: "2025-10-24" });
    expect(dashboard.totals.previous.depositAmount).toBe(900);
    expect(dashboard.totals.previous.betleadsFee).toBe(300);
  });

  it("same_period_last_year of a whole month is that month a year before", async () => {
    const dashboard = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: houseA,
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "same_period_last_year",
      preset: "custom",
    });
    expect(dashboard.compareRange).toEqual({ from: "2025-09-01", to: "2025-09-30" });
  });
});
