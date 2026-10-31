// PG3 Task 1 — a wallet refusal (errorKind "insufficient_balance") must skip
// only the refused house's own item, never pause the SMS channel globally.
// A real provider 402 (Short Brasil account itself out of balance, no
// errorKind) must still pause every tenant, same as before.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpc: vi.fn(async (_name: string, _args: Row) => ({ data: null as unknown, error: null as unknown })),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        const inserted = list.map((r) => ({ id: `${table}-${rows().length + 1}`, ...r }));
        rows().push(...inserted);
        return inserted;
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of hit) Object.assign(r, payload);
      return hit;
    };
    const builder: any = {
      select: () => builder,
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), builder),
      update: (p: Row) => ((op = "update"), (payload = p), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from, rpc: state.rpc } };
});

vi.mock("./send-window.server", () => ({ deferIfOutsideWindow: vi.fn(async () => null) }));
vi.mock("./dispatch-rate.server", () => ({
  consumeBudget: vi.fn(async (_c: string, n: number) => n),
  countQueuePending: vi.fn(async () => 0),
  getRateState: vi.fn(async () => null),
  parseRetryAfter: vi.fn(() => 60),
  recordRun: vi.fn(async () => undefined),
  registerThrottle: vi.fn(async () => undefined),
}));
vi.mock("./house-links.server", () => ({ loadHouseLinks: vi.fn(async () => ({})) }));
vi.mock("./sms-provider-breaker.server", () => ({
  BREAKER_CACHE_MS: 5_000,
  PLATFORM_SMS_BREAKER_KEY: "sms",
  smsBreakerKey: vi.fn(() => "sms"),
  acquireSmsSendGate: vi.fn(async () => ({ mode: "closed" as const })),
  releaseSmsProbe: vi.fn(async () => undefined),
  cachedSmsBreaker: vi.fn(() => ({
    state: "closed",
    reason: null,
    lastError: null,
    since: null,
    retryAt: null,
  })),
  breakerRetryAt: vi.fn(() => new Date(Date.now() + 120_000).toISOString()),
  readSmsBreaker: vi.fn(async () => ({
    state: "closed",
    reason: null,
    lastError: null,
    since: null,
    retryAt: null,
  })),
  smsSuspendedMessage: vi.fn(() => "suspended"),
}));
vi.mock("./sms.functions", () => ({
  sendSmsInternal: vi.fn(),
  renderSmsVariables: vi.fn((content: string) => content),
}));
vi.mock("./billing/wallet-alerts.server", () => ({ notifyNoBalance: vi.fn(async () => false) }));
vi.mock("./billing/expert-cap-alerts.server", () => ({
  notifyExpertCapReached: vi.fn(async () => true),
}));
vi.mock("./dispatch-pause-insufficient.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatch-pause-insufficient.server")>()),
  pauseChannelForInsufficientFunds: vi.fn(async () => undefined),
}));

import { runSmsDispatcher } from "./sms-dispatcher.server";
import { sendSmsInternal } from "./sms.functions";
import { pauseChannelForInsufficientFunds } from "./dispatch-pause-insufficient.server";
import { registerThrottle } from "./dispatch-rate.server";
import { notifyNoBalance } from "./billing/wallet-alerts.server";
import { notifyExpertCapReached } from "./billing/expert-cap-alerts.server";

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

function seedTwoLeads() {
  state.tables = {
    automation_settings: [],
    sms_flows: [
      {
        id: "flow-1",
        is_active: true,
        exit_conditions: {},
        trigger_name: null,
        randomize_templates: false,
        daily_limit: 500,
        cooldown_hours: 0,
      },
    ],
    sms_flow_steps: [
      {
        id: "step-1",
        flow_id: "flow-1",
        order_index: 0,
        step_type: "sms",
        content: "Oi",
        delay_days: 0,
        is_active: true,
        track_links: false,
      },
    ],
    players: [],
    sms_send_logs: [],
    sms_flow_leads: [
      {
        id: "lead-a",
        flow_id: "flow-1",
        player_id: null,
        phone_e164: "+5511900000001",
        current_step_index: 0,
        attempts: 0,
        entered_at: new Date().toISOString(),
        tenant_id: TENANT_A,
      },
      {
        id: "lead-b",
        flow_id: "flow-1",
        player_id: null,
        phone_e164: "+5511900000002",
        current_step_index: 0,
        attempts: 0,
        entered_at: new Date().toISOString(),
        tenant_id: TENANT_B,
      },
    ],
  };
  state.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_sms_flow_leads") {
      return { data: state.tables.sms_flow_leads, error: null };
    }
    if (name === "reserve_sms_flow_daily_slot") {
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });
}

function leadById(id: string) {
  return state.tables.sms_flow_leads.find((l) => l.id === id)!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SMS flow dispatcher — wallet refusal stays per-house (PG3 Task 1)", () => {
  it("tenant A has no balance and tenant B sends normally in the same tick: no global pause", async () => {
    seedTwoLeads();
    vi.mocked(sendSmsInternal).mockImplementation(async (args) => {
      if (args.tenantId === TENANT_A) {
        return {
          ok: false as const,
          status: 402,
          error: "Saldo insuficiente",
          errorKind: "insufficient_balance",
        } as any;
      }
      return { ok: true as const, status: 200, response: "{}" } as any;
    });

    const before = Date.now();
    const result = await runSmsDispatcher({ limit: 10 });

    expect(pauseChannelForInsufficientFunds).not.toHaveBeenCalled();
    expect(registerThrottle).not.toHaveBeenCalled();
    // Tenant B's send still went through in the same tick.
    expect(result).toMatchObject({ processed: 1 });
    expect(leadById("lead-b")).toMatchObject({ current_step_index: 1 });
    // Tenant A's lead was only skipped (rescheduled 15 min out, same backoff
    // as the generic wallet-insufficient path), never marked failed and
    // never charged an attempt.
    const leadA = leadById("lead-a");
    expect(leadA.status).not.toBe("failed");
    expect(leadA.current_step_index).toBe(0);
    expect(leadA.attempts).toBe(0);
    const nextRunAtMs = Date.parse(String(leadA.next_run_at));
    expect(nextRunAtMs).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1_000);
    expect(nextRunAtMs).toBeLessThanOrEqual(before + 15 * 60_000 + 10_000);
    // PG3 Task 7: only the broke house is alerted.
    expect(notifyNoBalance).toHaveBeenCalledWith(TENANT_A);
    expect(notifyNoBalance).not.toHaveBeenCalledWith(TENANT_B);
  });

  it("an alert failure never breaks the skip", async () => {
    seedTwoLeads();
    vi.mocked(notifyNoBalance).mockRejectedValueOnce(new Error("alert down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(sendSmsInternal).mockImplementation(async (args) =>
      args.tenantId === TENANT_A
        ? ({ ok: false, status: 402, error: "Saldo insuficiente", errorKind: "insufficient_balance" } as any)
        : ({ ok: true, status: 200, response: "{}" } as any),
    );
    const result = await runSmsDispatcher({ limit: 10 });
    expect(result).toMatchObject({ processed: 1 });
    expect(leadById("lead-a")).toMatchObject({ current_step_index: 0, attempts: 0 });
  });

  it("a real provider 402 (no errorKind) still pauses the channel globally", async () => {
    state.tables = {
      automation_settings: [],
      sms_flows: [
        {
          id: "flow-1",
          is_active: true,
          exit_conditions: {},
          trigger_name: null,
          randomize_templates: false,
          daily_limit: 500,
          cooldown_hours: 0,
        },
      ],
      sms_flow_steps: [
        {
          id: "step-1",
          flow_id: "flow-1",
          order_index: 0,
          step_type: "sms",
          content: "Oi",
          delay_days: 0,
          is_active: true,
          track_links: false,
        },
      ],
      players: [],
      sms_send_logs: [],
      sms_flow_leads: [
        {
          id: "lead-a",
          flow_id: "flow-1",
          player_id: null,
          phone_e164: "+5511900000001",
          current_step_index: 0,
          attempts: 0,
          entered_at: new Date().toISOString(),
          tenant_id: TENANT_A,
        },
      ],
    };
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_sms_flow_leads") {
        return { data: state.tables.sms_flow_leads, error: null };
      }
      if (name === "reserve_sms_flow_daily_slot") {
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });
    vi.mocked(sendSmsInternal).mockResolvedValue({
      ok: false as const,
      status: 402,
      error: "HTTP 402",
      body: "{}",
    } as any);

    await runSmsDispatcher({ limit: 10 });

    expect(pauseChannelForInsufficientFunds).toHaveBeenCalledTimes(1);
    expect(pauseChannelForInsufficientFunds).toHaveBeenCalledWith("sms", expect.any(String));
  });
});

// PG3 final fix I3 — SMS campaigns: a house without balance pauses only its
// own campaign (status "pausada", last_error "Saldo insuficiente"), the
// refused recipient is not counted as failed and the cursor stays before it.
describe("SMS campaign dispatcher — wallet refusal pauses only that house's campaign", () => {
  function campaignRow(id: string, tenantId: string) {
    return {
      id,
      tenant_id: tenantId,
      name: `Campanha ${id}`,
      content: "Oi",
      route: "iGaming",
      recipients: [
        { phone: "+5511900000101", playerId: "00000000-0000-4000-8000-000000000101" },
        { phone: "+5511900000102", playerId: "00000000-0000-4000-8000-000000000102" },
      ],
      total_count: 2,
      sent_count: 0,
      deduplicated_count: 0,
      failed_count: 0,
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      sent_cursor: 0,
      last_error: null,
      rate_per_minute: 60,
      track_links: false,
      status: "enviando",
      locked_by: `lock-${id}`,
      audience_resolved_at: null,
    };
  }

  it("tenant A's campaign is paused, tenant B's campaign is sent in the same tick", async () => {
    state.tables = {
      sms_campaigns: [campaignRow("camp-a", TENANT_A), campaignRow("camp-b", TENANT_B)],
      sms_send_logs: [],
      players: [],
    };
    state.rpc.mockImplementation(async (name: string, args: Row) => {
      if (name === "claim_due_sms_campaigns") return { data: state.tables.sms_campaigns, error: null };
      if (name === "consume_channel_budget") {
        return { data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }], error: null };
      }
      return { data: null, error: null };
    });
    vi.mocked(sendSmsInternal).mockImplementation(async (args) =>
      args.tenantId === TENANT_A
        ? ({ ok: false, status: 402, error: "Saldo insuficiente", errorKind: "insufficient_balance" } as any)
        : ({ ok: true, status: 200, response: "{}" } as any),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { runScheduledSmsCampaigns } = await import("./sms-dispatcher.server");
    await runScheduledSmsCampaigns({ limit: 10 });

    const [a, b] = state.tables.sms_campaigns;
    expect(a).toMatchObject({
      status: "pausada",
      last_error: "Saldo insuficiente",
      failed_count: 0,
      sent_cursor: 0,
      locked_by: null,
    });
    expect(b).toMatchObject({ status: "enviado", sent_count: 2 });
    expect(pauseChannelForInsufficientFunds).not.toHaveBeenCalled();
    expect(notifyNoBalance).toHaveBeenCalledWith(TENANT_A);
    expect(notifyNoBalance).not.toHaveBeenCalledWith(TENANT_B);
  });
});

// Área do Expert §8 — an expert campaign at the expert's monthly cap pauses
// only itself with its own reason: never the house's "sem saldo" alert.
// Every tick re-applies the expert's current scope and active flag.
describe("SMS campaign dispatcher — expert campaigns", () => {
  const EXPERT = "00000000-0000-4000-8000-0000000000e1";
  const P1 = "00000000-0000-4000-8000-000000000101";
  const P2 = "00000000-0000-4000-8000-000000000102";

  function expertCampaign() {
    return {
      id: "camp-x",
      tenant_id: TENANT_A,
      expert_id: EXPERT,
      approval_status: "aprovada",
      name: "Campanha expert",
      content: "Oi",
      route: "iGaming",
      recipients: [
        { phone: "+5511900000101", playerId: P1 },
        { phone: "+5511900000102", playerId: P2 },
      ],
      total_count: 2,
      sent_count: 0,
      deduplicated_count: 0,
      failed_count: 0,
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      sent_cursor: 0,
      last_error: null,
      rate_per_minute: 60,
      track_links: true,
      status: "enviando",
      locked_by: "lock-x",
      audience_resolved_at: new Date().toISOString(),
    };
  }

  function seed(opts: { ativo?: boolean; p2Affiliate?: string } = {}) {
    state.tables = {
      sms_campaigns: [expertCampaign()],
      sms_send_logs: [],
      players: [
        { id: P1, tenant_id: TENANT_A, affiliate_id: "AFF1" },
        { id: P2, tenant_id: TENANT_A, affiliate_id: opts.p2Affiliate ?? "AFF1" },
      ],
      experts: [
        {
          id: EXPERT,
          tenant_id: TENANT_A,
          nome: "Expert",
          tipo: "restrito",
          ativo: opts.ativo ?? true,
          envio_modo: "livre",
          teto_mensal: 1,
        },
      ],
      expert_affiliates: [{ tenant_id: TENANT_A, expert_id: EXPERT, affiliate_id: "AFF1" }],
    };
    state.rpc.mockImplementation(async (name: string, args: Row) => {
      if (name === "claim_due_sms_campaigns") return { data: state.tables.sms_campaigns, error: null };
      if (name === "consume_channel_budget") {
        return { data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }], error: null };
      }
      return { data: null, error: null };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  beforeEach(() => {
    vi.mocked(sendSmsInternal).mockReset();
    vi.mocked(notifyNoBalance).mockClear();
    vi.mocked(notifyExpertCapReached).mockClear();
  });

  it("cap refusal pauses the campaign, alerts the admin about the expert, never the house no-balance", async () => {
    seed();
    vi.mocked(sendSmsInternal).mockResolvedValue({
      ok: false,
      status: 402,
      error: "Teto mensal do expert atingido",
      errorKind: "expert_cap",
    } as any);
    const { runScheduledSmsCampaigns } = await import("./sms-dispatcher.server");
    await runScheduledSmsCampaigns({ limit: 10 });

    expect(state.tables.sms_campaigns[0]).toMatchObject({
      status: "pausada",
      last_error: "Teto mensal do expert atingido",
      failed_count: 0,
      sent_cursor: 0,
    });
    expect(notifyNoBalance).not.toHaveBeenCalled();
    expect(pauseChannelForInsufficientFunds).not.toHaveBeenCalled();
    expect(notifyExpertCapReached).toHaveBeenCalledWith(TENANT_A, EXPERT);
  });

  it("sends with the expert as owner and link origin 'expert' (house shortener)", async () => {
    seed();
    vi.mocked(sendSmsInternal).mockResolvedValue({ ok: true, status: 200, response: "{}" } as any);
    const { runScheduledSmsCampaigns } = await import("./sms-dispatcher.server");
    await runScheduledSmsCampaigns({ limit: 10 });

    expect(sendSmsInternal).toHaveBeenCalledTimes(2);
    for (const [args] of vi.mocked(sendSmsInternal).mock.calls) {
      expect(args).toMatchObject({
        expertId: EXPERT,
        linkTrackingOrigin: { sourceType: "expert", sourceId: EXPERT, shortDomainId: null },
      });
    }
  });

  it("a player whose affiliate left the expert's scope is not sent to", async () => {
    seed({ p2Affiliate: "AFF2" });
    vi.mocked(sendSmsInternal).mockResolvedValue({ ok: true, status: 200, response: "{}" } as any);
    const { runScheduledSmsCampaigns } = await import("./sms-dispatcher.server");
    await runScheduledSmsCampaigns({ limit: 10 });

    expect(sendSmsInternal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsInternal).mock.calls[0][0]).toMatchObject({ playerId: P1 });
    expect(state.tables.sms_campaigns[0]).toMatchObject({ sent_count: 1, failed_count: 1 });
  });

  it("a deactivated expert's campaign is cancelled without sending", async () => {
    seed({ ativo: false });
    const { runScheduledSmsCampaigns } = await import("./sms-dispatcher.server");
    await runScheduledSmsCampaigns({ limit: 10 });

    expect(sendSmsInternal).not.toHaveBeenCalled();
    expect(state.tables.sms_campaigns[0]).toMatchObject({ status: "cancelada", locked_by: null });
  });
});
