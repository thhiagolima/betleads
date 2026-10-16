// ENV-02 — "provider accepted -> commit failed -> retry" must not send or charge
// twice. Exercises the real sendSmsInternal against an in-memory stand-in for
// sms_send_logs and the SMS credit ledger (reserve/refund keep the production
// idempotency-key semantics of apply_sms_credit_mutation).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  smsLogs: [] as Row[],
  ledger: [] as Row[],
  failNextLogInsert: false,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Filter = (row: Row) => boolean;
  const tables: Record<string, () => Row[]> = {
    sms_send_logs: () => state.smsLogs,
    sms_credit_ledger: () => state.ledger,
    link_dispatches: () => [],
  };
  function from(table: string) {
    const filters: Filter[] = [];
    let insertRow: Row | null = null;
    const result = () => {
      if (insertRow) {
        if (table === "sms_send_logs" && state.failNextLogInsert) {
          state.failNextLogInsert = false;
          return { data: null, error: { message: "connection reset" } };
        }
        const row = { id: `log-${state.smsLogs.length + 1}`, ...insertRow };
        tables[table]().push(row);
        return { data: row, error: null };
      }
      return { data: tables[table]().filter((row) => filters.every((f) => f(row))), error: null };
    };
    const builder: any = {
      select: () => builder,
      update: () => builder,
      insert: (row: Row) => {
        insertRow = row;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      limit: () => builder,
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }
  function mutate(args: Row, delta: number, entryType: string) {
    const existing = state.ledger.find(
      (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
    );
    if (existing) return { data: { ok: true, idempotent: true }, error: null };
    state.ledger.push({
      tenant_id: args._tenant,
      idempotency_key: args._idempotency_key,
      reference_id: args._reference_id,
      delta_credits: delta,
      entry_type: entryType,
    });
    return { data: { ok: true, idempotent: false }, error: null };
  }
  async function rpc(fn: string, args: Row) {
    if (fn === "reserve_sms_credits") return mutate(args, -1, "sms_reservation");
    if (fn === "refund_sms_credits") return mutate(args, 1, "sms_refund");
    throw new Error(`unexpected rpc ${fn}`);
  }
  return { supabaseAdmin: { from, rpc } };
});

vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  // The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("./consent.server", () => ({ isChannelRevoked: vi.fn(async () => false) }));
vi.mock("./shortio.server", () => ({
  prepareTrackedText: vi.fn(async (content: string) => ({ content, links: [] })),
  markTrackedDispatchesSent: vi.fn(async () => undefined),
  markTrackedDispatchesFailed: vi.fn(async () => undefined),
}));

import {
  reserveSmsCreditForDelivery,
  sendSmsInternal,
  smsBillingReference,
} from "./sms.functions";

const TENANT = "00000000-0000-4000-8000-000000000001";
const KEY = "11111111-1111-4111-8111-111111111111";

function providerAccepts() {
  return vi.fn(async () =>
    new Response(JSON.stringify([{ external_id: KEY, status: "accepted" }]), { status: 200 }),
  );
}

function providerRejects() {
  return vi.fn(async () =>
    new Response(JSON.stringify([{ external_id: KEY, status: "rejected" }]), { status: 400 }),
  );
}

const send = () =>
  sendSmsInternal({
    to: "+5511999999999",
    content: "Oi",
    tenantId: TENANT,
    playerId: "00000000-0000-4000-8000-000000000101",
    deliveryKey: KEY,
  });

const charged = () =>
  state.ledger.reduce((sum, row) => sum - Number(row.delta_credits), 0);

describe("SMS delivery idempotency (ENV-02)", () => {
  beforeEach(() => {
    state.smsLogs.length = 0;
    state.ledger.length = 0;
    state.failNextLogInsert = false;
    process.env.SHORTCODE_SMS_TOKEN = "test-token";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.SHORTCODE_SMS_TOKEN;
  });

  it("derives a deterministic billing reference per delivery and generation", () => {
    expect(smsBillingReference(KEY, 0)).toBe(`delivery:${KEY}`);
    expect(smsBillingReference(KEY, 2)).toBe(`delivery:${KEY}:2`);
  });

  it("accepted -> commit failed -> retry: one provider call and one charge", async () => {
    const fetchMock = providerAccepts();
    vi.stubGlobal("fetch", fetchMock);

    const first = await send();
    expect(first.ok).toBe(true);
    // The journey worker crashes here (finishExecution/release failed) and retries.
    const retry = await send();

    expect(retry).toMatchObject({ ok: true, alreadySent: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(charged()).toBe(1);
    expect(state.smsLogs).toHaveLength(1);
  });

  it("accepted but the send log failed: the retry reuses the same charge", async () => {
    const fetchMock = providerAccepts();
    vi.stubGlobal("fetch", fetchMock);
    state.failNextLogInsert = true;

    await expect(send()).rejects.toThrow(/Falha ao registrar envio SMS/);
    const retry = await send();

    expect(retry.ok).toBe(true);
    // Nothing local proves the first acceptance, so the provider is called again
    // with the same external_id, but billing stays at a single credit.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(body[0].external_id).toBe(KEY);
    expect(charged()).toBe(1);
    expect(state.ledger.map((row) => row.idempotency_key)).toEqual([
      `sms-reserve:delivery:${KEY}`,
    ]);
  });

  it("rejected and refunded: the retry is charged again under the next generation", async () => {
    vi.stubGlobal("fetch", providerRejects());
    const first = await send();
    expect(first.ok).toBe(false);
    expect(charged()).toBe(0);

    const fetchMock = providerAccepts();
    vi.stubGlobal("fetch", fetchMock);
    const retry = await send();

    expect(retry.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(charged()).toBe(1);
    expect(state.ledger.map((row) => row.idempotency_key)).toEqual([
      `sms-reserve:delivery:${KEY}`,
      `sms-refund:delivery:${KEY}`,
      `sms-reserve:delivery:${KEY}:1`,
    ]);
  });

  it("without a delivery key every reservation is a new charge (campaigns unchanged)", async () => {
    const a = await reserveSmsCreditForDelivery(TENANT, null);
    const b = await reserveSmsCreditForDelivery(TENANT, undefined);
    expect(a.ok && b.ok).toBe(true);
    expect(a.referenceId).not.toBe(b.referenceId);
    expect(charged()).toBe(2);
  });

  it("reuses a non-refunded reservation for the same delivery key", async () => {
    const a = await reserveSmsCreditForDelivery(TENANT, KEY);
    const b = await reserveSmsCreditForDelivery(TENANT, KEY);
    expect(a).toEqual({ ok: true, referenceId: `delivery:${KEY}` });
    expect(b).toEqual(a);
    expect(charged()).toBe(1);
  });

  it("B1: a timeout/reset after sending is NOT retried and comes back as outcome_unknown", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await send();
    expect(fetchMock).toHaveBeenCalledOnce(); // never resent inside callShortBrasil
    expect(result).toMatchObject({ ok: false, status: 0, errorKind: "outcome_unknown" });
  });

  it("B1: a request that never left (ECONNREFUSED) is retried and reported as not_sent", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await send();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, status: 0, errorKind: "not_sent" });
  }, 10_000);

  it("B1: missing credentials are reported as misconfigured without calling the provider", async () => {
    delete process.env.SHORTCODE_SMS_TOKEN;
    vi.stubEnv("SHORT_BRASIL_SMS_USUARIO", "");
    vi.stubEnv("SHORT_BRASIL_SMS_CHAVE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await send();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorKind: "misconfigured" });
  });
});
