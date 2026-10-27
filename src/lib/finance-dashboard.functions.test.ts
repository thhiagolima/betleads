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
let financeDayRows: Row[];
let goalDayRows: Row[];
let usageRows: Row[];
let feeRows: Row[];
let sinceRows: Row[];
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
const otherCost = (
  id: string,
  tenantId: string,
  month: string,
  descricao: string,
  valor: number,
  categoria: string | null = null,
) => ({
  id,
  tenant_id: tenantId,
  month,
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
  feeRows = [];
  sinceRows = [];
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
  const ofTenants = (row: Row, args: Row) =>
    (args._tenants as string[]).includes(String(row.tenant_id));
  const inWindow = (row: Row, args: Row) =>
    ofTenants(row, args) &&
    String(row.metric_date) >= String(args._from) &&
    String(row.metric_date) <= String(args._to);
  fake.admin.onRpc("finance_days", (args) => {
    financeDaysCalls.push(args);
    return { data: financeDayRows.filter((row) => inWindow(row, args)), error: null };
  });
  fake.admin.onRpc("finance_goal_days", (args) => ({
    data: goalDayRows.filter((row) => inWindow(row, args)),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_usage", (args) => ({
    data: usageRows.filter((row) => inWindow(row, args)),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_fees", (args) => ({
    data: feeRows.filter(
      (row) =>
        ofTenants(row, args) &&
        String(row.month) >= String(args._from_month) &&
        String(row.month) <= String(args._to_month),
    ),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_since", (args) => ({
    data: sinceRows.filter((row) => ofTenants(row, args)),
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
    expect(month.costs.find((line) => line.key === "betleads")).toEqual({
      key: "betleads",
      label: "Betleads",
      amount: 4110.5,
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
      );

    const october = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...monthToDate,
    });
    expect(october.betleadsSince).toBe("2026-10-03");
    expect(october.duplicateBetleadsCosts).toBe(2);

    // September is before the since month: the manual SMS is the only data.
    const september = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
      preset: "custom",
    });
    expect(september.duplicateBetleadsCosts).toBe(0);

    // A window that is not a closed month has no cost month: nothing flagged.
    const week = await getFinanceDashboardFor(ctxFor(ADMIN_A), {
      scope: { kind: "tenant", tenantId: HOUSE_A },
      ...last7Days,
    });
    expect(week.duplicateBetleadsCosts).toBe(0);
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
      dayRow(HOUSE_A, "2026-10-06", { deposit_amount: 50 }), // pending past day
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
      roi: 3,
      incomplete: false,
      inProgress: false,
      betleadsMissing: false,
      byTenant: { [HOUSE_A]: 300 },
    });
    expect(dashboard.months[11]).toMatchObject({
      month: "2026-10",
      cashResult: 900,
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
    expect(b.current.cashResult).toBe(-20);
    expect(b.pendingDates).toEqual(["2026-10-22"]);
    expect(dashboard.totals.current.cashResult).toBe(170);
    expect(dashboard.totals.current.betleadsUsage).toBe(30);
    // Σresult / Σads = 170 / 400, not the mean of the houses.
    expect(dashboard.totals.current.roi).toBe(170 / 400);
    expect(a.goals).toEqual([
      { metric: "roi", direction: "gte", target: 0, value: 1.9, status: "green" },
    ]);
    expect(b.goals).toEqual([]);
    expect(dashboard.months.at(-1)!.byTenant).toEqual({ [HOUSE_A]: 190, [HOUSE_B]: -20 });
    // Group scope does not put a rate in the GGR label.
    expect(dashboard.costs.find((line) => line.key === "ggr_fee")?.label).toBe("Taxa de GGR");
    expect(financeDaysCalls[0]._tenants).toEqual([HOUSE_A, HOUSE_B]);
  });

  it("group scope: other costs and fee enter a whole calendar month and its whole previous month", async () => {
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
    expect(partial.totals.current.otherCosts).toBeNull();
    expect(partial.totals.current.betleadsFee).toBeNull();
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
    expect(financeDaysCalls[0]._tenants).toEqual([HOUSE_A, HOUSE_B, HOUSE_C]);
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
