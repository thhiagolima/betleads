// ENV-01 / ENV-04 — runJourneyDispatcher against an in-memory fake of the
// supabase-js surface: slot exclusion, lease fencing, per-item rate limiting
// and provider-error accounting (defer/pause never consume an attempt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  const rpcs: Record<string, (args: Row) => unknown> = {};

  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private mode: "select" | "update" | "insert" | "upsert" = "select";
    private payload: Row | null = null;
    private returning = false;
    private countOnly = false;
    constructor(private table: string) {
      tables[table] ??= [];
    }
    select(_columns?: string, options?: { count?: string; head?: boolean }) {
      if (this.mode !== "select") this.returning = true;
      if (options?.head) this.countOnly = true;
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
    lte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    update(patch: Row) {
      this.mode = "update";
      this.payload = patch;
      return this;
    }
    insert(row: Row) {
      this.mode = "insert";
      this.payload = row;
      return this;
    }
    upsert(row: Row) {
      this.mode = "upsert";
      this.payload = row;
      return this;
    }
    maybeSingle() {
      return this.execute().then(({ data, error }) => ({
        data: Array.isArray(data) ? (data[0] ?? null) : data,
        error,
      }));
    }
    single() {
      return this.maybeSingle();
    }
    then<T>(resolve: (value: { data: unknown; error: null; count?: number }) => T) {
      return this.execute().then(resolve);
    }
    private async execute(): Promise<{ data: unknown; error: null; count?: number }> {
      const rows = tables[this.table];
      if (this.mode === "insert" || this.mode === "upsert") {
        // Like PostgREST, `.insert(...).select()` returns the stored row.
        const row: Row = this.returning
          ? { id: `${this.table}-${rows.length + 1}`, ...(this.payload as Row) }
          : { ...(this.payload as Row) };
        rows.push(row);
        return { data: this.returning ? [{ ...row }] : null, error: null };
      }
      const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.mode === "update") {
        for (const row of matched) Object.assign(row, this.payload);
        return { data: this.returning ? matched.map((r) => ({ ...r })) : null, error: null };
      }
      if (this.countOnly) return { data: null, error: null, count: matched.length };
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
  }

  return {
    tables,
    rpcCalls,
    rpcs,
    client: {
      from: (table: string) => new Query(table),
      rpc: async (name: string, args: Row = {}) => {
        rpcCalls.push({ name, args });
        const handler = rpcs[name];
        return { data: handler ? handler(args) : null, error: null };
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
    },
    reset() {
      for (const key of Object.keys(tables)) delete tables[key];
      rpcCalls.length = 0;
      for (const key of Object.keys(rpcs)) delete rpcs[key];
    },
  };
});

const monitor = vi.hoisted(() => {
  const finish = vi.fn(async (_result?: Record<string, unknown>) => undefined);
  return {
    finish,
    startJobRun: vi.fn(async () => ({
      job: "journey_dispatch",
      id: 1,
      progress: vi.fn(),
      finish,
      fail: vi.fn(async () => undefined),
    })),
  };
});

const sms = vi.hoisted(() => ({ sendSmsInternal: vi.fn() }));
const voice = vi.hoisted(() => ({ callInfobipVoice: vi.fn() }));
const sentry = vi.hoisted(() => ({
  captureServerException: vi.fn(),
  captureServerMessage: vi.fn(),
}));
const alerts = vi.hoisted(() => ({ notifyNoBalance: vi.fn(async () => false) }));
const heartbeat = vi.hoisted(() => ({ pingHeartbeat: vi.fn(async () => undefined) }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fake.client }));
vi.mock("./observability/job-monitor.server", () => ({
  startJobRun: monitor.startJobRun,
  pingHeartbeat: heartbeat.pingHeartbeat,
}));
vi.mock("./observability/sentry.server", () => ({
  captureServerException: sentry.captureServerException,
  captureServerMessage: sentry.captureServerMessage,
}));
vi.mock("./sms.functions", () => ({ sendSmsInternal: sms.sendSmsInternal }));
vi.mock("./billing/wallet-alerts.server", () => ({ notifyNoBalance: alerts.notifyNoBalance }));
const email = vi.hoisted(() => ({ sendInfobipEmail: vi.fn(), resolveSender: vi.fn() }));
vi.mock("./email-send.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-send.server")>()),
  sendInfobipEmail: email.sendInfobipEmail,
  resolveSender: email.resolveSender,
}));
vi.mock("./infobip-voice.server", () => ({
  callInfobipVoice: voice.callInfobipVoice,
  normalizeE164BR: (v: string) => v,
}));
vi.mock("./consent.server", () => ({
  isChannelRevoked: vi.fn(async () => false),
  evaluateVoiceContactPolicy: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("./triggers.server", () => ({ detectTriggersForPlayer: () => [] }));
vi.mock("./template-vars.server", () => ({
  buildPlayerVariables: () => ({}),
  renderTemplate: (template: string) => template,
}));

import { runJourneyDispatcher } from "./journeys.server";
import { MAX_NO_COST_DEFERS } from "./rate-limit/provider-errors.server";
import { __resetSmsBreakerCacheForTests } from "./sms-provider-breaker.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const JOURNEY = "33333333-3333-4333-8333-333333333333";
const PLAYER = "44444444-4444-4444-8444-444444444444";

function seed(enrollmentIds: string[]) {
  fake.tables.journeys = [
    {
      id: JOURNEY,
      tenant_id: TENANT,
      status: "active",
      trigger_type: "manual",
      trigger_config: {},
      exit_rules: {},
      entry_rules: {},
      daily_limit: 100,
      cooldown_hours: 0,
    },
  ];
  fake.tables.journey_steps = [
    {
      id: "step-0",
      journey_id: JOURNEY,
      position: 0,
      step_type: "sms",
      is_enabled: true,
      config: { content: "oi" },
    },
  ];
  fake.tables.players = [{ id: PLAYER, tenant_id: TENANT, telefone: "+5511999999999" }];
  fake.tables.journey_enrollments = enrollmentIds.map((id) => ({
    id,
    tenant_id: TENANT,
    journey_id: JOURNEY,
    player_id: PLAYER,
    status: "active",
    current_position: 0,
    entered_at: new Date(0).toISOString(),
    attempts: 1,
    loop_iteration: 0,
    claimed_at: null,
    claimed_by: null,
  }));
  fake.tables.journey_step_executions = [];
  fake.tables.journey_events = [];
  fake.tables.dispatch_pause_state = [];

  fake.rpcs.acquire_journey_dispatcher_slot = () => 0;
  seedClaimAgain();
  fake.rpcs.consume_channel_budget = () => [{ granted: 1, retry_after_ms: 0, limited_by: null }];
  let execution = 0;
  fake.rpcs.reserve_journey_delivery_v2 = (args) => {
    execution++;
    fake.tables.journey_step_executions.push({
      id: `exec-${execution}`,
      enrollment_id: args.p_enrollment_id,
      status: "claimed",
    });
    return [
      {
        execution_id: `exec-${execution}`,
        idempotency_key: `key-${execution}`,
        retry_at: null,
        blocked_reason: null,
      },
    ];
  };
}

/** The next run claims every enrollment once (without step_type, like the old RPC). */
function seedClaimAgain() {
  let claimed = false;
  fake.rpcs.claim_journey_enrollments_leased = (args) => {
    if (claimed) return [];
    claimed = true;
    const rows = fake.tables.journey_enrollments.slice(0, Number(args.p_limit));
    for (const row of rows) {
      row.claimed_at = new Date().toISOString();
      row.claimed_by = args.p_worker_id;
    }
    return rows.map((row) => ({ id: row.id, tenant_id: row.tenant_id }));
  };
}

const enrollment = (id: string) => fake.tables.journey_enrollments.find((row) => row.id === id)!;
const rpcNames = () => fake.rpcCalls.map((call) => call.name);

beforeEach(() => {
  fake.reset();
  __resetSmsBreakerCacheForTests();
  sentry.captureServerException.mockClear();
  monitor.finish.mockClear();
  sms.sendSmsInternal.mockReset();
  voice.callInfobipVoice.mockReset();
  alerts.notifyNoBalance.mockReset();
  alerts.notifyNoBalance.mockResolvedValue(false);
  vi.stubEnv("JOURNEYS_DISPATCH_ENABLED", "true");
  vi.stubEnv("JOURNEYS_ALLOW_ALL_TENANTS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runJourneyDispatcher", () => {
  it("exits fast with stop_reason busy when every worker slot is held", async () => {
    seed(["e1"]);
    fake.rpcs.acquire_journey_dispatcher_slot = () => null;
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ busy: true, claimed: 0 });
    expect(monitor.finish).toHaveBeenCalledWith({ stop_reason: "busy" });
    expect(rpcNames()).toEqual(["acquire_journey_dispatcher_slot"]);
  });

  it("sends, advances the item, clears the lease and releases the slot", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({ ok: true, status: 200, response: "{}" });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({
      claimed: 1,
      processed: 1,
      failed: 0,
      stopReason: "queue_empty",
    });
    expect(enrollment("e1")).toMatchObject({
      current_position: 1,
      attempts: 0,
      claimed_by: null,
      claimed_at: null,
      lease_expires_at: null,
    });
    const claim = fake.rpcCalls.find((c) => c.name === "claim_journey_enrollments_leased")!;
    expect(String(claim.args.p_worker_id)).toMatch(/^journey-dispatcher:/);
    expect(claim.args.p_lease_seconds).toBe(120);
    expect(rpcNames()).toContain("consume_channel_budget");
    const release = fake.rpcCalls.find((c) => c.name === "release_journey_dispatcher_slot")!;
    expect(release.args).toEqual({ p_slot: 0, p_holder: claim.args.p_worker_id });
  });

  it("provider 5xx/timeout defers the item without consuming an attempt", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 503,
      error: "HTTP 503",
      temporary: true,
      body: "{}",
    });
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ processed: 0, failed: 0, rescheduled: 1 });
    const row = enrollment("e1");
    expect(row).toMatchObject({ status: "waiting", attempts: 1, claimed_by: null });
    expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(before + 59_000);
    expect(fake.tables.journey_step_executions[0].status).toBe("retrying");
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ reason: "provider_unavailable", attempt_consumed: false }),
    });
    expect(fake.tables.dispatch_pause_state).toHaveLength(0);
  });

  it("402 (no credit, no errorKind) defers 15 min without pausing the channel or consuming an attempt — provider-level, unchanged by PG3 Task 1 (I4)", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({ ok: false, status: 402, error: "Saldo insuficiente" });
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, rescheduled: 1 });
    const row = enrollment("e1");
    expect(row).toMatchObject({ status: "waiting", attempts: 1 });
    expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(
      before + 15 * 60_000 - 1_000,
    );
    expect(fake.tables.dispatch_pause_state).toHaveLength(0);
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ reason: "insufficient_credit", attempt_consumed: false }),
    });
  });

  it("house wallet refusal (errorKind insufficient_balance): the step waits on the same position for 15 min, no attempt consumed, the house is alerted", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 402,
      error: "Saldo insuficiente",
      errorKind: "insufficient_balance",
    });
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, rescheduled: 0, deferredNoBalance: 1 });
    const row = enrollment("e1");
    // Same step, later: never skipped to the next one.
    expect(row).toMatchObject({
      status: "waiting",
      current_position: 0,
      attempts: 1,
      claimed_by: null,
    });
    expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(
      before + 15 * 60_000 - 1_000,
    );
    expect(fake.tables.journey_step_executions[0]).toMatchObject({
      status: "retrying",
      provider: "wallet",
    });
    expect(fake.tables.dispatch_pause_state).toHaveLength(0);
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({
        channel: "sms",
        step_position: 0,
        reason: "saldo_insuficiente",
        attempt_consumed: false,
      }),
    });
    expect(alerts.notifyNoBalance).toHaveBeenCalledWith(TENANT);
  });

  it("after a recharge the held step is sent (it was not lost)", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 402,
      error: "Saldo insuficiente",
      errorKind: "insufficient_balance",
    });
    await runJourneyDispatcher(1000);
    seedClaimAgain();
    sms.sendSmsInternal.mockReset();
    sms.sendSmsInternal.mockResolvedValue({ ok: true, status: 200, response: "{}" });
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    // Step 0 sent on this run: the enrollment moves past it.
    expect(enrollment("e1")).toMatchObject({ current_position: 1, attempts: 0 });
  });

  it("one wallet refusal holds the house's other items in the same run without calling the wallet again", async () => {
    // One item at a time, so the refusal is seen before the next item starts.
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "1");
    seed(["e1", "e2"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 402,
      error: "Saldo insuficiente",
      errorKind: "insufficient_balance",
    });
    const result = await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ claimed: 2, failed: 0, deferredNoBalance: 2 });
    for (const id of ["e1", "e2"]) {
      expect(enrollment(id)).toMatchObject({ status: "waiting", current_position: 0, attempts: 1 });
    }
    // Only the refused item reserved an execution.
    expect(fake.tables.journey_step_executions).toHaveLength(1);
    expect(alerts.notifyNoBalance).toHaveBeenCalledTimes(1);
  });

  it("an alert failure never breaks the hold", async () => {
    seed(["e1"]);
    alerts.notifyNoBalance.mockRejectedValueOnce(new Error("alert down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 402,
      error: "Saldo insuficiente",
      errorKind: "insufficient_balance",
    });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, deferredNoBalance: 1 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", current_position: 0, attempts: 1 });
  });

  it("caps consecutive no-cost defers: the 11th 429 in a row consumes an attempt", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 429,
      error: "HTTP 429",
      temporary: true,
    });
    enrollment("e1").metadata = {
      trigger: "manual",
      provider_deferrals: { step_position: 0, loop_iteration: 0, count: MAX_NO_COST_DEFERS },
    };
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, rescheduled: 0 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", attempts: 2 });
    expect(fake.tables.journey_step_executions[0].status).toBe("failed");
    expect(fake.tables.journey_events.at(-1)).toMatchObject({ event_type: "retry_scheduled" });
  });

  it("counts no-cost defers per step and keeps the rest of the metadata", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 503,
      error: "HTTP 503",
      temporary: true,
    });
    enrollment("e1").metadata = {
      trigger: "manual",
      // count from an older step: resets for the current one
      provider_deferrals: { step_position: 7, loop_iteration: 0, count: 9 },
    };
    await runJourneyDispatcher(1000);
    expect(enrollment("e1")).toMatchObject({
      attempts: 1,
      metadata: {
        trigger: "manual",
        provider_deferrals: { step_position: 0, loop_iteration: 0, count: 1 },
      },
    });
  });

  it("timeout after sending: execution stays claimed (in_flight), attempt consumed, no resend for 15 min (B1)", async () => {
    seed(["e1"]);
    // Same rule as reserve_journey_delivery (20261015111000): a `claimed`
    // execution of this step younger than 15 min answers `in_flight`.
    let execution = 0;
    fake.rpcs.reserve_journey_delivery_v2 = (args) => {
      const live = fake.tables.journey_step_executions.find(
        (e) => e.enrollment_id === args.p_enrollment_id && e.status === "claimed",
      );
      if (live)
        return [
          {
            execution_id: null,
            idempotency_key: null,
            retry_at: new Date(Date.now() + 120_000).toISOString(),
            blocked_reason: "in_flight",
          },
        ];
      execution++;
      fake.tables.journey_step_executions.push({
        id: `exec-${execution}`,
        enrollment_id: args.p_enrollment_id,
        status: "claimed",
      });
      return [
        {
          execution_id: `exec-${execution}`,
          idempotency_key: "key-1",
          retry_at: null,
          blocked_reason: null,
        },
      ];
    };
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 0,
      error: "Short Brasil não respondeu em 8s",
      temporary: true,
      errorKind: "outcome_unknown",
      body: "{}",
    });
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ processed: 0, failed: 0, rescheduled: 1, outcomeUnknown: 1 });
    const row = enrollment("e1");
    expect(row).toMatchObject({ status: "waiting", attempts: 2, claimed_by: null });
    expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(
      before + 15 * 60_000 - 1_000,
    );
    expect(fake.tables.journey_step_executions).toEqual([
      expect.objectContaining({
        id: "exec-1",
        status: "claimed",
        error: expect.stringContaining("outcome_unknown"),
      }),
    ]);
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_outcome_unknown",
      detail: expect.objectContaining({ attempt_consumed: true, attempts: 2 }),
    });

    // Even if the item becomes due early (e.g. manual requeue), the claimed
    // execution makes the reservation answer in_flight: nothing is resent.
    row.next_run_at = new Date().toISOString();
    seedClaimAgain();
    sms.sendSmsInternal.mockClear();
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(fake.tables.journey_step_executions).toHaveLength(1);
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ reason: "in_flight" }),
    });
  });

  it("outcome unknown on the last attempt fails the enrollment (never infinite)", async () => {
    seed(["e1"]);
    enrollment("e1").attempts = 2; // max_attempts defaults to 3
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 0,
      error: "socket hang up",
      errorKind: "outcome_unknown",
    });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, outcomeUnknown: 1 });
    expect(enrollment("e1")).toMatchObject({ status: "failed", attempts: 3 });
    expect(fake.tables.journey_step_executions[0].status).toBe("failed");
  });

  it("missing provider credentials hold the item as a platform failure (no attempt consumed) and are reported", async () => {
    seed(["e1"]);
    sentry.captureServerException.mockClear();
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 0,
      error: "SHORTCODE_SMS_TOKEN nao configurado",
      temporary: true,
      errorKind: "misconfigured",
    });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, rescheduled: 0, outcomeUnknown: 0, platformHeld: 1 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", attempts: 1, current_position: 0 });
    expect(fake.tables.journey_step_executions[0].status).toBe("retrying");
    expect(sentry.captureServerException).toHaveBeenCalledTimes(1);
  });

  it("admits the budget BEFORE the pre-checks and does not count denied items toward the batch (I2)", async () => {
    seed(["e1", "e2", "e3"]);
    const claims: Row[] = [];
    let served = false;
    fake.rpcs.claim_journey_enrollments_leased = (args) => {
      claims.push(args);
      if (served) return [];
      served = true;
      return fake.tables.journey_enrollments.map((row) => {
        row.claimed_at = new Date().toISOString();
        row.claimed_by = args.p_worker_id;
        return { id: row.id, tenant_id: row.tenant_id, step_type: "sms" };
      });
    };
    // retry > acquire's 2 s max wait: denied at once, (tenant, sms) excluded for 2.5 s.
    fake.rpcs.consume_channel_budget = () => [
      { granted: 0, retry_after_ms: 2_500, limited_by: "tenant" },
    ];
    vi.stubEnv("JOURNEYS_DISPATCH_BATCH_SIZE", "3");
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "1");
    const fromSpy = vi.spyOn(fake.client, "from");
    const result = await runJourneyDispatcher(1000);
    // No pre-check read (journeys, players, steps, enrollment row) for denied items.
    const tablesRead = new Set(fromSpy.mock.calls.map((c) => c[0]));
    fromSpy.mockRestore();
    expect(tablesRead.has("journeys")).toBe(false);
    expect(tablesRead.has("players")).toBe(false);
    expect(result).toMatchObject({ rateLimited: 3, processed: 0, failed: 0 });
    // Only one budget call: the other two hit the exhausted (tenant, sms) cache.
    expect(rpcNames().filter((n) => n === "consume_channel_budget")).toHaveLength(1);
    // Denied items were given back: the run claimed again, excluding the pair.
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims[1].p_exclude).toEqual([`${TENANT}:sms`]);
    for (const id of ["e1", "e2", "e3"]) {
      expect(enrollment(id)).toMatchObject({ attempts: 1, claimed_by: null, current_position: 0 });
    }
  }, 10_000);

  it("voice: stores the concurrency permit on call_history so the end-of-call callback frees it (I3)", async () => {
    seed(["e1"]);
    fake.tables.journey_steps = [
      {
        id: "step-0",
        journey_id: JOURNEY,
        position: 0,
        step_type: "voice",
        is_enabled: true,
        config: { asset_id: "a1" },
      },
    ];
    fake.tables.journey_voice_assets = [{ id: "a1", tenant_id: TENANT, storage_path: "x.mp3" }];
    fake.rpcs.acquire_channel_slot = () => [
      { permit_id: "permit-9", retry_after_ms: 0, limited_by: null },
    ];
    const signed = vi.spyOn(fake.client.storage, "from").mockReturnValue({
      createSignedUrl: async () => ({ data: { signedUrl: "https://a/x.mp3" }, error: null }),
    } as never);
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
    });
    const result = await runJourneyDispatcher(1000);
    signed.mockRestore();
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(fake.tables.call_history).toEqual([
      expect.objectContaining({
        provider_response: expect.objectContaining({
          correlation_id: "key-1",
          channel_permit_id: "permit-9",
        }),
      }),
    ]);
    // The permit is kept for the ongoing call (not released by the worker).
    expect(rpcNames()).not.toContain("release_channel_slot");
  });

  it("voice: caps the reservation by the asset's duration_seconds and stores billing_reference_id (PG3 Task 4)", async () => {
    seed(["e1"]);
    fake.tables.journey_steps = [
      {
        id: "step-0",
        journey_id: JOURNEY,
        position: 0,
        step_type: "voice",
        is_enabled: true,
        config: { asset_id: "a1" },
      },
    ];
    fake.tables.journey_voice_assets = [
      { id: "a1", tenant_id: TENANT, storage_path: "x.mp3", duration_seconds: 37 },
    ];
    const signed = vi.spyOn(fake.client.storage, "from").mockReturnValue({
      createSignedUrl: async () => ({ data: { signedUrl: "https://a/x.mp3" }, error: null }),
    } as never);
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 2 },
    });
    const result = await runJourneyDispatcher(1000);
    signed.mockRestore();
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(voice.callInfobipVoice).toHaveBeenCalledWith(
      expect.any(String),
      { type: "audio", audioUrl: "https://a/x.mp3" },
      expect.objectContaining({ tenantId: TENANT, maxSeconds: 37 }),
    );
    expect(fake.tables.call_history).toEqual([
      expect.objectContaining({ billing_reference_id: "voice:key-1", tenant_id: TENANT }),
    ]);
  });

  it("voice: a failed call_history insert is logged with reference and correlation; the step still counts as sent (PG3 Task 5)", async () => {
    seed(["e1"]);
    fake.tables.journey_steps = [
      {
        id: "step-0",
        journey_id: JOURNEY,
        position: 0,
        step_type: "voice",
        is_enabled: true,
        config: { asset_id: "a1" },
      },
    ];
    fake.tables.journey_voice_assets = [{ id: "a1", tenant_id: TENANT, storage_path: "x.mp3" }];
    const signed = vi.spyOn(fake.client.storage, "from").mockReturnValue({
      createSignedUrl: async () => ({ data: { signedUrl: "https://a/x.mp3" }, error: null }),
    } as never);
    const originalFrom = fake.client.from;
    const from = vi.spyOn(fake.client, "from").mockImplementation(((table: string) =>
      table === "call_history"
        ? { insert: async () => ({ error: { message: "insert failed" } }) }
        : originalFrom(table)) as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 2 },
    });
    const result = await runJourneyDispatcher(1000);
    signed.mockRestore();
    from.mockRestore();
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("call_history"),
      expect.objectContaining({ referenceId: "voice:key-1", correlationId: "key-1" }),
    );
    consoleError.mockRestore();
  });

  it("voice: passes the wallet refusal through as errorKind insufficient_balance (PG3 Task 4)", async () => {
    seed(["e1"]);
    fake.tables.journey_steps = [
      {
        id: "step-0",
        journey_id: JOURNEY,
        position: 0,
        step_type: "voice",
        is_enabled: true,
        config: { asset_id: "a1" },
      },
    ];
    fake.tables.journey_voice_assets = [{ id: "a1", tenant_id: TENANT, storage_path: "x.mp3" }];
    const signed = vi.spyOn(fake.client.storage, "from").mockReturnValue({
      createSignedUrl: async () => ({ data: { signedUrl: "https://a/x.mp3" }, error: null }),
    } as never);
    voice.callInfobipVoice.mockResolvedValue({
      ok: false,
      status: 0,
      body: { error: "Saldo insuficiente" },
      idempotencyKey: "key-1",
      providerCallId: null,
      errorKind: "insufficient_balance",
    });
    const result = await runJourneyDispatcher(1000);
    signed.mockRestore();
    // Same hold-on-the-same-step as SMS and e-mail.
    expect(result).toMatchObject({ failed: 0, outcomeUnknown: 0, rescheduled: 0 });
    expect(result).toMatchObject({ deferredNoBalance: 1 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", current_position: 0, attempts: 1 });
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ channel: "voice", reason: "saldo_insuficiente" }),
    });
    expect(fake.tables.call_history ?? []).toEqual([]);
    expect(alerts.notifyNoBalance).toHaveBeenCalledWith(TENANT);
  });

  it("permanent provider errors still consume attempts", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockResolvedValue({ ok: false, status: 400, error: "numero invalido" });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, rescheduled: 0 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", attempts: 2 });
    expect(fake.tables.journey_step_executions[0].status).toBe("failed");
  });

  it("platform failure before sending (no Short.io domain): held on the same step for 30 min, no attempt consumed, reported once per house", async () => {
    // One item at a time: the second item sees the first report.
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "1");
    seed(["e1", "e2"]);
    sms.sendSmsInternal.mockRejectedValue(
      new Error("SHORTIO_DOMAIN não configurado para este tenant"),
    );
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, platformHeld: 2 });
    for (const id of ["e1", "e2"]) {
      const row = enrollment(id);
      expect(row).toMatchObject({ status: "waiting", current_position: 0, attempts: 1 });
      expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(
        before + 30 * 60_000 - 1_000,
      );
      expect(row.metadata).toMatchObject({ platform_holds: { step_position: 0, count: 1 } });
    }
    expect(fake.tables.journey_step_executions[0].status).toBe("retrying");
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({
        reason: "platform_error",
        platform_reason: "shortio_not_configured",
        attempt_consumed: false,
      }),
    });
    expect(sentry.captureServerException).toHaveBeenCalledTimes(1);
  });

  it("platform holds are capped: past the cap the normal attempts policy applies", async () => {
    seed(["e1"]);
    fake.tables.journey_enrollments[0].metadata = {
      platform_holds: { step_position: 0, loop_iteration: 0, count: 144 },
    };
    sms.sendSmsInternal.mockRejectedValue(new Error("Falha ao criar link Short.io: HTTP 503"));
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, platformHeld: 0 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", attempts: 2 });
  });

  it("an error that may be the player's keeps the normal attempts policy", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockRejectedValue(new Error("Jogador da jornada não encontrado"));
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, platformHeld: 0 });
    expect(enrollment("e1")).toMatchObject({ status: "waiting", attempts: 2 });
  });

  it("a house locked for the monthly fee: the item fails final, no retry scheduled", async () => {
    seed(["e1"]);
    // sendSmsInternal's result when the send guard refuses a locked house.
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 0,
      error: "Acesso suspenso. Regularize a mensalidade em Plano e créditos.",
      temporary: false,
    });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 1, rescheduled: 0, outcomeUnknown: 0 });
    expect(enrollment("e1")).toMatchObject({ status: "failed" });
    expect(fake.tables.journey_step_executions[0].status).toBe("failed");
    expect(fake.tables.journey_events.at(-1)).toMatchObject({ event_type: "failed" });
  });

  it("a denied rate-limit admission defers without reserving or sending", async () => {
    seed(["e1"]);
    fake.rpcs.consume_channel_budget = () => [
      { granted: 0, retry_after_ms: 30_000, limited_by: "global" },
    ];
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ rateLimited: 1, failed: 0 });
    expect(rpcNames()).not.toContain("reserve_journey_delivery_v2");
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(enrollment("e1")).toMatchObject({ attempts: 1, claimed_by: null });
  });

  it("does not overwrite an item whose lease was taken over (fenced release)", async () => {
    seed(["e1"]);
    sms.sendSmsInternal.mockImplementation(async () => {
      // Lease expired while sending and another worker reclaimed the item.
      enrollment("e1").claimed_by = "journey-dispatcher:other";
      return { ok: true, status: 200, response: "{}" };
    });
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ leaseLost: 1 });
    expect(enrollment("e1")).toMatchObject({
      current_position: 0,
      claimed_by: "journey-dispatcher:other",
    });
  });
});

describe("runJourneyDispatcher per-player rules (journey P0)", () => {
  it("past the per-player daily cap the occurrence exits without a message (D-8)", async () => {
    seed(["e1"]);
    fake.rpcs.reserve_journey_delivery_v2 = () => [
      {
        execution_id: null,
        idempotency_key: null,
        retry_at: null,
        blocked_reason: "journey_player_daily_cap",
      },
    ];
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(enrollment("e1")).toMatchObject({
      status: "exited",
      exit_reason: "journey_player_daily_cap",
    });
    expect(fake.tables.journey_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "exited",
          detail: expect.objectContaining({ reason: "journey_player_daily_cap" }),
        }),
      ]),
    );
  });

  it("the minimum interval defers to the returned time instead of exiting (D-8)", async () => {
    seed(["e1"]);
    const retryAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fake.rpcs.reserve_journey_delivery_v2 = () => [
      {
        execution_id: null,
        idempotency_key: null,
        retry_at: retryAt,
        blocked_reason: "journey_player_min_interval",
      },
    ];
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(enrollment("e1")).toMatchObject({ status: "waiting", next_run_at: retryAt });
  });

  it("sends one of the step variations, the same one for the same occurrence (D-8)", async () => {
    const variants = ["msg A {{nome}}", "msg B", "msg C", "msg D"];
    const sentFor = async (entryKey: string) => {
      sms.sendSmsInternal.mockReset();
      sms.sendSmsInternal.mockResolvedValue({ ok: true, status: 200, response: "{}" });
      seed(["e1"]);
      fake.tables.journey_steps[0].config = { content: variants[0], variants };
      fake.tables.journey_enrollments[0].entry_key = entryKey;
      await runJourneyDispatcher(1000);
      expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
      return String(vi.mocked(sms.sendSmsInternal).mock.calls[0][0].content);
    };
    const first = await sentFor("saque_pago:w-1");
    expect(variants.some((variant) => first.startsWith(variant.split(" {{")[0]))).toBe(true);
    expect(await sentFor("saque_pago:w-1")).toBe(first);
    const execution = fake.tables.journey_step_executions.find((row) => row.status === "sent");
    const response = execution?.provider_response as { variant_index?: number } | undefined;
    expect(response?.variant_index).toBeGreaterThanOrEqual(0);
  });

  it("a control-group player skips the send step without sending or reserving (F3)", async () => {
    seed(["e1"]);
    fake.tables.journey_enrollments[0].is_holdout = true;
    sms.sendSmsInternal.mockResolvedValue({ ok: true, status: 200, response: "{}" });
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("reserve_journey_delivery_v2");
    expect(enrollment("e1")).toMatchObject({ current_position: 1, status: "active" });
    expect(fake.tables.journey_step_executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "skipped", provider: "holdout" })]),
    );
  });

  it("runs the exit sweep on every dispatch (S-01, S-02)", async () => {
    seed([]);
    await runJourneyDispatcher(1000);
    expect(rpcNames()).toContain("sweep_journey_exits");
  });
});

describe("runJourneyDispatcher with the SMS provider breaker (incident 15/10/2026)", () => {
  const SHORT_BRASIL_101 = {
    ok: false,
    status: 200,
    error: "Short Brasil: erro de autenticacao",
    temporary: true,
    body: JSON.stringify({ status: 101, statusDetalhe: "Erro de Autenticação" }),
    errorKind: "provider_account",
  };

  /** Breaker row + acquire RPC as the migration would answer them. */
  function breaker(state: "open" | "half_open", decision: "open" | "probe") {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    fake.tables.provider_circuit_breakers = [
      {
        channel: "sms",
        state,
        reason: "auth",
        first_opened_at: new Date().toISOString(),
        backoff_until: retryAt,
      },
    ];
    fake.rpcs.provider_breaker_acquire = () => [
      {
        decision,
        state: decision === "probe" ? "half_open" : "open",
        reason: "auth",
        retry_at: retryAt,
        alert_due: false,
      },
    ];
    fake.tables.tenants = [{ id: TENANT }];
  }

  /** Claim that honours p_exclude like the SQL does (`tenant:step_type`). */
  function claimWithExclusion(stepType = "sms") {
    const claims: Row[] = [];
    fake.rpcs.claim_journey_enrollments_leased = (args) => {
      claims.push(args);
      const exclude = (args.p_exclude as string[] | null) ?? [];
      return (
        fake.tables.journey_enrollments
          // Only items still at the SMS step (position 0) are due for this fake.
          .filter(
            (row) =>
              row.claimed_by == null && row.status !== "failed" && row.current_position === 0,
          )
          .filter((row) => !exclude.includes(`${row.tenant_id}:${stepType}`))
          .filter((row) => !row.next_run_at || Date.parse(String(row.next_run_at)) <= Date.now())
          .slice(0, Number(args.p_limit))
          .map((row) => {
            row.claimed_at = new Date().toISOString();
            row.claimed_by = args.p_worker_id;
            return { id: row.id, tenant_id: row.tenant_id, step_type: stepType };
          })
      );
    };
    return claims;
  }

  it("101 (route without balance) defers WITHOUT consuming an attempt and never fails the item", async () => {
    seed(["e1"]);
    // Even at the no-cost defer cap: an account error never costs an attempt.
    enrollment("e1").metadata = {
      provider_deferrals: { step_position: 0, loop_iteration: 0, count: MAX_NO_COST_DEFERS },
    };
    sms.sendSmsInternal.mockResolvedValue(SHORT_BRASIL_101);
    const before = Date.now();
    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ failed: 0, processed: 0, providerSuspended: 1 });
    const row = enrollment("e1");
    expect(row).toMatchObject({
      status: "waiting",
      attempts: 1,
      current_position: 0,
      claimed_by: null,
    });
    expect(Date.parse(String(row.next_run_at))).toBeGreaterThanOrEqual(before + 30_000);
    expect(fake.tables.journey_step_executions[0].status).toBe("retrying");
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ reason: "provider_account", attempt_consumed: false }),
    });
    expect(sentry.captureServerException).not.toHaveBeenCalled();
  });

  it("after the first 101 the rest of the run stops claiming SMS (no burst of failures)", async () => {
    seed(["e1", "e2", "e3"]);
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "1");
    fake.tables.tenants = [{ id: TENANT }];
    const claims = claimWithExclusion();
    sms.sendSmsInternal.mockResolvedValue(SHORT_BRASIL_101);
    const result = await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: 0, stopReason: "provider_unavailable" });
    expect(claims.at(-1)?.p_exclude).toEqual([`${TENANT}:sms`]);
    for (const id of ["e1", "e2", "e3"]) {
      expect(enrollment(id)).toMatchObject({ attempts: 1, current_position: 0, claimed_by: null });
      expect(enrollment(id).status).not.toBe("failed");
    }
  });

  it("breaker open: the claim excludes (tenant, sms) and nothing is sent or touched", async () => {
    seed(["e1", "e2"]);
    breaker("open", "open");
    const claims = claimWithExclusion();
    const result = await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(claims[0].p_exclude).toEqual([`${TENANT}:sms`]);
    expect(result).toMatchObject({
      claimed: 0,
      failed: 0,
      stopReason: "provider_unavailable",
      smsBreaker: "open",
    });
    for (const id of ["e1", "e2"]) {
      expect(enrollment(id)).toMatchObject({ status: "active", attempts: 1, claimed_by: null });
    }
    expect(fake.tables.journey_step_executions).toHaveLength(0);
  });

  it("half-open: one probe item is sent; on another refusal the others stay untouched", async () => {
    seed(["e1", "e2", "e3"]);
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "3");
    breaker("half_open", "probe");
    claimWithExclusion();
    sms.sendSmsInternal.mockImplementation(async () => {
      // The probe was refused again: the breaker re-opens (as the RPC would).
      fake.tables.provider_circuit_breakers[0].state = "open";
      return SHORT_BRASIL_101;
    });
    const result = await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: 0, stopReason: "provider_unavailable" });
    for (const id of ["e1", "e2", "e3"]) {
      expect(enrollment(id)).toMatchObject({ attempts: 1, current_position: 0, claimed_by: null });
      expect(enrollment(id).status).not.toBe("failed");
    }
    const acquire = fake.rpcCalls.find((c) => c.name === "provider_breaker_acquire")!;
    expect(String(acquire.args.p_holder)).toMatch(/^journey-dispatcher:/);
  });

  it("half-open probe accepted closes the breaker and the run resumes SMS", async () => {
    seed(["e1", "e2"]);
    vi.stubEnv("JOURNEYS_DISPATCH_CONCURRENCY", "1");
    breaker("half_open", "probe");
    claimWithExclusion();
    sms.sendSmsInternal.mockImplementation(async () => {
      // sendSmsInternal -> noteSmsProviderSuccess -> provider_breaker_report_success
      fake.tables.provider_circuit_breakers[0].state = "closed";
      return { ok: true, status: 200, response: "{}" };
    });
    const result = await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processed: 2, failed: 0, smsBreaker: "closed" });
    expect(enrollment("e1")).toMatchObject({ current_position: 1, attempts: 0 });
    expect(enrollment("e2")).toMatchObject({ current_position: 1, attempts: 0 });
  });
});

describe("runJourneyDispatcher email step", () => {
  it("email step without a verified sender: EmailDomainNotVerifiedError, nothing sent or logged", async () => {
    seed(["e1"]);
    const SENDER = "55555555-5555-4555-8555-555555555555";
    fake.tables.journey_steps[0] = {
      id: "step-0",
      journey_id: JOURNEY,
      position: 0,
      step_type: "email",
      is_enabled: true,
      config: {
        template_id: "tpl-1",
        sender_id: SENDER,
        template_snapshot: { subject: "Oi", body_html: "<p>oi</p>" },
      },
    };
    fake.tables.players = [{ id: PLAYER, tenant_id: TENANT, email: "jogador@x.com" }];
    fake.tables.email_send_logs = [];
    email.resolveSender.mockReset();
    email.sendInfobipEmail.mockReset();
    email.resolveSender.mockResolvedValue(null);

    const result = await runJourneyDispatcher(1000);
    expect(email.resolveSender).toHaveBeenCalledWith({ tenantId: TENANT, senderId: SENDER });
    expect(email.sendInfobipEmail).not.toHaveBeenCalled();
    expect(fake.tables.email_send_logs).toHaveLength(0);
    expect(result).toMatchObject({ processed: 0, failed: 1 });
    const execution = fake.tables.journey_step_executions[0];
    expect(execution.status).not.toBe("sent");
    expect(execution).toMatchObject({
      status: "failed",
      error: "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
    });
  });

  it("email step: logs the wallet reference and the amount charged (PG3 Task 6)", async () => {
    seed(["e1"]);
    fake.tables.journey_steps[0] = {
      id: "step-0",
      journey_id: JOURNEY,
      position: 0,
      step_type: "email",
      is_enabled: true,
      config: {
        template_id: "tpl-1",
        template_snapshot: { subject: "Oi", body_html: "<p>oi</p>" },
      },
    };
    fake.tables.players = [{ id: PLAYER, tenant_id: TENANT, email: "jogador@x.com" }];
    fake.tables.email_send_logs = [];
    email.resolveSender.mockReset();
    email.sendInfobipEmail.mockReset();
    email.resolveSender.mockResolvedValue({
      fromEmail: "a@casa.bet",
      fromName: "Casa",
      replyTo: null,
      senderId: "s-1",
    });
    email.sendInfobipEmail.mockResolvedValue({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "key-1",
      temporary: false,
      billing: { referenceId: "email:key-1", amount: 0 },
    });

    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(fake.tables.email_send_logs).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        status: "sent",
        billing_reference_id: "email:key-1",
        billed_amount: 0,
      }),
    ]);
  });
  it("email step without balance: held on the same step (saldo_insuficiente), no log row", async () => {
    seed(["e1"]);
    fake.tables.journey_steps[0] = {
      id: "step-0",
      journey_id: JOURNEY,
      position: 0,
      step_type: "email",
      is_enabled: true,
      config: {
        template_id: "tpl-1",
        template_snapshot: { subject: "Oi", body_html: "<p>oi</p>" },
      },
    };
    fake.tables.players = [{ id: PLAYER, tenant_id: TENANT, email: "jogador@x.com" }];
    fake.tables.email_send_logs = [];
    email.resolveSender.mockReset();
    email.sendInfobipEmail.mockReset();
    email.resolveSender.mockResolvedValue({
      fromEmail: "a@casa.bet",
      fromName: "Casa",
      replyTo: null,
      senderId: "s-1",
    });
    email.sendInfobipEmail.mockResolvedValue({
      ok: false,
      status: 402,
      body: { error: "Saldo insuficiente" },
      idempotencyKey: "key-1",
      temporary: false,
      errorKind: "insufficient_balance",
    });

    const result = await runJourneyDispatcher(1000);
    expect(result).toMatchObject({ processed: 0, failed: 0, deferredNoBalance: 1 });
    expect(fake.tables.email_send_logs).toEqual([]);
    expect(enrollment("e1")).toMatchObject({ status: "waiting", current_position: 0, attempts: 1 });
    expect(fake.tables.journey_events.at(-1)).toMatchObject({
      event_type: "step_deferred",
      detail: expect.objectContaining({ channel: "email", reason: "saldo_insuficiente" }),
    });
    expect(alerts.notifyNoBalance).toHaveBeenCalledWith(TENANT);
  });
});
