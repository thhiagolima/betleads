// Grupos de casas, Task 5: financial month of a house, manual entries
// (retroactive included), rates, viewer grants, goals (the group overview tests moved to
// finance-dashboard.functions.test.ts with the dashboard that replaced it).
// Uses the in-memory createFakeDb stand-in for supabaseAdmin. The permission
// helpers are a small model of the SQL in 20261101100100_tenant_finance.sql;
// finance_days / finance_goal_days return fixed rows filtered by tenant/window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import {
  getTenantFinanceMonthFor,
  saveFinanceDaysFor,
  saveOtherCostFor,
  setFinanceRatesFor,
  setFinanceViewerFor,
  setMonthlyGgrFor,
  setMonthlyGgrInput,
  setTenantGoalFor,
} from "./finance.functions";
import { createFakeDb } from "./sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_A = "00000000-0000-4000-8000-0000000000dd";
const MEMBER_A = "00000000-0000-4000-8000-0000000000ee";
const G1 = "00000000-0000-4000-8000-00000000a001";
const G2 = "00000000-0000-4000-8000-00000000b001";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const DEMO = "00000000-0000-4000-8000-00000000d3d0";

const authUsers = [
  { id: SUPER, email: "super@example.com" },
  { id: G1_MANAGER, email: "gestor.grupo@example.com" },
  { id: ADMIN_A, email: "admin.a@example.com" },
  { id: GESTOR_A, email: "gestor.a@example.com" },
  { id: MEMBER_A, email: "membro.a@example.com" },
];

type Ctx = Parameters<typeof getTenantFinanceMonthFor>[0];
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 12:00 in São Paulo on 2026-10-24.
  vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
  __resetDemoTenantCacheForTests();
  fake.admin.reset();
  financeDayRows = [];
  goalDayRows = [];
  usageRows = [];
  feeRows = [];
  sinceRows = [];
  financeDaysCalls = [];
  (fake.admin.client as unknown as Record<string, unknown>).auth = {
    admin: { listUsers: async () => ({ data: { users: authUsers }, error: null }) },
  };

  const isSuper = (u: unknown) => u === SUPER;
  const isGroupManager = (u: unknown, t: unknown) => groupHouses(String(u)).includes(t);
  const canEditRates = (u: unknown, t: unknown) =>
    isSuper(u) || hasRole(u, t, "admin") || isGroupManager(u, t);
  fake.admin.onRpc("finance_can_view", ({ _user: u, _tenant: t }) => ({
    data:
      canEditRates(u, t) ||
      (hasRole(u, t, "gestor") &&
        fake.admin
          .rows("tenant_finance_viewers")
          .some((v) => v.user_id === u && v.tenant_id === t)),
    error: null,
  }));
  fake.admin.onRpc("finance_can_edit_values", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin"),
    error: null,
  }));
  fake.admin.onRpc("finance_can_edit_rates", ({ _user: u, _tenant: t }) => ({
    data: canEditRates(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_viewers", ({ _user: u, _tenant: t }) => ({
    data: canEditRates(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_goals", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || isGroupManager(u, t),
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
  const inWindow = (row: Row, args: Row) =>
    (args._tenants as string[]).includes(String(row.tenant_id)) &&
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
  const ofTenants = (row: Row, args: Row) =>
    (args._tenants as string[]).includes(String(row.tenant_id));
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
  fake.admin.onRpc("finance_tenants_exempt", (args) => ({
    data: (args._tenants as string[]).map((id) => ({ tenant_id: id, exempt: false })),
    error: null,
  }));

  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", status: "active", is_demo: false },
      { id: HOUSE_B, nome: "Casa B", status: "active", is_demo: false },
      { id: HOUSE_C, nome: "Casa C", status: "active", is_demo: false },
      { id: DEMO, nome: "Casa Demo", status: "active", is_demo: true },
    );
  fake.admin
    .rows("tenant_groups")
    .push({ id: G1, nome: "Grupo 1", is_demo: false }, { id: G2, nome: "Grupo 2", is_demo: false });
  fake.admin
    .rows("tenant_group_tenants")
    .push(
      { group_id: G1, tenant_id: HOUSE_A },
      { group_id: G1, tenant_id: HOUSE_B },
      { group_id: G2, tenant_id: HOUSE_C },
    );
  fake.admin.rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  roles().push(
    { id: "r1", user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin", created_at: "2026-01-01" },
    { id: "r2", user_id: GESTOR_A, tenant_id: HOUSE_A, role: "gestor", created_at: "2026-01-02" },
    { id: "r3", user_id: MEMBER_A, tenant_id: HOUSE_A, role: "member", created_at: "2026-01-03" },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("house financial month", () => {
  it("gestor without grant cannot read month", async () => {
    await expect(
      getTenantFinanceMonthFor(ctxFor(GESTOR_A), { tenantId: HOUSE_A, month: "2026-10" }),
    ).rejects.toThrow("Sem permissão");
  });

  it("group manager reads month read-only", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-01", { deposit_amount: 500, ad_spend: 100, ggr: 50 }),
      dayRow(HOUSE_A, "2026-10-02", { deposit_amount: 200 }),
    );
    fake.admin
      .rows("tenant_finance_other_costs")
      .push(
        { id: "c1", tenant_id: HOUSE_A, month: "2026-10-01", descricao: "CRM", valor: 30 },
        { id: "c2", tenant_id: HOUSE_A, month: "2026-09-01", descricao: "SMS", valor: 99 },
      );
    fake.admin
      .rows("tenant_finance_rates")
      .push({ tenant_id: HOUSE_A, valid_from: "2026-10-10", ggr_fee_pct: 15, movement_fee_pct: 2 });
    fake.admin.rows("tenant_finance_viewers").push({ tenant_id: HOUSE_A, user_id: GESTOR_A });
    goalDayRows.push(
      {
        tenant_id: HOUSE_A,
        metric_date: "2026-10-01",
        metric: "deposits",
        direction: "gte",
        daily_value: 300,
      },
      {
        tenant_id: HOUSE_A,
        metric_date: "2026-10-02",
        metric: "deposits",
        direction: "gte",
        daily_value: 300,
      },
    );

    const month = await getTenantFinanceMonthFor(ctxFor(G1_MANAGER), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });

    expect(month.permissions).toEqual({
      canEditValues: false,
      canEditRates: true,
      canManageViewers: true,
      canManageGoals: true,
    });
    expect(month.tenant).toEqual({ id: HOUSE_A, nome: "Casa A" });
    expect(financeDaysCalls).toEqual([
      { _tenants: [HOUSE_A], _from: "2026-10-01", _to: "2026-10-24" },
    ]);
    expect(month.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(month.otherCosts).toEqual([
      { id: "c1", descricao: "CRM", valor: 30, categoria: "Outros", suspectedBetleads: false },
    ]);
    expect(month.summary.otherCosts).toBe(30);
    expect(month.summary.pendingDays).toBe(1);
    expect(month.rates.current).toEqual({
      ggrFeePct: 15,
      movementFeePct: 2,
      validFrom: "2026-10-10",
    });
    expect(month.viewers).toEqual([
      { user_id: GESTOR_A, email: "gestor.a@example.com", canView: true },
    ]);
    expect(month.goals).toEqual([
      { metric: "deposits", direction: "gte", target: 600, value: 700, status: "green" },
    ]);
  });

  it("future month days do not appear and default rates apply", async () => {
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-11",
    });
    expect(financeDaysCalls).toHaveLength(0);
    expect(month.days).toEqual([]);
    expect(month.rates.current).toEqual({ ggrFeePct: 16, movementFeePct: 2.7, validFrom: null });
    expect(month.permissions.canEditValues).toBe(true);
    expect(month.permissions.canManageGoals).toBe(false);
  });
});

describe("house financial month: Betleads cost and categories", () => {
  it("month summary deducts the month's Betleads usage and fee", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-05", { deposit_amount: 1000, ad_spend: 100, ggr: 0 }),
    );
    usageRows.push(
      { tenant_id: HOUSE_A, metric_date: "2026-10-05", amount: 10 },
      { tenant_id: HOUSE_A, metric_date: "2026-10-12", amount: 5 },
      { tenant_id: HOUSE_B, metric_date: "2026-10-05", amount: 999 },
    );
    feeRows.push(
      { tenant_id: HOUSE_A, month: "2026-10-01", amount: 300 },
      { tenant_id: HOUSE_A, month: "2026-09-01", amount: 200 },
    );

    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(month.summary.betleadsUsage).toBe(15);
    expect(month.summary.betleadsFee).toBe(300);
    expect(month.summary.cashResult).toBe(1000 - 100 - 15 - 300);
  });

  it("a month with no invoice has fee 0, not null", async () => {
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(month.summary.betleadsFee).toBe(0);
    expect(month.summary.betleadsUsage).toBe(0);
  });

  it("other costs return categoria (null -> Outros) and suspectedBetleads only from the since month on", async () => {
    sinceRows.push({ tenant_id: HOUSE_A, since: "2026-10-10" });
    fake.admin.rows("tenant_finance_other_costs").push(
      {
        id: "c1",
        tenant_id: HOUSE_A,
        month: "2026-10-01",
        descricao: "SMS",
        valor: 30,
        categoria: null,
      },
      {
        id: "c2",
        tenant_id: HOUSE_A,
        month: "2026-10-01",
        descricao: "Aluguel",
        valor: 20,
        categoria: "Equipe",
      },
      {
        id: "c3",
        tenant_id: HOUSE_A,
        month: "2026-09-01",
        descricao: "SMS",
        valor: 99,
        categoria: null,
      },
    );

    const october = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(october.otherCosts).toEqual([
      { id: "c1", descricao: "SMS", valor: 30, categoria: "Outros", suspectedBetleads: true },
      { id: "c2", descricao: "Aluguel", valor: 20, categoria: "Equipe", suspectedBetleads: false },
    ]);

    // September is before the since month: the manual SMS cost is not flagged.
    const september = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-09",
    });
    expect(september.otherCosts).toEqual([
      { id: "c3", descricao: "SMS", valor: 99, categoria: "Outros", suspectedBetleads: false },
    ]);
  });

  it("returns betleadsSince (null when the house has no consumption yet)", async () => {
    const none = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(none.betleadsSince).toBeNull();

    sinceRows.push({ tenant_id: HOUSE_A, since: "2026-10-10" });
    const september = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-09",
    });
    expect(september.betleadsSince).toBe("2026-10-10");
  });

  it("a house without since never flags suspectedBetleads", async () => {
    fake.admin.rows("tenant_finance_other_costs").push({
      id: "c1",
      tenant_id: HOUSE_A,
      month: "2026-10-01",
      descricao: "SMS",
      valor: 30,
      categoria: null,
    });
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(month.otherCosts).toEqual([
      { id: "c1", descricao: "SMS", valor: 30, categoria: "Outros", suspectedBetleads: false },
    ]);
  });

  it("categories lists fixed first then the house's own, sorted pt-BR", async () => {
    fake.admin.rows("tenant_finance_other_costs").push(
      {
        id: "c1",
        tenant_id: HOUSE_A,
        month: "2026-10-01",
        descricao: "Agência",
        valor: 10,
        categoria: "Marketing",
      },
      {
        id: "c2",
        tenant_id: HOUSE_A,
        month: "2026-09-01",
        descricao: "Old",
        valor: 5,
        categoria: "Suporte",
      },
      {
        id: "c3",
        tenant_id: HOUSE_A,
        month: "2026-08-01",
        descricao: "x",
        valor: 1,
        categoria: null,
      },
    );
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(month.categories).toEqual([
      "Afiliados e influenciadores",
      "Equipe",
      "Ferramentas",
      "Impostos",
      "Outros",
      "Marketing",
      "Suporte",
    ]);
  });

  it("saveOtherCost stores a new category and it shows in categories next month", async () => {
    await saveOtherCostFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
      descricao: "Consultoria",
      valor: 200,
      categoria: "Consultoria Jurídica",
    });
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-11",
    });
    expect(month.categories).toContain("Consultoria Jurídica");
  });

  it("saveOtherCost stores categoria via categoryLabel; Outros stores null; missing keeps, explicit null clears", async () => {
    const created = await saveOtherCostFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
      descricao: "Agência",
      valor: 100,
      categoria: "  Marketing   Digital  ",
    });
    expect(
      fake.admin.rows("tenant_finance_other_costs").find((r) => r.id === created.id)?.categoria,
    ).toBe("Marketing Digital");

    const outros = await saveOtherCostFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
      descricao: "X",
      valor: 1,
      categoria: "outros",
    });
    expect(
      fake.admin.rows("tenant_finance_other_costs").find((r) => r.id === outros.id)?.categoria,
    ).toBeNull();

    // Missing categoria on update keeps the stored value.
    await saveOtherCostFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      id: created.id,
      month: "2026-10",
      descricao: "Agência",
      valor: 150,
    });
    expect(
      fake.admin.rows("tenant_finance_other_costs").find((r) => r.id === created.id)?.categoria,
    ).toBe("Marketing Digital");

    // Explicit null clears it.
    await saveOtherCostFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      id: created.id,
      month: "2026-10",
      descricao: "Agência",
      valor: 150,
      categoria: null,
    });
    expect(
      fake.admin.rows("tenant_finance_other_costs").find((r) => r.id === created.id)?.categoria,
    ).toBeNull();

    const audit = fake.admin
      .rows("tenant_audit_logs")
      .filter((a) => a.action === "finance.other_cost_saved");
    expect(audit.at(-1)).toMatchObject({
      after_data: expect.objectContaining({ categoria: null }),
    });
  });
});

describe("manual entries", () => {
  it("saveFinanceDays rejects future dates", async () => {
    await expect(
      saveFinanceDaysFor(ctxFor(ADMIN_A), {
        tenantId: HOUSE_A,
        entries: [{ date: "2026-10-25", ggr: 10 }],
      }),
    ).rejects.toThrow("Data futura não permitida");
    expect(fake.admin.rows("tenant_finance_daily")).toHaveLength(0);
  });

  it("saveFinanceDays accepts past dates and audits each changed day", async () => {
    fake.admin
      .rows("tenant_finance_daily")
      .push({ tenant_id: HOUSE_A, metric_date: "2026-09-20", ad_spend: 50, ggr: 100 });

    const result = await saveFinanceDaysFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      entries: [
        { date: "2026-09-20", adSpend: 50 },
        { date: "2026-10-24", ggr: -30 },
      ],
    });

    expect(result).toEqual({ changed: 1 });
    const daily = fake.admin.rows("tenant_finance_daily");
    expect(daily).toContainEqual(
      expect.objectContaining({
        tenant_id: HOUSE_A,
        metric_date: "2026-09-20",
        ad_spend: 50,
        ggr: 100,
      }),
    );
    expect(daily).toContainEqual(
      expect.objectContaining({
        tenant_id: HOUSE_A,
        metric_date: "2026-10-24",
        ad_spend: null,
        ggr: -30,
        updated_by: ADMIN_A,
      }),
    );
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: HOUSE_A,
      actor_user_id: ADMIN_A,
      action: "finance.day_updated",
      entity_id: "2026-10-24",
      before_data: { date: "2026-10-24", ad_spend: null, ggr: null },
      after_data: { date: "2026-10-24", ad_spend: null, ggr: -30 },
    });
  });

  it("saveFinanceDays: null clears a field and a missing field is kept", async () => {
    fake.admin
      .rows("tenant_finance_daily")
      .push({ tenant_id: HOUSE_A, metric_date: "2026-10-01", ad_spend: 50, ggr: 100 });
    await saveFinanceDaysFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      entries: [{ date: "2026-10-01", ggr: null }],
    });
    expect(fake.admin.rows("tenant_finance_daily")[0]).toMatchObject({ ad_spend: 50, ggr: null });
    expect(fake.admin.rows("tenant_audit_logs")[0]).toMatchObject({
      before_data: { date: "2026-10-01", ad_spend: 50, ggr: 100 },
      after_data: { date: "2026-10-01", ad_spend: 50, ggr: null },
    });
  });

  it("saveFinanceDays: group manager is rejected", async () => {
    await expect(
      saveFinanceDaysFor(ctxFor(G1_MANAGER), {
        tenantId: HOUSE_A,
        entries: [{ date: "2026-10-01", ggr: 10 }],
      }),
    ).rejects.toThrow("Sem permissão");
    expect(fake.admin.rows("tenant_finance_daily")).toHaveLength(0);
  });

  it("demo writes are blocked", async () => {
    await expect(
      saveFinanceDaysFor(ctxFor(SUPER), {
        tenantId: DEMO,
        entries: [{ date: "2026-10-01", ggr: 10 }],
      }),
    ).rejects.toMatchObject({ code: "DEMO_ACTION_BLOCKED" });
    expect(fake.admin.rows("tenant_finance_daily")).toHaveLength(0);
  });
});

describe("viewer grants", () => {
  it("setFinanceViewer only targets gestores", async () => {
    await expect(
      setFinanceViewerFor(ctxFor(ADMIN_A), { tenantId: HOUSE_A, userId: MEMBER_A, canView: true }),
    ).rejects.toThrow("Só gestores da casa podem ser liberados");
    expect(fake.admin.rows("tenant_finance_viewers")).toHaveLength(0);

    await setFinanceViewerFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      userId: GESTOR_A,
      canView: true,
    });
    expect(fake.admin.rows("tenant_finance_viewers")).toEqual([
      expect.objectContaining({ tenant_id: HOUSE_A, user_id: GESTOR_A, granted_by: ADMIN_A }),
    ]);
    expect(fake.admin.rows("tenant_audit_logs")).toEqual([
      expect.objectContaining({ action: "finance.viewer_changed", entity_id: GESTOR_A }),
    ]);

    await setFinanceViewerFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      userId: GESTOR_A,
      canView: false,
    });
    expect(fake.admin.rows("tenant_finance_viewers")).toHaveLength(0);
  });

  it("setFinanceViewer revokes a stale grant of someone no longer gestor", async () => {
    // MEMBER_A was a liberated gestor and got demoted to member; the grant stayed.
    fake.admin.rows("tenant_finance_viewers").push({ tenant_id: HOUSE_A, user_id: MEMBER_A });
    const result = await setFinanceViewerFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      userId: MEMBER_A,
      canView: false,
    });
    expect(result).toEqual({ ok: true, changed: true });
    expect(fake.admin.rows("tenant_finance_viewers")).toHaveLength(0);
    expect(fake.admin.rows("tenant_audit_logs")).toEqual([
      expect.objectContaining({ action: "finance.viewer_changed", entity_id: MEMBER_A }),
    ]);
  });
});

describe("validFrom is never in the past", () => {
  it("setFinanceRates rejects a past validFrom and accepts today", async () => {
    await expect(
      setFinanceRatesFor(ctxFor(ADMIN_A), {
        tenantId: HOUSE_A,
        validFrom: "2026-10-23",
        ggrFeePct: 15,
        movementFeePct: 2,
      }),
    ).rejects.toThrow("A data de início não pode ser no passado");
    expect(fake.admin.rows("tenant_finance_rates")).toHaveLength(0);

    const res = await setFinanceRatesFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      validFrom: "2026-10-24",
      ggrFeePct: 15,
      movementFeePct: 2,
    });
    expect(res.validFrom).toBe("2026-10-24");
  });

  it("setTenantGoal rejects a past validFrom and defaults to today", async () => {
    await expect(
      setTenantGoalFor(ctxFor(G1_MANAGER), {
        tenantId: HOUSE_A,
        metric: "ftds",
        direction: "gte",
        dailyValue: 10,
        validFrom: "2026-10-01",
      }),
    ).rejects.toThrow("A data de início não pode ser no passado");
    expect(fake.admin.rows("tenant_goals")).toHaveLength(0);

    const res = await setTenantGoalFor(ctxFor(G1_MANAGER), {
      tenantId: HOUSE_A,
      metric: "ftds",
      direction: "gte",
      dailyValue: 10,
    });
    expect(res.validFrom).toBe("2026-10-24");
  });
});

describe("GGR do mês (monthly accumulated total)", () => {
  const monthly = (tenantId: string, month: string, ggr: number, validThrough: string) => ({
    tenant_id: tenantId,
    month,
    ggr,
    valid_through: validThrough,
  });

  it("month view allocates the total up to validThrough, ignores stored daily GGR and leaves later days pending", async () => {
    financeDayRows.push(
      dayRow(HOUSE_A, "2026-10-01", {
        deposit_amount: 300,
        ad_spend: 0,
        ggr: 999,
        ggr_fee_pct: 17,
      }),
      dayRow(HOUSE_A, "2026-10-02", {
        deposit_amount: 100,
        ad_spend: 0,
        ggr: 999,
        ggr_fee_pct: 17,
      }),
      dayRow(HOUSE_A, "2026-10-03", {
        deposit_amount: 100,
        ad_spend: 0,
        ggr: 999,
        ggr_fee_pct: 17,
      }),
    );
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push(
        monthly(HOUSE_A, "2026-10-01", 1000, "2026-10-02"),
        monthly(HOUSE_A, "2026-09-01", 5, "2026-09-30"),
        monthly(HOUSE_B, "2026-10-01", 77, "2026-10-20"),
      );

    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });

    expect(month.monthlyGgr).toEqual({ ggr: 1000, validThrough: "2026-10-02" });
    expect(month.days.map((d) => [d.date, d.ggr, d.ggrEstimated, d.pending])).toEqual([
      ["2026-10-01", 750, true, false],
      ["2026-10-02", 250, true, false],
      ["2026-10-03", null, false, true],
    ]);
    expect(month.summary.ggr).toBe(1000);
    expect(month.summary.ggrFee).toBe(170);
  });

  it("month view without a monthly total keeps the daily GGR", async () => {
    financeDayRows.push(dayRow(HOUSE_A, "2026-10-01", { ad_spend: 0, ggr: 12 }));
    const month = await getTenantFinanceMonthFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
    });
    expect(month.monthlyGgr).toBeNull();
    expect(month.days[0]).toMatchObject({ ggr: 12, ggrEstimated: false });
  });

  it("setMonthlyGgr saves, overwrites and clears, auditing before/after", async () => {
    await setMonthlyGgrFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
      ggr: 1497.151,
      validThrough: "2026-10-23",
    });
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toEqual([
      expect.objectContaining({
        tenant_id: HOUSE_A,
        month: "2026-10-01",
        ggr: 1497.15,
        valid_through: "2026-10-23",
        updated_by: ADMIN_A,
      }),
    ]);

    await setMonthlyGgrFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-10",
      ggr: 1600,
      validThrough: "2026-10-24",
    });
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toEqual([
      expect.objectContaining({ ggr: 1600, valid_through: "2026-10-24" }),
    ]);

    await setMonthlyGgrFor(ctxFor(ADMIN_A), { tenantId: HOUSE_A, month: "2026-10", ggr: null });
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toHaveLength(0);

    const audit = fake.admin
      .rows("tenant_audit_logs")
      .filter((row) => row.action === "finance.month_ggr_updated");
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({
      tenant_id: HOUSE_A,
      actor_user_id: ADMIN_A,
      entity_id: "2026-10",
      before_data: null,
      after_data: { month: "2026-10-01", ggr: 1497.15, valid_through: "2026-10-23" },
    });
    expect(audit[1]).toMatchObject({
      before_data: { month: "2026-10-01", ggr: 1497.15, valid_through: "2026-10-23" },
      after_data: { month: "2026-10-01", ggr: 1600, valid_through: "2026-10-24" },
    });
    expect(audit[2]).toMatchObject({
      before_data: { month: "2026-10-01", ggr: 1600, valid_through: "2026-10-24" },
      after_data: null,
    });
  });

  it("setMonthlyGgr: clearing a month without a total changes nothing", async () => {
    const result = await setMonthlyGgrFor(ctxFor(ADMIN_A), {
      tenantId: HOUSE_A,
      month: "2026-09",
      ggr: null,
    });
    expect(result).toEqual({ changed: false });
    expect(fake.admin.rows("tenant_audit_logs")).toHaveLength(0);
  });

  it("setMonthlyGgr requires finance_can_edit_values", async () => {
    for (const user of [G1_MANAGER, GESTOR_A, MEMBER_A]) {
      await expect(
        setMonthlyGgrFor(ctxFor(user), {
          tenantId: HOUSE_A,
          month: "2026-10",
          ggr: 10,
          validThrough: "2026-10-23",
        }),
      ).rejects.toThrow("Sem permissão");
    }
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toHaveLength(0);
  });

  it("setMonthlyGgr refuses the demo house", async () => {
    await expect(
      setMonthlyGgrFor(ctxFor(SUPER), {
        tenantId: DEMO,
        month: "2026-10",
        ggr: 10,
        validThrough: "2026-10-23",
      }),
    ).rejects.toMatchObject({ code: "DEMO_ACTION_BLOCKED" });
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toHaveLength(0);
  });

  it("setMonthlyGgr: validThrough must be inside the month and not after today", async () => {
    await expect(
      setMonthlyGgrFor(ctxFor(ADMIN_A), {
        tenantId: HOUSE_A,
        month: "2026-10",
        ggr: 10,
        validThrough: "2026-09-30",
      }),
    ).rejects.toThrow("A data deve estar dentro do mês");
    await expect(
      setMonthlyGgrFor(ctxFor(ADMIN_A), {
        tenantId: HOUSE_A,
        month: "2026-10",
        ggr: 10,
        validThrough: "2026-10-25",
      }),
    ).rejects.toThrow("Data futura não permitida");
    await expect(
      setMonthlyGgrFor(ctxFor(ADMIN_A), {
        tenantId: HOUSE_A,
        month: "2026-11",
        ggr: 10,
        validThrough: "2026-11-01",
      }),
    ).rejects.toThrow("Data futura não permitida");
    expect(fake.admin.rows("tenant_finance_monthly_ggr")).toHaveLength(0);
  });

  it("setMonthlyGgrInput requires validThrough when ggr is set", () => {
    expect(() =>
      setMonthlyGgrInput.parse({ tenantId: HOUSE_A, month: "2026-10", ggr: 10 }),
    ).toThrow("Informe a data");
    expect(
      setMonthlyGgrInput.parse({ tenantId: HOUSE_A, month: "2026-10", ggr: null }),
    ).toMatchObject({ ggr: null });
    expect(
      setMonthlyGgrInput.parse({
        tenantId: HOUSE_A,
        month: "2026-10",
        ggr: -5,
        validThrough: "2026-10-01",
      }),
    ).toMatchObject({ ggr: -5 });
  });
});
