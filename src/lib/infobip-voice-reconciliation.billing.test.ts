// PG3 Task 5 — the 24 h reconciliation settles voice reservations whose
// final event never came. It is keyed by the LEDGER (addendum b): every
// `voice_call` usage_reservation older than 24 h without a reversing
// usage_refund, whether or not a call_history row exists for it.
//   * call_history 'pending' (the CML was never fetched) -> unanswered;
//   * call_history 'answered' (CML fetched, no final event) -> keep the cap;
//   * no call_history row (insert failed) -> unanswered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const wallet = vi.hoisted(() => ({ settleVoiceCall: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./billing/wallet.server", () => ({ settleVoiceCall: wallet.settleVoiceCall }));
vi.mock("./tenant-access.server", () => ({ listDemoTenantIds: vi.fn(async () => []) }));

import { settleStaleVoiceReservations } from "./infobip-voice-reconciliation.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const DEMO = "00000000-0000-4000-8000-00000000d0d0";
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000).toISOString();

let seq = 0;
function reservation(ref: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const row = {
    id: `res-${String(seq).padStart(4, "0")}`,
    tenant_id: TENANT,
    entry_type: "usage_reservation",
    reference_type: "voice_call",
    item: "voice_30s",
    reference_id: ref,
    units: 5,
    created_at: hoursAgo(30),
    ...overrides,
  };
  fake.db.rows("wallet_ledger").push(row);
  return row;
}

function history(ref: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: `hist-${ref}`,
    tenant_id: TENANT,
    billing_reference_id: ref,
    status: "pending",
    result: null,
    duration_seconds: null,
    provider_response: {},
    billing_settled_at: null,
    created_at: hoursAgo(30),
    ...overrides,
  };
  fake.db.rows("call_history").push(row);
  return row;
}

const settled = (blocks: number, billedAmount: number) => ({
  ok: true,
  idempotent: false,
  blocks,
  billedAmount,
  amount: 0.45 - billedAmount,
  balance: 10,
});

beforeEach(() => {
  fake.db.reset();
  seq = 0;
  wallet.settleVoiceCall.mockReset();
  wallet.settleVoiceCall.mockResolvedValue(settled(0, 0));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("settleStaleVoiceReservations", () => {
  it("pending call (CML never fetched): settles as unanswered and records the bill", async () => {
    reservation("voice:pending");
    const row = history("voice:pending", { status: "pending" });
    const result = await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledTimes(1);
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      referenceId: "voice:pending",
      durationSeconds: null,
      answered: false,
    });
    expect(row).toMatchObject({ billed_blocks: 0, billed_amount: 0 });
    expect(row.billing_settled_at).toEqual(expect.any(String));
    expect(result).toMatchObject({ checked: 1, settled: 1, failed: 0 });
  });

  it("answered call (CML fetched, no final event): keeps the cap", async () => {
    reservation("voice:answered");
    const row = history("voice:answered", { status: "answered" });
    wallet.settleVoiceCall.mockResolvedValue(settled(5, 0.45));
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      referenceId: "voice:answered",
      durationSeconds: null,
      answered: true,
    });
    expect(row).toMatchObject({ billed_blocks: 5, billed_amount: 0.45 });
  });

  it("no call_history row (its insert failed): settles as unanswered", async () => {
    reservation("voice:orphan");
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      referenceId: "voice:orphan",
      durationSeconds: null,
      answered: false,
    });
  });

  it("a row of another house with the same reference is never used", async () => {
    reservation("voice:shared");
    history("voice:shared", { tenant_id: OTHER, status: "answered" });
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT, answered: false }),
    );
  });

  it("final event processed but not settled: uses the recorded duration and answer", async () => {
    reservation("voice:final");
    history("voice:final", {
      status: "completed",
      result: "completed",
      duration_seconds: 40,
      provider_response: { callbacks: [{ type: "cml_answered" }] },
    });
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      referenceId: "voice:final",
      durationSeconds: 40,
      answered: true,
    });
  });

  it("final event processed: a completed call with a duration but no CML record is answered", async () => {
    reservation("voice:final-dur");
    history("voice:final-dur", { status: "completed", result: "completed", duration_seconds: 50 });
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answered: true, durationSeconds: 50 }),
    );
  });

  it("final event processed: busy with a duration stays unanswered", async () => {
    reservation("voice:final-busy");
    history("voice:final-busy", { status: "failed", result: "busy", duration_seconds: 12 });
    await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answered: false }),
    );
  });

  it("skips reservations already reversed, younger than 24 h, of other items, or of demo houses", async () => {
    const refunded = reservation("voice:refunded");
    fake.db.rows("wallet_ledger").push({
      id: "refund-1",
      tenant_id: TENANT,
      entry_type: "usage_refund",
      reference_type: "voice_call",
      reference_id: "voice:refunded",
      reverses_ledger_id: refunded.id,
      created_at: hoursAgo(29),
    });
    reservation("voice:young", { created_at: hoursAgo(2) });
    reservation("delivery:sms", { reference_type: "sms_send", item: "sms" });
    reservation("voice:demo", { tenant_id: DEMO });

    const result = await settleStaleVoiceReservations([DEMO]);
    expect(wallet.settleVoiceCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, settled: 0 });
  });

  it("paginates through every stale reservation", async () => {
    for (let i = 0; i < 7; i++) reservation(`voice:page-${i}`);
    const result = await settleStaleVoiceReservations([], { pageSize: 3 });
    expect(wallet.settleVoiceCall).toHaveBeenCalledTimes(7);
    const refs = wallet.settleVoiceCall.mock.calls.map((call) => call[1].referenceId).sort();
    expect(refs).toEqual(Array.from({ length: 7 }, (_, i) => `voice:page-${i}`).sort());
    expect(result).toMatchObject({ checked: 7, settled: 7 });
  });

  it("a refused or failed settlement is counted and never stops the run", async () => {
    reservation("voice:a");
    reservation("voice:b");
    reservation("voice:c");
    wallet.settleVoiceCall
      .mockResolvedValueOnce({ ok: false, reason: "already_reversed" })
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(settled(0, 0));
    const result = await settleStaleVoiceReservations();
    expect(wallet.settleVoiceCall).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ checked: 3, settled: 1, skipped: 1, failed: 1 });
  });
});
