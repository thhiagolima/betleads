// "Comparar casas": the core extracted to tenant-comparison.server.ts
// (getTenantComparisonFor) for the MCP comparar_casas tool. The panel's
// getTenantComparison (whose handler is getTenantComparisonForUser) must
// return exactly what it did before the extraction (same rows, same `from`,
// same RPC windows) and keep its own permission (comparableTenants).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
import { createFakeDb } from "./sms-bulk.test-support";
import { getTenantComparisonForUser } from "./tenant-comparison.functions";
import { getTenantComparisonFor } from "./tenant-comparison.server";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const PLAIN = "00000000-0000-4000-8000-0000000000bb";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-11-17T15:00:00.000Z");

type Row = Record<string, unknown>;
const crmRow = (overrides: Row): Row => ({
  tenant_id: HOUSE_A,
  source_type: "journey",
  source_key: "j1",
  source_id: null,
  step_position: 1,
  player_state: "ativo",
  sent: 0,
  failed: 0,
  cost: 0,
  recipients: 0,
  human_clicks: 0,
  converted_clicks: 0,
  direct_conversions: 0,
  direct_players: 0,
  direct_revenue: 0,
  influenced_players: 0,
  influenced_deposits: 0,
  influenced_revenue: 0,
  ...overrides,
});

let funnelCalls: Row[];
let playersCalls: Row[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.admin.reset();
  funnelCalls = [];
  playersCalls = [];
  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", moeda: "BRL" },
      { id: HOUSE_B, nome: "Casa B", moeda: "ARS" },
    );
  fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER, error: null }));
  fake.admin.rows("crm_results_daily").push(
    crmRow({
      metric_date: "2026-11-10",
      sent: 100,
      cost: 8,
      recipients: 100,
      human_clicks: 10,
      converted_clicks: 2,
      direct_conversions: 2,
      direct_players: 2,
      direct_revenue: 50,
      influenced_players: 3,
      influenced_deposits: 3,
      influenced_revenue: 120,
    }),
    crmRow({ metric_date: "2026-11-12", player_state: "dormindo", sent: 100, cost: 8 }),
    // Before the 30-day window (from 2026-10-19).
    crmRow({ metric_date: "2026-10-01", sent: 9999, cost: 999 }),
  );
  fake.admin.onRpc("crm_lifecycle_snapshot", (args) => ({
    data:
      args._tenant === HOUSE_A
        ? [
            { state: "ativo", players: 5 },
            { state: "perdido", players: "2" },
          ]
        : [],
    error: null,
  }));
  fake.admin.onRpc("crm_acquisition_funnel", (args) => {
    funnelCalls.push(args);
    return {
      data:
        args._tenant === HOUSE_A ? [{ origin: "__total__", signups: 10, first_deposit: 4 }] : [],
      error: null,
    };
  });
  fake.admin.onRpc("crm_retention_cohorts", (args) => ({
    data:
      args._tenant === HOUSE_A
        ? [
            { cohort_week: "2026-10-20", second_7d_pct: 25 },
            { cohort_week: "2026-11-10", second_7d_pct: 90 },
          ]
        : [],
    error: null,
  }));
  fake.admin.onRpc("crm_click_players_period", (args) => {
    playersCalls.push(args);
    return { data: null, error: null };
  });
});

afterEach(() => vi.useRealTimers());

// What getTenantComparison returned before the extraction for this fixture.
const ROW_A = {
  tenant: "Casa A",
  moeda: "BRL",
  clicks: 10,
  clickRate: 0.05,
  directPlayers: 2,
  conversionRate: 0.2,
  costPerConversion: 8,
  clickRoi: 3.125,
  sent: 200,
  cost: 16,
  influencedPlayers: 3,
  influencedRevenue: 120,
  directRevenue: 50,
  costPerRecovered: 16 / 3,
  roi: 7.5,
  costOnActiveShare: 0.5,
  base: { ativo: 5, esfriando: 0, dormindo: 0, perdido: 2, sem_ftd: 0 },
  signups: 10,
  signupToFtd: 0.4,
  secondDeposit7d: 0.25,
  cohortWeek: "2026-10-20",
};
const ROW_B = {
  tenant: "Casa B",
  moeda: "ARS",
  clicks: 0,
  clickRate: null,
  directPlayers: 0,
  conversionRate: null,
  costPerConversion: null,
  clickRoi: null,
  sent: 0,
  cost: 0,
  influencedPlayers: 0,
  influencedRevenue: 0,
  directRevenue: 0,
  costPerRecovered: null,
  roi: null,
  costOnActiveShare: null,
  base: { ativo: 0, esfriando: 0, dormindo: 0, perdido: 0, sem_ftd: 0 },
  signups: 0,
  signupToFtd: null,
  secondDeposit7d: null,
  cohortWeek: null,
};

describe("getTenantComparisonForUser (panel)", () => {
  it("returns the same result as before the extraction", async () => {
    const result = await getTenantComparisonForUser(SUPER, 30);

    expect(result).toEqual({ from: "2026-10-19", days: 30, rows: [ROW_A, ROW_B] });
    // Same windows as before: funnel from the first day up to now, players up to today.
    expect(funnelCalls).toContainEqual({
      _tenant: HOUSE_A,
      _from: "2026-10-19T03:00:00.000Z",
      _to: NOW.toISOString(),
    });
    expect(playersCalls).toContainEqual({
      _tenant: HOUSE_A,
      _from: "2026-10-19",
      _to: "2026-11-17",
    });
  });

  it("delegates to getTenantComparisonFor over comparableTenants' houses", async () => {
    const panel = await getTenantComparisonForUser(SUPER, 30);
    const core = await getTenantComparisonFor(
      [
        { id: HOUSE_A, nome: "Casa A", moeda: "BRL" },
        { id: HOUSE_B, nome: "Casa B", moeda: "ARS" },
      ],
      { from: "2026-10-19", to: "2026-11-17" },
      NOW,
    );
    expect(panel.rows).toEqual(core);
  });

  it("keeps its own permission: a user who is admin of fewer than two houses is refused", async () => {
    fake.admin.rows("user_roles").push({ user_id: PLAIN, tenant_id: HOUSE_A, role: "admin" });
    await expect(getTenantComparisonForUser(PLAIN, 30)).rejects.toThrow(
      "Disponível apenas para administradores de duas ou mais casas.",
    );
    expect(funnelCalls).toEqual([]);
  });
});

describe("getTenantComparisonFor", () => {
  it("only counts days inside the range and closes the funnel at the end of the last day", async () => {
    const [row] = await getTenantComparisonFor(
      [{ id: HOUSE_A, nome: "Casa A", moeda: "BRL" }],
      { from: "2026-11-11", to: "2026-11-12" },
      NOW,
    );
    expect(row.sent).toBe(100);
    expect(row.cost).toBe(8);
    expect(funnelCalls).toEqual([
      { _tenant: HOUSE_A, _from: "2026-11-11T03:00:00.000Z", _to: "2026-11-13T03:00:00.000Z" },
    ]);
  });
});
