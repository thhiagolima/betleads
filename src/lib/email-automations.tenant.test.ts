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

vi.mock("./email-send.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-send.server")>()),
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
vi.mock("./dispatch-pause-insufficient.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatch-pause-insufficient.server")>()),
  pauseChannelForInsufficientFunds: vi.fn(async () => undefined),
}));

import { runEmailFlowDispatcher } from "./email-automations.server";
import { resolveSender, sendInfobipEmail } from "./email-send.server";
import { pauseChannelForInsufficientFunds } from "./dispatch-pause-insufficient.server";
import { registerThrottle } from "./dispatch-rate.server";

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

describe("email flow sender", () => {
  it("passes the block's sender_id and fails the lead without a verified sender", async () => {
    seed("tpl-a", "p-a");
    state.tables.email_flow_blocks[0].sender_id = "sender-1";
    state.tables.email_flow_blocks[0].smtp_config_id = "smtp-1";
    vi.mocked(resolveSender).mockResolvedValueOnce(null);
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(resolveSender).toHaveBeenCalledWith({ tenantId: A, senderId: "sender-1" });
    expect(state.sends).toEqual([]);
    expect(state.tables.email_send_logs).toHaveLength(0);
    expect(state.tables.email_flow_leads[0]).toMatchObject({
      status: "failed",
      exit_reason: "EMAIL_DOMAIN_NOT_VERIFIED",
    });
    expect(state.tables.email_flow_logs.at(-1)).toMatchObject({ event: "failed" });
    expect(JSON.stringify(state.tables.email_flow_logs.at(-1))).toContain(
      "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
    );
  });

  it("sends from the block's sender_id when it resolves", async () => {
    seed("tpl-a", "p-a");
    state.tables.email_flow_blocks[0].sender_id = "sender-1";
    state.tables.email_flow_blocks[0].smtp_config_id = "smtp-1";
    vi.mocked(resolveSender).mockResolvedValueOnce({
      fromEmail: "promo@mail.casa.bet",
      fromName: "Promo",
      replyTo: null,
      senderId: "sender-1",
    });
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(resolveSender).toHaveBeenCalledWith({ tenantId: A, senderId: "sender-1" });
    expect(vi.mocked(sendInfobipEmail).mock.calls[0]?.[0]).toMatchObject({
      from: "promo@mail.casa.bet",
      fromName: "Promo",
    });
  });
});

describe("email flow dispatcher — wallet refusal stays per-house (PG3 Task 1 fix round 1 / I3)", () => {
  it("reschedules the lead 15 min out, no attempt consumed, no global pause or throttle", async () => {
    seed("tpl-a", "p-a");
    vi.mocked(sendInfobipEmail).mockResolvedValueOnce({
      ok: false,
      status: 402,
      body: { error: "Saldo insuficiente" },
      idempotencyKey: "k",
      temporary: false,
      errorKind: "insufficient_balance",
    } as any);
    const before = Date.now();
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(pauseChannelForInsufficientFunds).not.toHaveBeenCalled();
    expect(registerThrottle).not.toHaveBeenCalled();
    const lead = state.tables.email_flow_leads[0];
    expect(lead.status).toBe("running");
    expect(lead.attempts).toBe(0);
    expect(Date.parse(String(lead.next_run_at))).toBeGreaterThanOrEqual(
      before + 15 * 60_000 - 1_000,
    );
    // PG3 Task 6: nothing was sent nor charged, so no email_send_logs row;
    // the flow log records the skip and its reason.
    expect(state.tables.email_send_logs).toHaveLength(0);
    expect(state.tables.email_flow_logs.at(-1)).toMatchObject({
      event: "skipped_insufficient_balance",
      detail: { reason: "saldo_insuficiente" },
    });
  });

  it("a real provider 402 (no errorKind) still pauses the channel globally", async () => {
    seed("tpl-a", "p-a");
    vi.mocked(sendInfobipEmail).mockResolvedValueOnce({
      ok: false,
      status: 402,
      body: { error: "INSUFFICIENT_FUNDS" },
      idempotencyKey: "k",
      temporary: false,
    } as any);
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(pauseChannelForInsufficientFunds).toHaveBeenCalledTimes(1);
    expect(pauseChannelForInsufficientFunds).toHaveBeenCalledWith("email", expect.any(String));
  });
});

describe("email flow dispatcher — billing columns (PG3 Task 6)", () => {
  it("logs the wallet reference and the amount charged for the e-mail", async () => {
    seed("tpl-a", "p-a");
    vi.mocked(sendInfobipEmail).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {},
      idempotencyKey: "k-1",
      temporary: false,
      billing: { referenceId: "email:k-1", amount: 0.002 },
    } as any);
    await runEmailFlowDispatcher({ onlyLeadId: "lead-1" });
    expect(state.tables.email_send_logs).toHaveLength(1);
    expect(state.tables.email_send_logs[0]).toMatchObject({
      status: "sent",
      billing_reference_id: "email:k-1",
      billed_amount: 0.002,
    });
  });
});
