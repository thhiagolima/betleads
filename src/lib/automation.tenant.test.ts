// F0-04 — the WhatsApp flow engine runs with the service role across all
// tenants (cron). A player may only enter flows of its own tenant, a lead may
// only be sent through a session of its own tenant, and every row written
// must carry that tenant (the column default would file it under the main one).

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, sends: [] as Row[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      if (op === "insert") {
        const row = { id: `${table}-${rows().length + 1}`, ...payload };
        rows().push(row);
        return [row];
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of hit) Object.assign(r, payload);
      return hit;
    };
    const builder: any = {
      select: () => builder,
      insert: (p: Row) => ((op = "insert"), (payload = p), builder),
      update: (p: Row) => ((op = "update"), (payload = p), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      not: () => builder,
      lte: () => builder,
      gte: () => builder,
      lt: () => builder,
      ilike: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const data = run();
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("./triggers.server", () => ({ detectTriggersForPlayer: () => ["inativo_7d"] }));
vi.mock("./priorities", () => ({
  pickHighestPriority: (t: string[]) => t[0] ?? null,
  priorityRank: () => 1,
}));
vi.mock("./whatsapp-external.server", () => ({
  loadActiveIntegrations: async () => new Map(),
  pickExternalTrigger: () => null,
  sendExternalTriggerEvent: async () => ({ sent: false }),
}));
vi.mock("./antiban.server", () => ({
  getAntibanSettings: async () => ({ smart_suppression_enabled: false, auto_pause_enabled: false }),
  isWithinOperationalWindow: () => true,
  nextWindowStart: () => new Date(),
  applyAntibanCaps: () => ({ dailyLimit: 1000, hourlyLimit: 1000, delayMin: 1, delayMax: 1 }),
}));
vi.mock("./whatsapp-send.server", () => ({
  sendFlowBlock: vi.fn(async (_b: unknown, lead: Row, session: Row) => {
    state.sends.push({ lead, session });
    return { messageId: "m1" };
  }),
}));

import { evaluateAllPlayers, runDispatcher } from "./automation.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

beforeEach(() => {
  state.sends = [];
  state.tables = {};
});

describe("evaluateAllPlayers (cron, all tenants)", () => {
  beforeEach(() => {
    state.tables = {
      flows: [
        {
          id: "flow-a",
          tenant_id: A,
          active: true,
          trigger_type: "inativo_7d",
          delay_min_seconds: 1,
          delay_max_seconds: 1,
          activated_at: null,
        },
      ],
      players: [
        { id: "p-a", tenant_id: A, telefone: "5511999990001", status: "ativo" },
        { id: "p-b", tenant_id: B, telefone: "5511999990002", status: "ativo" },
      ],
    };
  });

  it("never enrolls a player into another tenant's flow", async () => {
    await evaluateAllPlayers({ limit: 10 });
    const enrolled = (state.tables.flow_leads ?? []).map((l) => l.player_id);
    expect(enrolled).toEqual(["p-a"]);
  });

  it("writes the lead, alert and log under the player's tenant", async () => {
    await evaluateAllPlayers({ limit: 10 });
    for (const t of ["flow_leads", "lead_alerts", "flow_logs"]) {
      expect(state.tables[t]?.length, t).toBeGreaterThan(0);
      for (const row of state.tables[t]) expect(row.tenant_id, t).toBe(A);
    }
  });
});

describe("runDispatcher session choice", () => {
  beforeEach(() => {
    state.tables = {
      flow_leads: [
        {
          id: "lead-a",
          tenant_id: A,
          flow_id: "flow-a",
          template_id: "tpl-a",
          player_id: null,
          phone_e164: "5511999990001",
          status: "pending",
          current_block_index: 0,
          started_at: new Date().toISOString(),
          attempt_count: 0,
        },
      ],
      flows: [{ id: "flow-a", tenant_id: A, active: true, exit_conditions: {} }],
      flow_templates: [{ id: "tpl-a", flow_id: "flow-a", name: "t", is_active: true, weight: 1 }],
      flow_blocks: [
        {
          id: "blk",
          flow_id: "flow-a",
          flow_template_id: "tpl-a",
          block_type: "text",
          content: "oi",
        },
      ],
      whatsapp_sessions: [
        { id: "sess-b", tenant_id: B, name: "B", status: "connected", is_active: true },
      ],
      lead_whatsapp_assignments: [],
    };
  });

  it("does not send a tenant A lead through tenant B's session", async () => {
    await runDispatcher({ limit: 10 });
    expect(state.sends).toEqual([]);
    expect(state.tables.flow_logs?.[0]).toMatchObject({ event: "skipped", tenant_id: A });
  });

  it("sends through the tenant's own session and records the assignment under it", async () => {
    state.tables.whatsapp_sessions.push({
      id: "sess-a",
      tenant_id: A,
      name: "A",
      status: "connected",
      is_active: true,
    });
    await runDispatcher({ limit: 10 });
    expect(state.sends).toHaveLength(1);
    expect((state.sends[0].session as Row).id).toBe("sess-a");
    expect(state.tables.lead_whatsapp_assignments[0]).toMatchObject({
      tenant_id: A,
      session_id: "sess-a",
    });
    for (const log of state.tables.flow_logs) expect(log.tenant_id).toBe(A);
  });
});
