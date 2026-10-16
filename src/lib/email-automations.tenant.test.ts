// F0-04 — the e-mail flow dispatcher runs with the service role. A lead of
// tenant A must never render another tenant's template or player data, and
// the rows it writes must belong to tenant A (a missing tenant_id silently
// falls back to the main tenant through the column default).

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  sends: [] as Array<{ to: string; subject: string; html: string }>,
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
  return { supabaseAdmin: { from, rpc: vi.fn(async () => ({ data: [], error: null })) } };
});

vi.mock("./email-send.server", () => ({
  resolveSender: vi.fn(async () => ({ fromEmail: "a@a.com", fromName: "A", replyTo: null })),
  sendInfobipEmail: vi.fn(async (input: { to: string; subject: string; html: string }) => {
    state.sends.push({ to: input.to, subject: input.subject, html: input.html });
    return { ok: true, status: 200, body: {}, idempotencyKey: "k" };
  }),
}));
vi.mock("./send-window.server", () => ({ deferIfOutsideWindow: vi.fn(async () => null) }));
vi.mock("./dispatch-rate.server", () => ({
  consumeBudget: vi.fn(async (_c: string, n: number) => n),
  countQueuePending: vi.fn(async () => 0),
  getRateState: vi.fn(async () => null),
  parseRetryAfter: vi.fn(() => 60),
  recordRun: vi.fn(async () => undefined),
  registerThrottle: vi.fn(async () => undefined),
}));

import { runEmailFlowDispatcher } from "./email-automations.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function seed(templateId: string, playerId: string) {
  state.sends = [];
  state.tables = {
    email_flows: [{ id: "flow-a", tenant_id: A, active: true, exit_conditions: {} }],
    email_flow_blocks: [
      {
        id: "blk-1",
        flow_id: "flow-a",
        tenant_id: A,
        order_index: 0,
        block_type: "send_email",
        template_ids: [templateId],
        smtp_config_id: null,
        subject_override: null,
        delay_seconds: 0,
        send_at_hour: null,
      },
    ],
    email_templates: [
      { id: "tpl-a", tenant_id: A, subject: "Oi {nome}", body_html: "<p>{nome}</p>" },
      { id: "tpl-b", tenant_id: B, subject: "Segredo B", body_html: "<p>conteudo da casa B</p>" },
    ],
    players: [
      { id: "p-a", tenant_id: A, nome: "Ana", email: "ana@a.com" },
      { id: "p-b", tenant_id: B, nome: "Vitima de B", email: "vitima@b.com" },
    ],
    email_flow_leads: [
      {
        id: "lead-1",
        tenant_id: A,
        flow_id: "flow-a",
        player_id: playerId,
        email: "attacker@x.com",
        status: "running",
        current_block_index: 0,
        last_template_id: null,
        attempts: 0,
        entered_at: new Date().toISOString(),
      },
    ],
    email_flow_logs: [],
    email_send_logs: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("email flow dispatcher stays inside the lead's tenant", () => {
  it("does not load another tenant's template referenced by a block", async () => {
    seed("tpl-b", "p-a");
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(state.sends).toEqual([]);
    expect(state.tables.email_flow_leads[0].exit_reason).toBe("template_missing");
  });

  it("does not render another tenant's player into the e-mail", async () => {
    seed("tpl-a", "p-b");
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(state.sends).toHaveLength(1);
    expect(JSON.stringify(state.sends[0])).not.toContain("Vitima de B");
  });

  it("renders the lead's own player normally", async () => {
    seed("tpl-a", "p-a");
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].html).toContain("Ana");
  });

  it("writes every flow log with the lead's tenant", async () => {
    seed("tpl-a", "p-a");
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(state.tables.email_flow_logs.length).toBeGreaterThan(0);
    for (const log of state.tables.email_flow_logs) expect(log.tenant_id).toBe(A);
  });
});
