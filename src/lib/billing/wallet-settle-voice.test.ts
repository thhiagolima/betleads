// PG3 Task 5 — settleVoiceCall: the TS wrapper over wallet_settle_voice.
// The SQL semantics (blocks, cap, unanswered rule, idempotent replay) are
// covered by billing-wallet-settle.db.test.ts; here: the key, the tenant and
// reference_type guard (addendum c) and how each refusal is reported.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleVoiceCall, voiceSettleKey } from "./wallet.server";

type Row = Record<string, unknown>;

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const REF = "voice:key-1";

function makeClient(ledger: Row[], rpcResult: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => rpcResult);
  function from(table: string) {
    if (table !== "wallet_ledger") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: async () => ({ data: ledger.filter((row) => filters.every((f) => f(row))), error: null }),
    };
    return builder;
  }
  return { client: { rpc, from }, rpc };
}

const reservation = (overrides: Row = {}): Row => ({
  tenant_id: TENANT,
  reference_id: REF,
  entry_type: "usage_reservation",
  reference_type: "voice_call",
  item: "voice_30s",
  ...overrides,
});

const settled = {
  ok: true,
  idempotent: false,
  ledger_id: "l-2",
  amount: 0.27,
  balance: 9.82,
  billed_units: 2,
  billed_amount: 0.18,
  blocks: 2,
};

describe("settleVoiceCall", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls wallet_settle_voice with the voice-settle key and maps the result", async () => {
    const { client, rpc } = makeClient([reservation()], { data: settled, error: null });
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: 45,
      answered: true,
    });
    expect(voiceSettleKey(REF)).toBe("voice-settle:voice:key-1");
    expect(rpc).toHaveBeenCalledWith("wallet_settle_voice", {
      _tenant: TENANT,
      _reference_id: REF,
      _duration_seconds: 45,
      _answered: true,
      _idempotency_key: "voice-settle:voice:key-1",
    });
    expect(result).toEqual({
      ok: true,
      idempotent: false,
      blocks: 2,
      billedAmount: 0.18,
      amount: 0.27,
      balance: 9.82,
    });
  });

  it("answered with no duration passes null so the SQL keeps the cap", async () => {
    const { client, rpc } = makeClient([reservation()], {
      data: { ...settled, blocks: 5, billed_units: 5, billed_amount: 0.45, amount: 0 },
      error: null,
    });
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: null,
      answered: true,
    });
    expect(rpc).toHaveBeenCalledWith(
      "wallet_settle_voice",
      expect.objectContaining({ _duration_seconds: null, _answered: true }),
    );
    expect(result).toMatchObject({ ok: true, blocks: 5, billedAmount: 0.45 });
  });

  it("refuses a reference owned by another house without calling the RPC", async () => {
    const { client, rpc } = makeClient([reservation({ tenant_id: OTHER })], {
      data: settled,
      error: null,
    });
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: 10,
      answered: true,
    });
    expect(result).toEqual({ ok: false, reason: "reservation_not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a reservation that is not a voice call", async () => {
    const { client, rpc } = makeClient(
      [reservation({ reference_type: "sms_send", item: "sms" })],
      { data: settled, error: null },
    );
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: 10,
      answered: true,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_reference_type" });
    expect(rpc).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("already_reversed (refunded on a timeout) is logged at info level, never as an error", async () => {
    const { client } = makeClient([reservation()], {
      data: { ok: false, reason: "already_reversed" },
      error: null,
    });
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: 30,
      answered: true,
    });
    expect(result).toEqual({ ok: false, reason: "already_reversed" });
    expect(console.info).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("idempotency_key_conflict is logged as a programming error", async () => {
    const { client } = makeClient([reservation()], {
      data: { ok: false, reason: "idempotency_key_conflict" },
      error: null,
    });
    const result = await settleVoiceCall(client, {
      tenantId: TENANT,
      referenceId: REF,
      durationSeconds: 30,
      answered: true,
    });
    expect(result).toEqual({ ok: false, reason: "idempotency_key_conflict" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("erro de programação"),
      expect.objectContaining({ referenceId: REF }),
    );
  });

  it("throws on an RPC error (invalid_item, DB down) so the caller decides", async () => {
    const { client } = makeClient([reservation()], {
      data: null,
      error: { message: "invalid_item" },
    });
    await expect(
      settleVoiceCall(client, { tenantId: TENANT, referenceId: REF, durationSeconds: 1, answered: true }),
    ).rejects.toThrow("invalid_item");
  });
});
