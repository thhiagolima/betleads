// Leads mortos — the shared enrollment routine (scanner, webhook events,
// threshold crossing) leaves active dead leads out of non-express journeys
// before inserting, so eligible/duplicate counters stay accurate.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const queries: Array<{ table: string; filters: string[] }> = [];

  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private filterNames: string[] = [];
    private mode: "select" | "upsert" = "select";
    private payload: Row[] = [];
    constructor(private table: string) {
      tables[table] ??= [];
    }
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filterNames.push(`eq:${column}`);
      this.filters.push((row) => row[column] === value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filterNames.push(`in:${column}`);
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    is(column: string, value: unknown) {
      this.filterNames.push(`is:${column}`);
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    gte(column: string, value: string) {
      this.filters.push((row) => String(row[column]) >= value);
      return this;
    }
    upsert(rows: Row[]) {
      this.mode = "upsert";
      this.payload = rows;
      return this;
    }
    maybeSingle() {
      return this.execute().then(({ data, error }) => ({
        data: Array.isArray(data) ? (data[0] ?? null) : data,
        error,
      }));
    }
    then<T>(resolve: (value: { data: unknown; error: null }) => T) {
      return this.execute().then(resolve);
    }
    private async execute(): Promise<{ data: unknown; error: null }> {
      queries.push({ table: this.table, filters: this.filterNames });
      const rows = tables[this.table];
      if (this.mode === "upsert") {
        const inserted = this.payload.map((row, i) => ({ id: `e-${rows.length + i}`, ...row }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
      return { data: matched.map((row) => ({ ...row })), error: null };
    }
  }

  return {
    tables,
    queries,
    client: { from: (table: string) => new Query(table), rpc: async () => ({ data: null }) },
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      queries.length = 0;
    },
  };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fake.client }));
vi.mock("./observability/job-monitor.server", () => ({ startJobRun: vi.fn() }));
vi.mock("./observability/sentry.server", () => ({ captureServerException: vi.fn() }));

import { enrollPlayersInJourney } from "./journey-scanner.server";

const TENANT = "00000000-0000-0000-0000-000000000002";
const ALIVE = "00000000-0000-0000-0000-000000000003";
const DEAD = "00000000-0000-0000-0000-000000000004";
const REVIVED = "00000000-0000-0000-0000-000000000005";

const journey = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: TENANT,
    version: 1,
    status: "active",
    trigger_type: "cadastrados_sem_deposito",
    trigger_config: {},
    entry_rules: { audience: "system:all-leads", reentry: "once" },
    cooldown_hours: 24,
    ...overrides,
  }) as never;

const recent = new Date(Date.now() - 3600_000).toISOString();
const player = (id: string) =>
  ({
    id,
    tenant_id: TENANT,
    status: "ativo",
    vip: false,
    ftd_em: null,
    created_at: recent,
    total_depositado: 0,
  }) as never;

const players = [player(ALIVE), player(DEAD), player(REVIVED)];

beforeEach(() => {
  fake.reset();
  fake.tables.journey_contact_limits = [{ tenant_id: TENANT, dead_lead_enabled: true }];
  fake.tables.journey_dead_leads = [
    { tenant_id: TENANT, player_id: DEAD, revived_at: null },
    { tenant_id: TENANT, player_id: REVIVED, revived_at: new Date().toISOString() },
  ];
  fake.tables.journey_enrollments = [];
});

const enrolledIds = () => fake.tables.journey_enrollments.map((row) => row.player_id);

describe("enrollPlayersInJourney with the dead lead rule", () => {
  it("leaves active dead leads out and counts them as not eligible", async () => {
    const result = await enrollPlayersInJourney(journey(), players, { source: "async-v1" });
    expect(result).toMatchObject({ eligible: 2, enrolled: 2, duplicates: 0 });
    expect(enrolledIds()).toEqual([ALIVE, REVIVED]);
    expect(fake.queries).toContainEqual({
      table: "journey_dead_leads",
      filters: ["eq:tenant_id", "in:player_id", "is:revived_at"],
    });
  });

  it("express journeys (the player's own action) still take dead leads", async () => {
    const result = await enrollPlayersInJourney(journey({ express: true }), players, {
      source: "event-v1",
    });
    expect(result).toMatchObject({ eligible: 3, enrolled: 3 });
    expect(fake.queries.map((q) => q.table)).not.toContain("journey_dead_leads");
  });

  it("with the rule off (or no configuration row) nobody is filtered", async () => {
    fake.tables.journey_contact_limits = [{ tenant_id: TENANT, dead_lead_enabled: false }];
    expect(await enrollPlayersInJourney(journey(), players, { source: "async-v1" })).toMatchObject({
      eligible: 3,
      enrolled: 3,
    });
    fake.tables.journey_enrollments = [];
    fake.tables.journey_contact_limits = [];
    expect(await enrollPlayersInJourney(journey(), players, { source: "async-v1" })).toMatchObject({
      eligible: 3,
      enrolled: 3,
    });
    expect(fake.queries.map((q) => q.table)).not.toContain("journey_dead_leads");
  });
});
