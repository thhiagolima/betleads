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
vi.mock("./dispatch-pause-insufficient.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatch-pause-insufficient.server")>()),
  pauseChannelForInsufficientFunds: vi.fn(async () => undefined),
}));

import { runSmsDispatcher } from "./sms-dispatcher.server";
import { sendSmsInternal } from "./sms.functions";
import { pauseChannelForInsufficientFunds } from "./dispatch-pause-insufficient.server";
import { registerThrottle } from "./dispatch-rate.server";
import { notifyNoBalance } from "./billing/wallet-alerts.server";

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
