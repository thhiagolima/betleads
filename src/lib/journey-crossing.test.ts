import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------
// In-memory fake of the supabase-js surface used by the journey workers.
// ------------------------------------------------------------------
type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  const uniqueKeys: Record<string, string[]> = {
    journey_enrollments: ["journey_id", "player_id", "entry_key"],
    journey_crossing_states: ["journey_id"],
  };
  const rpcs: Record<string, (args: Row) => unknown> = {};

  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private limitN: number | null = null;
    private mode: "select" | "update" | "upsert" = "select";
    private payload: Row | Row[] | null = null;
    private returning = false;
    private options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    constructor(private table: string) {
      tables[table] ??= [];
    }
    select() {
      if (this.mode !== "select") this.returning = true;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    gte(column: string, value: string) {
      this.filters.push((row) => String(row[column]) >= value);
      return this;
    }
    gt(column: string, value: string) {
      this.filters.push((row) => String(row[column]) > value);
      return this;
    }
    ilike() {
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    update(patch: Row) {
      this.mode = "update";
      this.payload = patch;
      return this;
    }
    upsert(rows: Row[], options: { onConflict?: string; ignoreDuplicates?: boolean }) {
      this.mode = "upsert";
      this.payload = rows;
      this.options = options;
      return this;
    }
    maybeSingle() {
      return this.execute().then(({ data, error }) => ({
        data: Array.isArray(data) ? (data[0] ?? null) : data,
        error,
      }));
    }
    then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (e: unknown) => T) {
      return this.execute().then(resolve, reject);
    }
    private async execute(): Promise<{ data: unknown; error: null }> {
      const rows = tables[this.table];
      if (this.mode === "upsert") {
        const keys = (this.options.onConflict ?? "id").split(",");
        const inserted: Row[] = [];
        for (const row of this.payload as Row[]) {
          const clash = rows.find((existing) => keys.every((key) => existing[key] === row[key]));
          if (clash) continue;
          const stored = {
            id: `${this.table}-${rows.length + 1}`,
            revision: 0,
            pending_until: null,
            cursor_crossing_at: null,
            cursor_player_id: null,
            lease_owner: null,
            lease_expires_at: null,
            created_at: new Date().toISOString(),
            ...row,
          };
          rows.push(stored);
          inserted.push(stored);
        }
        return { data: this.returning ? inserted : null, error: null };
      }
      const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.mode === "update") {
        for (const row of matched) Object.assign(row, this.payload);
        return { data: this.returning ? matched.map((row) => ({ ...row })) : null, error: null };
      }
      const limited = this.limitN == null ? matched : matched.slice(0, this.limitN);
      return { data: limited.map((row) => ({ ...row })), error: null };
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      const handler = rpcs[name];
      return handler ? { data: handler(args), error: null } : { data: null, error: null };
    },
  };
  void uniqueKeys;
  return {
    tables,
    rpcCalls,
    rpcs,
    client,
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      rpcCalls.length = 0;
      for (const key of Object.keys(rpcs)) delete rpcs[key];
    },
  };
});

const monitor = vi.hoisted(() => ({
  startJobRun: vi.fn(),
  finish: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  progress: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fake.client }));
vi.mock("./observability/job-monitor.server", () => ({ startJobRun: monitor.startJobRun }));
vi.mock("./observability/sentry.server", () => ({ captureServerException: vi.fn() }));

import {
  advanceCrossingState,
  crossingWindow,
  initialWatermark,
  runJourneyCrossing,
  type CrossingState,
} from "./journey-crossing.server";
import { enrollPlayersInJourney } from "./journey-scanner.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const JOURNEY = "33333333-3333-4333-8333-333333333333";
const HOUR = 3600_000;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const inactivityJourney = (overrides: Row = {}) => ({
  id: JOURNEY,
  tenant_id: TENANT,
  version: 1,
  status: "active",
  trigger_type: "inactivity",
  trigger_config: { field: "ultimo_deposito", hours: 48 },
  entry_rules: { audience: "system:all-leads", reentry: "per_occurrence" },
  cooldown_hours: 24,
  ...overrides,
});

const player = (id: string, depositAt: number, overrides: Row = {}) => ({
  id,
  tenant_id: TENANT,
  status: "ativo",
  vip: false,
  ftd_em: iso(depositAt - 30 * 24 * HOUR),
  created_at: iso(depositAt - 60 * 24 * HOUR),
  updated_at: iso(depositAt),
  total_depositado: 100,
  ultimo_login: null,
  ultimo_jogo: null,
  ultimo_deposito: iso(depositAt),
  ...overrides,
});

/** JS mirror of public.journey_crossing_candidates (the SQL is validated in PGlite). */
function candidatesRpc(args: Row) {
  const offset = Number(args.p_hours) * HOUR;
  const fields = args.p_fields as string[];
  const lo = Date.parse(String(args.p_from)) - offset;
  const hi = Date.parse(String(args.p_to)) - offset;
  const afterAt = args.p_after_crossing_at ? Date.parse(String(args.p_after_crossing_at)) : null;
  const afterId = args.p_after_player_id as string | null;
  return (fake.tables.players ?? [])
    .filter((row) => row.tenant_id === args.p_tenant_id)
    .map((row) => {
      const activity = Math.max(
        ...fields.map((field) => (row[field] ? Date.parse(String(row[field])) : 0)),
      );
      return { player_id: String(row.id), activity };
    })
    .filter(({ activity }) => activity > lo && activity <= hi)
    .map(({ player_id, activity }) => ({ player_id, crossing: activity + offset }))
    .filter(
      ({ player_id, crossing }) =>
        afterAt == null ||
        afterId == null ||
        crossing > afterAt ||
        (crossing === afterAt && player_id > afterId),
    )
    .sort((a, b) => a.crossing - b.crossing || a.player_id.localeCompare(b.player_id))
    .slice(0, Number(args.p_limit))
    .map(({ player_id, crossing }) => ({ player_id, crossing_at: iso(crossing) }));
}

function enableWorkers() {
  process.env.JOURNEYS_SCANNER_ENABLED = "true";
  process.env.JOURNEYS_CANARY_TENANT_IDS = TENANT;
}

beforeEach(() => {
  fake.reset();
  fake.rpcs.journey_crossing_candidates = candidatesRpc;
  monitor.startJobRun.mockResolvedValue({
    job: "journey_crossing",
    id: 1,
    progress: monitor.progress,
    finish: monitor.finish,
    fail: monitor.fail,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete process.env.JOURNEYS_SCANNER_ENABLED;
  delete process.env.JOURNEYS_CROSSING_ENABLED;
  delete process.env.JOURNEYS_CANARY_TENANT_IDS;
  delete process.env.JOURNEYS_CANARY_JOURNEY_IDS;
  delete process.env.JOURNEYS_ALLOW_ALL_TENANTS;
});

const baseState = (overrides: Partial<CrossingState> = {}): CrossingState => ({
  journey_id: JOURNEY,
  tenant_id: TENANT,
  journey_version: 1,
  watermark_at: iso(NOW - 60_000),
  pending_until: null,
  cursor_crossing_at: null,
  cursor_player_id: null,
  initialized_at: iso(NOW - HOUR),
  revision: 3,
  lease_owner: null,
  lease_expires_at: null,
  ...overrides,
});

describe("crossing window selection", () => {
  it("covers (watermark, now] and nothing when caught up", () => {
    expect(crossingWindow(baseState(), NOW)).toEqual({
      from: iso(NOW - 60_000),
      to: iso(NOW),
      afterCrossingAt: null,
      afterPlayerId: null,
    });
    expect(crossingWindow(baseState({ watermark_at: iso(NOW) }), NOW)).toBeNull();
  });

  it("resumes an open window at its fixed upper bound and keyset cursor", () => {
    const state = baseState({
      pending_until: iso(NOW - 30_000),
      cursor_crossing_at: iso(NOW - 45_000),
      cursor_player_id: "p-9",
    });
    expect(crossingWindow(state, NOW)).toEqual({
      from: iso(NOW - 60_000),
      to: iso(NOW - 30_000),
      afterCrossingAt: iso(NOW - 45_000),
      afterPlayerId: "p-9",
    });
  });

  it("starts at now (no backfill) unless a past start_after asks for catch-up", () => {
    expect(initialWatermark({ trigger_config: {} }, NOW)).toBe(iso(NOW));
    expect(initialWatermark({ trigger_config: { start_after: iso(NOW - 2 * HOUR) } }, NOW)).toBe(
      iso(NOW - 2 * HOUR),
    );
    expect(initialWatermark({ trigger_config: { start_after: iso(NOW + HOUR) } }, NOW)).toBe(
      iso(NOW),
    );
  });

  it("advances the watermark on a short page and keeps a cursor on a full page", () => {
    const window = crossingWindow(baseState(), NOW)!;
    const page = [
      { player_id: "a", crossing_at: iso(NOW - 50_000) },
      { player_id: "b", crossing_at: iso(NOW - 40_000) },
    ];
    expect(advanceCrossingState(window, page, 3)).toEqual({
      done: true,
      patch: {
        watermark_at: iso(NOW),
        pending_until: null,
        cursor_crossing_at: null,
        cursor_player_id: null,
      },
    });
    expect(advanceCrossingState(window, page, 2)).toEqual({
      done: false,
      patch: {
        pending_until: iso(NOW),
        cursor_crossing_at: iso(NOW - 40_000),
        cursor_player_id: "b",
      },
    });
  });
});

describe("runJourneyCrossing", () => {
  it("is off without the scanner kill switch, with its own off switch, and without scope", async () => {
    await expect(runJourneyCrossing()).resolves.toMatchObject({ disabled: true, journeys: 0 });
    process.env.JOURNEYS_SCANNER_ENABLED = "true";
    process.env.JOURNEYS_CROSSING_ENABLED = "false";
    process.env.JOURNEYS_CANARY_TENANT_IDS = TENANT;
    await expect(runJourneyCrossing()).resolves.toMatchObject({ disabled: true });
    delete process.env.JOURNEYS_CROSSING_ENABLED;
    delete process.env.JOURNEYS_CANARY_TENANT_IDS;
    await expect(runJourneyCrossing()).resolves.toMatchObject({
      disabled: true,
      reason: "canary_scope_required",
    });
    expect(monitor.startJobRun).not.toHaveBeenCalled();
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("initialises the watermark without backfilling players that already crossed", async () => {
    enableWorkers();
    fake.tables.journeys = [inactivityJourney()];
    fake.tables.players = [player("p-old", NOW - 72 * HOUR)];
    const result = await runJourneyCrossing({ now: NOW });
    expect(result).toMatchObject({ disabled: false, journeys: 1, selected: 0, enrolled: 0 });
    expect(fake.tables.journey_crossing_states).toHaveLength(1);
    expect(fake.tables.journey_crossing_states[0].watermark_at).toBe(iso(NOW - 5_000));
    expect(fake.tables.journey_enrollments ?? []).toHaveLength(0);
    expect(monitor.startJobRun).toHaveBeenCalledWith("journey_crossing", expect.anything());
    expect(monitor.finish).toHaveBeenCalled();
  });

  it("enrolls only players that crossed since the watermark and advances it", async () => {
    enableWorkers();
    fake.tables.journeys = [
      inactivityJourney(),
      inactivityJourney({ id: "44444444-4444-4444-8444-444444444444", tenant_id: OTHER_TENANT }),
    ];
    fake.tables.journey_crossing_states = [{ ...baseState({ watermark_at: iso(NOW - 65_000) }) }];
    fake.tables.players = [
      player("p-crossed", NOW - 48 * HOUR - 30_000), // crossed 30 s ago
      player("p-earlier", NOW - 48 * HOUR - 10 * 60_000), // crossed before the watermark
      player("p-future", NOW - 47 * HOUR), // crosses in an hour
      player("p-inactive", NOW - 48 * HOUR - 20_000, { status: "bloqueado" }),
    ];
    const result = await runJourneyCrossing({ now: NOW });
    expect(result).toMatchObject({ journeys: 1, selected: 2, eligible: 2, enrolled: 2 });
    const enrolled = fake.tables.journey_enrollments.map((row) => row.player_id).sort();
    expect(enrolled).toEqual(["p-crossed", "p-inactive"]); // audience system:all-leads
    const entry = fake.tables.journey_enrollments.find((row) => row.player_id === "p-crossed")!;
    expect(entry.entry_key).toBe(`inactivity:${iso(NOW - 48 * HOUR - 30_000)}`);
    expect(entry.metadata).toMatchObject({
      scanner: "crossing-v1",
      trigger: "inactivity",
      crossing_at: iso(NOW - 30_000),
    });
    const state = fake.tables.journey_crossing_states[0];
    expect(state).toMatchObject({
      watermark_at: iso(NOW - 5_000),
      pending_until: null,
      lease_owner: null,
      revision: 4,
    });
    const call = fake.rpcCalls.find((c) => c.name === "journey_crossing_candidates")!;
    expect(call.args).toMatchObject({
      p_tenant_id: TENANT,
      p_fields: ["ultimo_deposito"],
      p_hours: 48,
      p_from: iso(NOW - 65_000),
      p_to: iso(NOW - 5_000),
    });
  });

  it("pages through ties and resumes on the next run without losing anyone", async () => {
    enableWorkers();
    fake.tables.journeys = [inactivityJourney()];
    fake.tables.journey_crossing_states = [{ ...baseState({ watermark_at: iso(NOW - 120_000) }) }];
    const same = NOW - 48 * HOUR - 60_000;
    fake.tables.players = ["p-1", "p-2", "p-3", "p-4", "p-5"].map((id) => player(id, same));
    // Budget allows a single page per run.
    vi.setSystemTime(NOW);
    const first = await runJourneyCrossing({ now: NOW, batchSize: 2, timeBudgetMs: 5_000 });
    expect(first.enrolled).toBeGreaterThanOrEqual(2);
    let state = fake.tables.journey_crossing_states[0];
    // Runs until the window closes; each later run reuses pending_until.
    for (let i = 0; i < 5 && state.pending_until; i++) {
      await runJourneyCrossing({ now: NOW + 60_000, batchSize: 2 });
      state = fake.tables.journey_crossing_states[0];
    }
    expect(fake.tables.journey_enrollments.map((row) => row.player_id).sort()).toEqual([
      "p-1",
      "p-2",
      "p-3",
      "p-4",
      "p-5",
    ]);
    expect(state.pending_until).toBeNull();
    expect(state.cursor_player_id).toBeNull();
  });

  it("is idempotent with the scanner and event paths (same entry_key)", async () => {
    enableWorkers();
    const journey = inactivityJourney();
    fake.tables.journeys = [journey];
    fake.tables.journey_crossing_states = [{ ...baseState({ watermark_at: iso(NOW - 65_000) }) }];
    const p = player("p-crossed", NOW - 48 * HOUR - 30_000);
    fake.tables.players = [p];
    // The full scanner got there first.
    const scanner = await enrollPlayersInJourney(journey as never, [p as never], {
      source: "async-v1",
    });
    expect(scanner.enrolled).toBe(1);
    const result = await runJourneyCrossing({ now: NOW });
    expect(result).toMatchObject({ selected: 1, eligible: 1, enrolled: 0 });
    // And a re-run of the same window (e.g. overlapping cron) inserts nothing.
    const again = await enrollPlayersInJourney(journey as never, [p as never], {
      source: "event-v1",
    });
    expect(again).toMatchObject({ eligible: 1, enrolled: 0, duplicates: 1 });
    expect(fake.tables.journey_enrollments).toHaveLength(1);
  });

  it("respects the canary scope, journey status and leases held by another worker", async () => {
    enableWorkers();
    process.env.JOURNEYS_CANARY_JOURNEY_IDS = "55555555-5555-4555-8555-555555555555";
    fake.tables.journeys = [
      inactivityJourney(), // not in journey canary list
      inactivityJourney({ id: "55555555-5555-4555-8555-555555555555", status: "paused" }),
    ];
    const outOfScope = await runJourneyCrossing({ now: NOW });
    expect(outOfScope).toMatchObject({ journeys: 0 });
    expect(fake.rpcCalls).toHaveLength(0);

    delete process.env.JOURNEYS_CANARY_JOURNEY_IDS;
    fake.tables.journeys = [inactivityJourney()];
    fake.tables.journey_crossing_states = [
      { ...baseState({ lease_owner: "other", lease_expires_at: iso(NOW + 60_000) }) },
    ];
    const leased = await runJourneyCrossing({ now: NOW });
    expect(leased).toMatchObject({ journeys: 1, skipped: 1, selected: 0 });
  });

  it("restarts the open window when the journey version changes", async () => {
    enableWorkers();
    fake.tables.journeys = [inactivityJourney({ version: 2 })];
    fake.tables.journey_crossing_states = [
      {
        ...baseState({
          watermark_at: iso(NOW - 65_000),
          pending_until: iso(NOW - 10_000),
          cursor_crossing_at: iso(NOW - 20_000),
          cursor_player_id: "zzz",
        }),
      },
    ];
    fake.tables.players = [player("p-a", NOW - 48 * HOUR - 50_000)];
    const result = await runJourneyCrossing({ now: NOW });
    expect(result.enrolled).toBe(1);
    expect(fake.tables.journey_crossing_states[0]).toMatchObject({
      journey_version: 2,
      watermark_at: iso(NOW - 5_000),
    });
  });
});
