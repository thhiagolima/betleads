// Task 9 — TS workers never pick up demo-tenant work: `orchestrate` exits right
// after reading the tenant row, and the global/per-table workers exclude demo
// tenant ids before reading their queues (so no provider call, and no write
// to the demo snapshot, ever starts from them).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Access = { table: string; op: string; args: unknown[] };

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  accesses: [] as Array<{ table: string; op: string; args: unknown[] }>,
  sends: 0,
  // Tables whose reads fail (PostgREST error), to test fail-closed paths.
  failingTables: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function parseList(value: unknown): unknown[] {
    return String(value)
      .replace(/^\(|\)$/g, "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let write: "update" | "insert" | "upsert" | null = null;
    let patch: Row | null = null;
    const log = (op: string, args: unknown[]) => state.accesses.push({ table, op, args });
    const local = (c: string) => !c.includes(".");
    const run = () => (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = () => {
      if (write === "insert") return { data: { id: `${table}-new` }, error: null, count: 0 };
      if (write === "update" && patch) for (const row of run()) Object.assign(row, patch);
      if (write) return { data: null, error: null, count: 0 };
      if (state.failingTables.has(table)) {
        return { data: null, error: { message: `${table} unavailable` }, count: null };
      }
      const rows = run();
      return { data: rows, error: null, count: rows.length };
    };
    const builder: any = {
      select: (...a: unknown[]) => (log("select", a), builder),
      update: (...a: unknown[]) => (
        log("update", a),
        (write = write ?? "update"),
        (patch = a[0] as Row),
        builder
      ),
      insert: (...a: unknown[]) => (log("insert", a), (write = "insert"), builder),
      upsert: (...a: unknown[]) => (
        log("upsert", a),
        (write = "upsert"),
        Promise.resolve({ error: null })
      ),
      eq: (c: string, v: unknown) => (
        log("eq", [c, v]),
        local(c) && filters.push((r) => r[c] === v),
        builder
      ),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), builder),
      in: (c: string, v: unknown[]) => (
        log("in", [c, v]),
        filters.push((r) => v.includes(r[c])),
        builder
      ),
      not: (c: string, op: string, v: unknown) => {
        log("not", [c, op, v]);
        if (op === "in") {
          const list = parseList(v);
          filters.push((r) => !list.includes(r[c]));
        } else if (op === "is" && v === null) {
          filters.push((r) => r[c] !== null && r[c] !== undefined);
        }
        return builder;
      },
      is: () => builder,
      gte: () => builder,
      gt: () => builder,
      lte: () => builder,
      lt: () => builder,
      like: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      single: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }
  return {
    supabaseAdmin: {
      from,
      rpc: async () => ({ data: [], error: null }),
    },
  };
});

vi.mock("./whatsapp-send.server", () => ({
  sendFlowBlock: vi.fn(async () => {
    state.sends++;
    return { ok: true };
  }),
}));

import { orchestrate } from "./orchestrator.server";
import { syncShortioMetrics } from "./shortio.server";
import { runPrecallDispatcher } from "./precall-dispatcher.server";
import { runVoiceQueueDispatcher } from "./calls.server";
import { reconcileChannelCallbacks } from "./infobip-voice-reconciliation.server";
import { runCashbackCatchup } from "./cashback-catchup.server";
import { evaluateAllPlayers, runDispatcher } from "./automation.server";
import { tickFlows } from "./call-flows.server";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";

const DEMO = "00000000-0000-4000-8000-00000000d0d0";
const NORMAL = "00000000-0000-4000-8000-00000000a0a0";

function touched(predicate: (a: Access) => boolean) {
  return state.accesses.filter(predicate);
}

/** Every eq/in filter or write payload that names the demo tenant. */
function demoReferences() {
  return touched(
    (a) =>
      (a.op === "eq" && a.args[1] === DEMO) ||
      (a.op === "in" && Array.isArray(a.args[1]) && (a.args[1] as unknown[]).includes(DEMO)) ||
      ((a.op === "update" || a.op === "insert" || a.op === "upsert") &&
        JSON.stringify(a.args).includes(DEMO)),
  );
}

beforeEach(() => {
  __resetDemoTenantCacheForTests();
  state.accesses = [];
  state.sends = 0;
  state.failingTables = new Set();
  state.tables = {
    tenants: [
      { id: DEMO, status: "active", is_demo: true, crm_model: null },
      { id: NORMAL, status: "active", is_demo: false, crm_model: null },
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SHORTIO_API_KEY;
});

describe("orchestrate", () => {
  it("returns right after reading the demo tenant row, touching nothing else", async () => {
    const result = await orchestrate({ mode: "execute", tenantId: DEMO });
    expect(result.run_id).toBeNull();
    expect(result.duration_ms).toBe(0);
    const tables = new Set(state.accesses.map((a) => a.table));
    expect([...tables]).toEqual(["tenants"]);
    expect(touched((a) => a.op === "update" || a.op === "insert")).toEqual([]);
  });

  it("fails closed when the tenant lookup errors: throws, touching nothing else", async () => {
    state.failingTables.add("tenants");
    await expect(orchestrate({ mode: "execute", tenantId: NORMAL })).rejects.toThrow(
      /tenants unavailable/,
    );
    const tables = new Set(state.accesses.map((a) => a.table));
    expect([...tables]).toEqual(["tenants"]);
  });
});

describe("syncShortioMetrics", () => {
  it("never calls Short.io for a demo tenant's links in the global run", async () => {
    process.env.SHORTIO_API_KEY = "test-key";
    state.tables.tracked_links = [
      { id: "link-demo", tenant_id: DEMO, shortio_link_id: "sh-demo", status: "active" },
      { id: "link-normal", tenant_id: NORMAL, shortio_link_id: "sh-normal", status: "active" },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ clicksStatistics: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncShortioMetrics(10);

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((u) => u.includes("sh-demo"))).toBe(false);
    expect(urls.some((u) => u.includes("sh-normal"))).toBe(true);
    expect(result.tenants).toBe(1);
    expect(demoReferences()).toEqual([]);
  });

  it("does not fetch for a demo tenant even when called for it directly", async () => {
    process.env.SHORTIO_API_KEY = "test-key";
    state.tables.tracked_links = [
      { id: "link-demo", tenant_id: DEMO, shortio_link_id: "sh-demo", status: "active" },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncShortioMetrics(10, DEMO);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("queue workers exclude demo tenants before reading their queues", () => {
  it("runPrecallDispatcher never picks up a demo campaign", async () => {
    state.tables.precall_campaigns = [
      { id: "camp-demo", tenant_id: DEMO, session_id: "s-demo", status: "rodando" },
    ];
    state.tables.precall_leads = [
      {
        id: "lead-demo",
        tenant_id: DEMO,
        campaign_id: "camp-demo",
        status: "pendente",
        player_id: null,
        telefone_e164: "5511900000001",
      },
    ];
    const result = await runPrecallDispatcher();
    expect(result).toEqual({ campaigns: 0, sent: 0, failed: 0 });
    expect(state.sends).toBe(0);
    expect(demoReferences()).toEqual([]);
    expect(touched((a) => a.table === "precall_leads")).toEqual([]);
  });

  it("runVoiceQueueDispatcher never picks up a demo call_queue item", async () => {
    state.tables.call_queue = [
      {
        id: "q-demo",
        tenant_id: DEMO,
        status: "audio_ready",
        phone_number: "5511900000001",
        lead_id: null,
      },
    ];
    const result = await runVoiceQueueDispatcher(10);
    expect(result).toMatchObject({ dispatched: 0, failed: 0 });
    expect(demoReferences()).toEqual([]);
    expect(touched((a) => a.table === "call_queue" && a.op === "update")).toEqual([]);
  });

  it("reconcileChannelCallbacks never audits demo rows", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    state.tables.call_history = [
      { id: "ch-demo", tenant_id: DEMO, provider: "infobip", status: "pending", created_at: old },
    ];
    state.tables.email_send_logs = [
      { id: "em-demo", tenant_id: DEMO, status: "pending", created_at: old },
    ];
    state.tables.sms_send_logs = [
      {
        id: "sms-demo",
        tenant_id: DEMO,
        provider: "short-brasil",
        delivery_status: "pending",
        created_at: old,
      },
    ];
    const result = await reconcileChannelCallbacks();
    expect(result.voice.audited).toBe(0);
    expect(result.email.audited).toBe(0);
    expect(result.sms.audited).toBe(0);
    expect(touched((a) => a.op === "update")).toEqual([]);
  });

  it("runDispatcher never picks up nor postpones demo flow_leads", async () => {
    state.tables.flow_leads = [
      {
        id: "fl-demo",
        tenant_id: DEMO,
        flow_id: "flow-demo",
        status: "pending",
        phone_e164: "5511900000001",
      },
    ];
    const inWindow = await runDispatcher({ bypassWindow: true });
    expect(inWindow).toEqual({ processed: 0, sent: 0 });
    expect(touched((a) => a.table === "flow_leads" && a.op === "update")).toEqual([]);
    expect(touched((a) => a.table === "flow_leads" && a.op === "not")).toHaveLength(1);
  });

  it("runDispatcher out of the operational window postpones only non-demo flow_leads", async () => {
    // 03:00 in São Paulo, window 08:00-20:00 -> out of window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T06:00:00Z"));
    state.tables.antiban_settings = [
      {
        delay_min_seconds: 5,
        delay_max_seconds: 10,
        hourly_limit: 100,
        daily_limit: 1000,
        window_start: "08:00",
        window_end: "20:00",
        randomization_enabled: false,
        smart_suppression_enabled: false,
        auto_pause_enabled: false,
        warmup_enabled: false,
        warmup_initial_daily: 0,
        warmup_days: 0,
      },
    ];
    const due = "2026-10-17T05:00:00.000Z";
    state.tables.flow_leads = [
      { id: "fl-demo", tenant_id: DEMO, status: "pending", next_run_at: due },
      { id: "fl-normal", tenant_id: NORMAL, status: "pending", next_run_at: due },
    ];

    const result = await runDispatcher();

    expect(result).toMatchObject({ skipped: "out-of-window" });
    const [demoLead, normalLead] = state.tables.flow_leads;
    expect(demoLead.next_run_at).toBe(due);
    expect(normalLead.next_run_at).not.toBe(due);
    expect(touched((a) => a.table === "flow_leads" && a.op === "not")).toEqual([
      { table: "flow_leads", op: "not", args: ["tenant_id", "in", `(${DEMO})`] },
    ]);
  });

  it("evaluateAllPlayers never evaluates demo players", async () => {
    state.tables.flows = [
      { id: "flow-demo", tenant_id: DEMO, active: true, trigger_type: "sem_login_3d" },
    ];
    state.tables.players = [
      { id: "p-demo", tenant_id: DEMO, status: "ativo", telefone: "5511900000001" },
    ];
    const result = await evaluateAllPlayers();
    expect(result).toMatchObject({ enqueued: 0 });
    expect(touched((a) => a.table === "players" && a.op === "not")).toContainEqual({
      table: "players",
      op: "not",
      args: ["tenant_id", "in", `(${DEMO})`],
    });
    expect(touched((a) => a.op === "insert" || a.op === "update")).toEqual([]);
  });

  it("tickFlows never reads demo call_flow_progress", async () => {
    state.tables.call_flow_progress = [{ id: "cfp-demo", tenant_id: DEMO, status: "waiting" }];
    const result = await tickFlows(10);
    expect(result).toEqual({ processed: 0 });
    expect(demoReferences()).toEqual([]);
  });

  it("runCashbackCatchup never reads demo cashback payments", async () => {
    state.tables.cashback_payments = [
      {
        id: "pay-demo",
        tenant_id: DEMO,
        player_id: "p-demo",
        paid_at: new Date().toISOString(),
        telefone: "5511900000001",
        email: null,
      },
    ];
    const result = await runCashbackCatchup();
    expect(result).toEqual({ payments: 0, sms_enrolled: 0, email_enrolled: 0 });
    expect(demoReferences()).toEqual([]);
  });
});
