// Provedores por casa (Fase 2): the SMS flow dispatcher admits each lead
// against the breaker of ITS house's provider account. The platform account
// being refused holds only the houses on it; a house on its own account keeps
// sending, and vice versa.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpc: vi.fn(async (_name: string, _args: Row) => ({ data: null as unknown, error: null as unknown })),
  breakers: new Map<string, "closed" | "open">(),
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
vi.mock("./sms-provider-breaker.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sms-provider-breaker.server")>();
  const snapshot = (key: string) =>
    state.breakers.get(key) === "open"
      ? {
          state: "open" as const,
          reason: "no_balance",
          lastError: "505",
          since: "2026-10-29T12:00:00.000Z",
          retryAt: "2099-01-01T00:00:00.000Z",
        }
      : { state: "closed" as const, reason: null, lastError: null, since: null, retryAt: null };
  return {
    ...actual,
    acquireSmsSendGate: vi.fn(async (_holder: string, key: string) =>
      state.breakers.get(key) === "open"
        ? { mode: "open" as const, snapshot: snapshot(key) }
        : { mode: "closed" as const },
    ),
    readSmsBreaker: vi.fn(async ({ key }: { key: string }) => snapshot(key)),
    cachedSmsBreaker: vi.fn((key: string) => snapshot(key)),
    releaseSmsProbe: vi.fn(async () => undefined),
  };
});
vi.mock("./sms.functions", () => ({
  sendSmsInternal: vi.fn(),
  renderSmsVariables: vi.fn((content: string) => content),
}));
vi.mock("./billing/wallet-alerts.server", () => ({ notifyNoBalance: vi.fn(async () => false) }));
vi.mock("./dispatch-pause-insufficient.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatch-pause-insufficient.server")>()),
  pauseChannelForInsufficientFunds: vi.fn(async () => undefined),
}));

const OWN_ACCOUNT = "55555555-5555-4555-8555-555555555555";
const TENANT_A = "00000000-0000-4000-8000-00000000000a"; // platform account
const TENANT_B = "00000000-0000-4000-8000-00000000000b"; // own account

vi.mock("./provider-accounts.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-accounts.server")>();
  return {
    ...actual,
    resolveSmsAccount: vi.fn(async (tenantId: string | null) =>
      tenantId === TENANT_B
        ? { ...actual.envShortBrasilAccount(), id: OWN_ACCOUNT }
        : actual.envShortBrasilAccount(),
    ),
  };
});

import { runSmsDispatcher } from "./sms-dispatcher.server";
import { sendSmsInternal } from "./sms.functions";
import { pauseChannelForInsufficientFunds } from "./dispatch-pause-insufficient.server";
import { registerThrottle } from "./dispatch-rate.server";

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
    sms_flow_leads: ["a", "b"].map((suffix, i) => ({
      id: `lead-${suffix}`,
      flow_id: "flow-1",
      player_id: null,
      phone_e164: `+551190000000${i + 1}`,
      current_step_index: 0,
      attempts: 0,
      entered_at: new Date().toISOString(),
      tenant_id: suffix === "a" ? TENANT_A : TENANT_B,
    })),
  };
  state.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_sms_flow_leads") return { data: state.tables.sms_flow_leads, error: null };
    if (name === "reserve_sms_flow_daily_slot") return { data: true, error: null };
    return { data: null, error: null };
  });
}

const leadById = (id: string) => state.tables.sms_flow_leads.find((l) => l.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  state.breakers.clear();
  vi.mocked(sendSmsInternal).mockResolvedValue({
    ok: true as const,
    status: 200,
    response: "{}",
  } as any);
});

describe("SMS flow dispatcher — breaker per provider account", () => {
  it("platform account refused: only its houses are held; the house on its own account sends", async () => {
    seedTwoLeads();
    state.breakers.set("sms", "open");

    const result = await runSmsDispatcher({ limit: 10 });

    expect(result).toMatchObject({ processed: 1, providerUnavailable: true });
    expect(vi.mocked(sendSmsInternal).mock.calls.map(([args]) => args.tenantId)).toEqual([
      TENANT_B,
    ]);
    expect(leadById("lead-b")).toMatchObject({ current_step_index: 1 });
    // Held for the breaker's retry time, no attempt consumed.
    expect(leadById("lead-a")).toMatchObject({
      current_step_index: 0,
      attempts: 0,
      next_run_at: "2099-01-01T00:00:00.000Z",
    });
  });

  it("own account refused: the platform houses keep sending", async () => {
    seedTwoLeads();
    state.breakers.set(`sms:${OWN_ACCOUNT}`, "open");

    const result = await runSmsDispatcher({ limit: 10 });

    expect(result).toMatchObject({ processed: 1 });
    expect(vi.mocked(sendSmsInternal).mock.calls.map(([args]) => args.tenantId)).toEqual([
      TENANT_A,
    ]);
    expect(leadById("lead-b")).toMatchObject({ current_step_index: 0, attempts: 0 });
  });

  it("a 429 or missing balance from a house's own account never throttles or pauses the channel", async () => {
    seedTwoLeads();
    vi.mocked(sendSmsInternal).mockImplementation(async (args) =>
      args.tenantId === TENANT_B
        ? ({
            ok: false as const,
            status: 429,
            error: "rate limited",
            errorKind: null,
            providerAccountId: OWN_ACCOUNT,
          } as any)
        : ({ ok: true as const, status: 200, response: "{}" } as any),
    );

    await runSmsDispatcher({ limit: 10 });

    expect(registerThrottle).not.toHaveBeenCalled();
    expect(pauseChannelForInsufficientFunds).not.toHaveBeenCalled();
    expect(leadById("lead-a")).toMatchObject({ current_step_index: 1 });
    expect(leadById("lead-b")).toMatchObject({ current_step_index: 0, attempts: 0 });
  });

  it("the same 429 from the platform account still throttles the channel", async () => {
    seedTwoLeads();
    vi.mocked(sendSmsInternal).mockResolvedValue({
      ok: false as const,
      status: 429,
      error: "rate limited",
      errorKind: null,
      providerAccountId: null,
    } as any);

    await runSmsDispatcher({ limit: 10 });

    expect(registerThrottle).toHaveBeenCalledWith("sms", 60, expect.any(String));
  });
});
