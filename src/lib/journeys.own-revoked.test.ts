// Conta própria (Task 11): while the house's own provider account is paused
// by a revocation (provider_accounts.disabled_reason = 'revoked' and the
// house's tenant_channel_providers link still points to it — pending decision
// or "manter pausado"), journey steps of that channel WAIT on the same step:
// nothing reserved, consumed, skipped nor failed. Once "usar a padrão" removes
// the link, the next tick sends through the platform default (charged: the
// wallet reservation is priced from the account id, Task 6 — here we check
// that the account the send resolves is the platform one, not owned).
// The in-memory supabase fake is the one of journeys.dispatcher.test.ts.
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
import { __resetSmsBreakerCacheForTests } from "./sms-provider-breaker.server";
import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";
import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  invalidateProviderAccountsCache,
  ownAccountPausedByRevocation,
  resolveSmsAccount,
} from "./provider-accounts.server";
import {
  processSmsCampaignTick,
  type CampaignDispatchDeps,
  type SmsCampaignRow,
} from "./sms-campaign-dispatch.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const JOURNEY = "33333333-3333-4333-8333-333333333333";
const PLAYER = "44444444-4444-4444-8444-444444444444";
const OWN_ACCOUNT = "55555555-5555-4555-8555-555555555555";

function seed(
  stepType: "sms" | "email" | "voice",
  opts: { claimStepType?: boolean; honourExclude?: boolean } = {},
) {
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
      step_type: stepType,
      is_enabled: true,
      config: { content: "oi" },
    },
  ];
  fake.tables.players = [
    { id: PLAYER, tenant_id: TENANT, telefone: "+5511999999999", email: "a@b.com" },
  ];
  fake.tables.journey_enrollments = [
    {
      id: "e1",
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
    },
  ];
  fake.tables.journey_step_executions = [];
  fake.tables.journey_events = [];
  fake.tables.dispatch_pause_state = [];

  fake.rpcs.acquire_journey_dispatcher_slot = () => 0;
  claimOnce(stepType, opts.claimStepType ?? true, opts.honourExclude ?? true);
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

/**
 * The next run claims every enrollment once, honouring p_exclude like the SQL
 * (`tenant:step_type`); `honourExclude: false` stands for a claim made with an
 * older snapshot (the revocation landed between the claim and the send).
 */
function claimOnce(stepType: string, withStepType: boolean, honourExclude = true) {
  let claimed = false;
  fake.rpcs.claim_journey_enrollments_leased = (args) => {
    if (claimed) return [];
    claimed = true;
    const exclude = new Set(honourExclude ? ((args.p_exclude as string[] | undefined) ?? []) : []);
    const rows = fake.tables.journey_enrollments
      .filter((row) => !exclude.has(`${row.tenant_id}:${stepType}`))
      .slice(0, Number(args.p_limit));
    for (const row of rows) {
      row.claimed_at = new Date().toISOString();
      row.claimed_by = args.p_worker_id;
    }
    return rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      ...(withStepType ? { step_type: stepType } : {}),
    }));
  };
}

/** Revogação (Task 10): concessão revogada, conta da casa desativada 'revoked', link mantido. */
function revokeOwnAccount(channel: "sms" | "email" | "voice", pendingDecision = true) {
  fake.tables.tenant_own_provider_grants = [
    {
      tenant_id: TENANT,
      channel,
      allowed: false,
      monthly_fee_cents: 0,
      revoked_at: "2026-11-07T10:00:00.000Z",
      pending_decision: pendingDecision,
    },
  ];
  fake.tables.provider_accounts = [
    {
      id: OWN_ACCOUNT,
      provider: channel === "sms" ? "short_brasil" : "infobip",
      label: "Conta da casa",
      channels: [channel],
      credentials_source: "db",
      credentials_encrypted: "x",
      config: {},
      status: "disabled",
      disabled_reason: "revoked",
      owner_tenant_id: TENANT,
    },
  ];
  fake.tables.tenant_channel_providers = [
    { tenant_id: TENANT, channel, provider_account_id: OWN_ACCOUNT },
  ];
  invalidateProviderAccountsCache();
}

/** adminResolveRevokedOwnProviderFor({action:'use_default'}): link removed, decision cleared. */
function useDefault() {
  fake.tables.tenant_channel_providers = [];
  for (const grant of fake.tables.tenant_own_provider_grants) grant.pending_decision = false;
  invalidateProviderAccountsCache();
}

const enrollment = () => fake.tables.journey_enrollments.find((row) => row.id === "e1")!;

const claimExcludes = () =>
  fake.rpcCalls
    .filter((c) => c.name === "claim_journey_enrollments_leased")
    .map((c) => (c.args.p_exclude as string[] | undefined) ?? []);

/** Kept out of the claim: untouched, still due, same step, nothing reserved/sent/logged. */
function expectNotClaimed(channel: string) {
  expect(claimExcludes().length).toBeGreaterThan(0);
  for (const exclude of claimExcludes()) expect(exclude).toContain(`${TENANT}:${channel}`);
  expect(enrollment()).toMatchObject({
    status: "active",
    current_position: 0,
    attempts: 1,
    claimed_by: null,
  });
  expect(fake.tables.journey_step_executions).toEqual([]);
  expect(fake.tables.journey_events).toEqual([]);
  expect(fake.rpcCalls.map((c) => c.name)).not.toContain("reserve_journey_delivery_v2");
}

/** Claimed anyway (older snapshot): held on the same step, no attempt consumed. */
function expectHeldOnSameStep(before: number) {
  const row = enrollment();
  expect(row).toMatchObject({
    status: "waiting",
    current_position: 0,
    attempts: 1,
    claimed_by: null,
  });
  expect(Date.parse(String(row.next_run_at))).toBeGreaterThan(before);
  const types = fake.tables.journey_events.map((e) => e.event_type);
  expect(types).not.toContain("step_skipped");
  expect(types).not.toContain("failed");
  expect(types).not.toContain("retry_scheduled");
  expect(fake.tables.journey_events.at(-1)).toMatchObject({
    event_type: "step_deferred",
    detail: expect.objectContaining({ reason: "own_account_revoked", attempt_consumed: false }),
  });
}

beforeEach(() => {
  fake.reset();
  __resetSmsBreakerCacheForTests();
  __resetTenantChannelsCacheForTests();
  __resetProviderAccountsCacheForTests();
  sms.sendSmsInternal.mockReset();
  voice.callInfobipVoice.mockReset();
  email.sendInfobipEmail.mockReset();
  vi.stubEnv("JOURNEYS_DISPATCH_ENABLED", "true");
  vi.stubEnv("JOURNEYS_ALLOW_ALL_TENANTS", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("journeys: conta própria pausada pela revogação", () => {
  it("SMS: o passo não é consumido nem pulado/falhado; a matrícula fica no mesmo passo", async () => {
    seed("sms");
    revokeOwnAccount("sms");

    const result = await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, failed: 0 });
    expectNotClaimed("sms");
  });

  it("revogada entre o claim e o envio (claim sem step_type, snapshot antigo): espera no mesmo passo", async () => {
    seed("sms", { claimStepType: false, honourExclude: false });
    revokeOwnAccount("sms");
    const before = Date.now();

    const result = await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 0 });
    expectHeldOnSameStep(before);
    // Held before the reservation: no execution row at all.
    expect(fake.tables.journey_step_executions).toEqual([]);
  });

  it("'manter pausado' (pending_decision já false, link mantido): continua esperando", async () => {
    seed("sms");
    revokeOwnAccount("sms", false);

    await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).not.toHaveBeenCalled();
    expectNotClaimed("sms");
  });

  it("depois de 'usar a padrão' o próximo tick envia pela conta da plataforma (cobrada)", async () => {
    seed("sms");
    revokeOwnAccount("sms");
    await runJourneyDispatcher(1000);
    expect(sms.sendSmsInternal).not.toHaveBeenCalled();

    useDefault();
    enrollment().next_run_at = new Date(0).toISOString();
    claimOnce("sms", true);
    const used: Array<{ id: string; ownerTenantId: string | null }> = [];
    sms.sendSmsInternal.mockImplementation(async (args: { tenantId: string }) => {
      const account = await resolveSmsAccount(args.tenantId);
      used.push({ id: account.id, ownerTenantId: account.ownerTenantId });
      return { ok: true, status: 200, response: "{}", providerAccountId: account.id };
    });

    await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    expect(used).toEqual([{ id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID, ownerTenantId: null }]);
    expect(enrollment()).toMatchObject({ current_position: 1, attempts: 0 });
  });

  it("e-mail: o passo espera no mesmo lugar, nada enviado", async () => {
    seed("email");
    revokeOwnAccount("email");

    await runJourneyDispatcher(1000);

    expect(email.sendInfobipEmail).not.toHaveBeenCalled();
    expectNotClaimed("email");
  });

  it("voz: o passo espera no mesmo lugar, nenhuma ligação", async () => {
    seed("voice");
    revokeOwnAccount("voice");

    await runJourneyDispatcher(1000);

    expect(voice.callInfobipVoice).not.toHaveBeenCalled();
    expectNotClaimed("voice");
  });

  it("e-mail e voz claimados com snapshot antigo também esperam no mesmo passo", async () => {
    for (const channel of ["email", "voice"] as const) {
      fake.reset();
      __resetProviderAccountsCacheForTests();
      seed(channel, { honourExclude: false });
      revokeOwnAccount(channel);
      const before = Date.now();

      await runJourneyDispatcher(1000);

      expect(email.sendInfobipEmail).not.toHaveBeenCalled();
      expect(voice.callInfobipVoice).not.toHaveBeenCalled();
      expectHeldOnSameStep(before);
    }
  });

  it("conta desativada pela BetLeads ('platform', não revogação) não entra na espera", async () => {
    seed("sms");
    revokeOwnAccount("sms");
    fake.tables.provider_accounts[0].disabled_reason = "platform";
    invalidateProviderAccountsCache();
    sms.sendSmsInternal.mockResolvedValue({
      ok: false,
      status: 0,
      error: "A conta de provedor está desativada.",
      errorKind: "misconfigured",
    });

    await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
    const reasons = fake.tables.journey_events.map(
      (e) => (e.detail as Record<string, unknown> | undefined)?.reason,
    );
    expect(reasons).not.toContain("own_account_revoked");
  });

  it("a revogação na hora do envio (misconfigured, snapshot virou no meio) também espera, sem teto", async () => {
    seed("sms");
    // Pre-checks see the account active; the send then finds it revoked.
    fake.tables.provider_accounts = [];
    sms.sendSmsInternal.mockImplementation(async () => {
      revokeOwnAccount("sms");
      return {
        ok: false,
        status: 0,
        error: 'A conta de provedor "Conta da casa" está desativada.',
        errorKind: "misconfigured",
      };
    });
    const before = Date.now();

    await runJourneyDispatcher(1000);

    expectHeldOnSameStep(before);
    expect(fake.tables.journey_step_executions[0].status).toBe("retrying");
    // Not a platform hold: no MAX_PLATFORM_HOLDS cap.
    const metadata = enrollment().metadata as Record<string, unknown> | undefined;
    expect(metadata?.platform_holds).toBeUndefined();
  });

  it("outra casa (sem link para a conta revogada) não é afetada", async () => {
    seed("sms");
    revokeOwnAccount("sms");
    fake.tables.journey_enrollments[0].tenant_id = OTHER_TENANT;
    fake.tables.journeys[0].tenant_id = OTHER_TENANT;
    fake.tables.players[0].tenant_id = OTHER_TENANT;
    sms.sendSmsInternal.mockResolvedValue({ ok: true, status: 200, response: "{}" });

    await runJourneyDispatcher(1000);

    expect(sms.sendSmsInternal).toHaveBeenCalledTimes(1);
  });
});

describe("campanha SMS: conta própria pausada pela revogação", () => {
  function campaign(): SmsCampaignRow {
    return {
      id: "66666666-6666-4666-8666-666666666666",
      tenant_id: TENANT,
      name: "Campanha",
      content: "oi",
      route: "iGaming",
      recipients: [
        { phone: "+5511999990001", playerId: "p1" },
        { phone: "+5511999990002", playerId: "p2" },
      ],
      total_count: 2,
      sent_count: 0,
      deduplicated_count: 0,
      failed_count: 0,
      scheduled_at: "2026-11-07T12:00:00Z",
      sent_cursor: 0,
      last_error: null,
      rate_per_minute: 1000,
      track_links: true,
      locked_by: "lock-1",
    };
  }

  function deps(sends: string[], patches: Record<string, unknown>[]): CampaignDispatchDeps {
    return {
      now: () => 0,
      resolveRecipients: async (_tenant, inputs) => ({
        resolved: [],
        unresolved: [],
        duplicates: 0,
        assignments: inputs.map((t) => ({
          phone: t.phone,
          playerId: t.playerId ?? "p",
          reason: null,
        })),
      }),
      updateCampaign: async (_c, patch) => {
        patches.push(patch);
        return true;
      },
      persistUnresolved: async () => undefined,
      acquireSendBudget: async (_tenant, want) => want,
      findAcceptedDeliveryKeys: async () => new Set(),
      loadPlayerVariables: async () => new Map(),
      send: async ({ deliveryKey }) => {
        sends.push(deliveryKey);
        return { ok: true };
      },
      channelEnabled: async () => true,
      ownAccountPaused: (tenantId) => ownAccountPausedByRevocation(tenantId, "sms"),
    };
  }

  it("para como pausada com o last_error da revogação, nada enviado", async () => {
    revokeOwnAccount("sms");
    const sends: string[] = [];
    const patches: Record<string, unknown>[] = [];

    const r = await processSmsCampaignTick(campaign(), deps(sends, patches), { deadline: 45_000 });

    expect(sends).toEqual([]);
    expect(r).toMatchObject({ status: "pausada", stopReason: "own_account_paused", sent: 0 });
    expect(patches).toEqual([
      {
        status: "pausada",
        last_error: "Conta própria do canal pausada pela BetLeads",
        locked_at: null,
        locked_by: null,
      },
    ]);
  });

  it("'manter pausado' também pausa; depois de 'usar a padrão' a campanha envia", async () => {
    revokeOwnAccount("sms", false);
    const sends: string[] = [];
    const patches: Record<string, unknown>[] = [];
    const paused = await processSmsCampaignTick(campaign(), deps(sends, patches), {
      deadline: 45_000,
    });
    expect(paused.status).toBe("pausada");

    useDefault();
    const r = await processSmsCampaignTick(campaign(), deps(sends, patches), { deadline: 45_000 });
    expect(r).toMatchObject({ status: "enviado", sent: 2 });
    expect(sends).toHaveLength(2);
  });

  it("revogada no meio do lote: corta antes do destinatário e pausa (cursor antes dele)", async () => {
    const sends: string[] = [];
    const patches: Record<string, unknown>[] = [];
    const d = deps(sends, patches);
    let calls = 0;
    d.send = async ({ deliveryKey }) => {
      calls++;
      if (calls >= 2) {
        return { ok: false, ownAccountPaused: true, error: "A conta de provedor está desativada." };
      }
      sends.push(deliveryKey);
      return { ok: true };
    };
    const c = { ...campaign(), rate_per_minute: 1 };

    const r = await processSmsCampaignTick(c, d, { deadline: 45_000, tickSeconds: 180 });

    expect(r).toMatchObject({
      status: "pausada",
      stopReason: "own_account_paused",
      sent: 1,
      failed: 0,
    });
    expect(patches.at(-1)).toMatchObject({
      status: "pausada",
      last_error: "Conta própria do canal pausada pela BetLeads",
    });
    const cursor = patches.find((p) => "sent_cursor" in p);
    expect(cursor).toMatchObject({ sent_cursor: 1 });
  });
});
