import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processWebhookEvent: vi.fn(),
  getServiceClient: vi.fn(),
  startJobRun: vi.fn(),
  pingHeartbeat: vi.fn(async () => undefined),
  run: {
    progress: vi.fn(),
    finish: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/cron-auth.server", () => ({ requireSharedSecret: vi.fn() }));
vi.mock("@/lib/webhook-process.server", () => ({
  getServiceClient: mocks.getServiceClient,
  processWebhookEvent: mocks.processWebhookEvent,
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({
  startJobRun: mocks.startJobRun,
  pingHeartbeat: mocks.pingHeartbeat,
}));

import { Route } from "./webhook-replay";

type PostHandler = (input: { request: Request }) => Promise<Response>;
const post = (Route as unknown as { options: { server: { handlers: { POST: PostHandler } } } })
  .options.server.handlers.POST;

type Update = { table: string; payload: Record<string, unknown>; id: unknown };

function fakeSb(rpcResult: { data?: unknown; error?: unknown }, legacyRows: unknown[] = []) {
  const updates: Update[] = [];
  const legacyFilters: unknown[][] = [];
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: null,
    error: null,
    ...rpcResult,
  }));
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    builder.update = (payload: Record<string, unknown>) => ({
      eq: async (_col: string, id: unknown) => {
        updates.push({ table, payload, id });
        return { error: null };
      },
    });
    for (const m of ["select", "order", "limit", "in", "eq"]) {
      builder[m] = (...args: unknown[]) => {
        legacyFilters.push([m, ...args]);
        return builder;
      };
    }
    builder.then = (ok: (v: unknown) => unknown) => ok({ data: legacyRows, error: null });
    return builder;
  };
  return { sb: { rpc, from }, rpc, updates, legacyFilters };
}

const request = (body: Record<string, unknown> = {}) =>
  new Request("https://betleads.io/api/public/hooks/webhook-replay", {
    method: "POST",
    body: JSON.stringify(body),
  });

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: "t-1",
  evento: "deposito-aprovado",
  payload: { eventId: id },
  replay_attempts: 1,
  action: "replay",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startJobRun.mockResolvedValue(mocks.run);
});

describe("webhook replay (CON-03)", () => {
  it("claims through the RPC with filters and maps the legacy body fields", async () => {
    const { sb, rpc } = fakeSb({ data: [] });
    mocks.getServiceClient.mockReturnValue(sb);
    const res = await post({
      request: request({
        limit: 50,
        tenant_id: "t-9",
        evento: "login",
        status: "erro",
        per_tenant: 3,
      }),
    });
    expect(rpc).toHaveBeenCalledWith("claim_webhook_logs_for_replay", {
      p_limit: 20,
      p_dry_run: false,
      p_statuses: ["erro"],
      p_tenant_id: "t-9",
      p_evento: "login",
      p_per_tenant: 3,
    });
    expect(await res.json()).toEqual({
      ok: true,
      dry_run: false,
      limit: 20,
      has_more: false,
      scanned: 0,
      processed: 0,
      failed: 0,
      dead_lettered: 0,
      deferred: 0,
    });
    expect(mocks.pingHeartbeat).toHaveBeenCalledWith("webhook_replay", true);
    expect(mocks.startJobRun).not.toHaveBeenCalled();
  });

  it("default status claims the pending set (no p_statuses override)", async () => {
    const { sb, rpc } = fakeSb({ data: [] });
    mocks.getServiceClient.mockReturnValue(sb);
    await post({ request: request() });
    expect(rpc.mock.calls[0][1]).toEqual({ p_limit: 20, p_dry_run: false });
  });

  it("a poison row does not block the rows after it; its error is recorded", async () => {
    const rows = [row("poison"), row("ok-1"), row("ok-2")];
    const { sb, updates } = fakeSb({ data: rows });
    mocks.getServiceClient.mockReturnValue(sb);
    mocks.processWebhookEvent.mockImplementation(async (_sb, _t, _e, payload) =>
      payload.eventId === "poison"
        ? Response.json({ ok: false, error: "record_financial_transaction failed" })
        : Response.json({ ok: true }),
    );
    const body = await (await post({ request: request() })).json();
    expect(body).toMatchObject({
      processed: 2,
      failed: 1,
      dead_lettered: 0,
      deferred: 0,
      scanned: 3,
    });
    expect(mocks.processWebhookEvent).toHaveBeenCalledTimes(3);
    expect(mocks.processWebhookEvent.mock.calls[0][4]).toEqual({
      mirror: true,
      existingLogId: "poison",
    });
    expect(updates).toEqual([
      {
        table: "webhook_logs",
        payload: { last_replay_error: "record_financial_transaction failed" },
        id: "poison",
      },
    ]);
    expect(mocks.run.finish).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 2, errors: 1, claimed: 3, stop_reason: "drained" }),
    );
  });

  it("does not process dead-lettered rows and reports them", async () => {
    const rows = [
      row("dead", { action: "dead_lettered", payload: null, replay_attempts: 5 }),
      row("ok"),
    ];
    const { sb } = fakeSb({ data: rows });
    mocks.getServiceClient.mockReturnValue(sb);
    mocks.processWebhookEvent.mockImplementation(async () => Response.json({ ok: true }));
    const body = await (await post({ request: request() })).json();
    expect(body).toMatchObject({ scanned: 2, processed: 1, failed: 0, dead_lettered: 1 });
    expect(mocks.processWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mocks.run.finish).toHaveBeenCalledWith(
      expect.objectContaining({ errors: 1, claimed: 1, queue_before: 2 }),
    );
  });

  it("an in-progress event (202) is deferred without consuming a replay attempt", async () => {
    const { sb, updates } = fakeSb({ data: [row("busy", { replay_attempts: 3 })] });
    mocks.getServiceClient.mockReturnValue(sb);
    mocks.processWebhookEvent.mockResolvedValue(
      Response.json({ ok: true, in_progress: true, retry_after: 300 }, { status: 202 }),
    );
    const body = await (await post({ request: request() })).json();
    expect(body).toMatchObject({ processed: 0, failed: 0, deferred: 1 });
    expect(updates).toEqual([
      { table: "webhook_logs", payload: { replay_attempts: 2 }, id: "busy" },
    ]);
    expect(mocks.run.finish).toHaveBeenCalledWith(
      expect.objectContaining({ rescheduled: 1, errors: 0 }),
    );
  });

  it("reports has_more when the claimed batch fills the limit", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => row(`r${i}`));
    const { sb } = fakeSb({ data: rows });
    mocks.getServiceClient.mockReturnValue(sb);
    mocks.processWebhookEvent.mockImplementation(async () => Response.json({ ok: true }));
    const body = await (await post({ request: request({ limit: 2 }) })).json();
    expect(body).toMatchObject({ has_more: true, processed: 2 });
  });

  it("dry run lists candidates through the RPC without processing or job rows", async () => {
    const rows = [
      row("a", { action: "candidate", payload: null }),
      row("b", { action: "would_dead_letter", payload: null, evento: "login", replay_attempts: 5 }),
    ];
    const { sb, rpc } = fakeSb({ data: rows });
    mocks.getServiceClient.mockReturnValue(sb);
    const body = await (await post({ request: request({ dry_run: true, limit: 5 }) })).json();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_dry_run: true, p_limit: 5 });
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      limit: 5,
      has_more: false,
      scanned: 2,
      would_dead_letter: 1,
      by_event: { "deposito-aprovado": 1, login: 1 },
    });
    expect(body.sample[1]).toEqual({
      id: "b",
      tenant_id: "t-1",
      evento: "login",
      replay_attempts: 5,
    });
    expect(mocks.processWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.startJobRun).not.toHaveBeenCalled();
  });

  it("returns 500 and records a failed run when the claim fails", async () => {
    const { sb } = fakeSb({ error: { code: "57014", message: "statement timeout" } });
    mocks.getServiceClient.mockReturnValue(sb);
    const res = await post({ request: request() });
    expect(res.status).toBe(500);
    expect(mocks.run.fail).toHaveBeenCalled();
    expect(mocks.processWebhookEvent).not.toHaveBeenCalled();
  });

  it("falls back to the legacy select when the RPC is not deployed yet", async () => {
    const legacy = [{ id: "l1", tenant_id: "t-1", evento: "login", payload: {} }];
    const { sb, updates, legacyFilters } = fakeSb(
      { error: { code: "PGRST202", message: "Could not find the function" } },
      legacy,
    );
    mocks.getServiceClient.mockReturnValue(sb);
    mocks.processWebhookEvent.mockResolvedValue(Response.json({ ok: false, error: "x" }));
    const body = await (await post({ request: request({ tenant_id: "t-1" }) })).json();
    expect(body).toMatchObject({ ok: true, scanned: 1, failed: 1 });
    expect(legacyFilters).toContainEqual(["in", "status", ["recebido", "erro"]]);
    expect(legacyFilters).toContainEqual(["eq", "tenant_id", "t-1"]);
    // Legacy DB has no last_replay_error column: no write attempted.
    expect(updates).toEqual([]);
  });
});
