// PG3 Task 4 — call flow call blocks and the wallet reservation.
//
// The block's max_call_seconds sizes the reservation; a call refused by the
// house's wallet is skipped (call_skipped / saldo_insuficiente) and the flow
// moves on; a placed call persists its billing reference on call_history.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const voice = vi.hoisted(() => ({ callInfobipVoice: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./infobip-voice.server", () => ({
  callInfobipVoice: voice.callInfobipVoice,
  normalizeE164BR: (raw: string) => raw,
}));
vi.mock("./sms.functions", () => ({ sendSmsInternal: vi.fn() }));
vi.mock("./consent.server", () => ({
  evaluateVoiceContactPolicy: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("./send-window.server", () => ({ deferIfOutsideWindow: vi.fn(async () => null) }));
vi.mock("./tenant-access.server", () => ({ listDemoTenantIds: vi.fn(async () => []) }));

import { advanceProgress } from "./call-flows.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

function seed() {
  fake.db.rows("call_flows").push({ id: "flow-1", tenant_id: TENANT, is_active: true });
  fake.db.rows("call_scripts").push({ id: "script-1", tenant_id: TENANT, content: "Oi {primeiro_nome}" });
  fake.db.rows("players").push({ id: "p1", tenant_id: TENANT, nome: "Ana", telefone: "+5511999990001" });
  fake.db.rows("call_flow_blocks").push(
    {
      id: "b0",
      flow_id: "flow-1",
      order_index: 0,
      block_type: "call",
      script_id: "script-1",
      max_call_seconds: 45,
      delay_after_seconds: 0,
    },
    { id: "b1", flow_id: "flow-1", order_index: 1, block_type: "delay", delay_seconds: 60 },
  );
  fake.db.rows("call_flow_progress").push({
    id: "prog-1",
    flow_id: "flow-1",
    player_id: "p1",
    tenant_id: TENANT,
    status: "active",
    current_block_index: 0,
    attempts_on_block: 0,
    phone_e164: "+5511999990001",
  });
}

const progress = () => fake.db.rows("call_flow_progress")[0];
const history = () => fake.db.rows("call_flow_history");

beforeEach(() => {
  fake.db.reset();
  voice.callInfobipVoice.mockReset();
  seed();
});

describe("call flow call block wallet reservation", () => {
  it("sizes the reservation by the block's max_call_seconds and stores billing_reference_id", async () => {
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 2 },
    });
    await advanceProgress("prog-1");
    expect(voice.callInfobipVoice).toHaveBeenCalledWith(
      "+5511999990001",
      expect.objectContaining({ type: "tts" }),
      expect.objectContaining({ tenantId: TENANT, maxSeconds: 45 }),
    );
    expect(fake.db.rows("call_history")).toEqual([
      expect.objectContaining({ billing_reference_id: "voice:key-1", tenant_id: TENANT }),
    ]);
    expect(progress()).toMatchObject({ status: "waiting" });
  });

  it("without balance: logs call_skipped saldo_insuficiente and schedules the next block", async () => {
    voice.callInfobipVoice.mockResolvedValue({
      ok: false,
      status: 0,
      body: { error: "Saldo insuficiente" },
      idempotencyKey: "key-1",
      providerCallId: null,
      errorKind: "insufficient_balance",
    });
    await advanceProgress("prog-1");
    expect(history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "call_skipped",
          detail: expect.objectContaining({ reason: "saldo_insuficiente" }),
        }),
        expect.objectContaining({ event_type: "advanced" }),
      ]),
    );
    expect(history().some((row) => row.event_type === "call_dispatched")).toBe(false);
    expect(fake.db.rows("call_history")).toEqual([]);
    expect(progress()).toMatchObject({ status: "active", current_block_index: 1, attempts_on_block: 0 });
  });

  it("a failed call_history insert is logged with the reference and correlation; the call still counts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    voice.callInfobipVoice.mockResolvedValue({
      ok: true,
      status: 200,
      body: { callId: "call-1" },
      idempotencyKey: "key-1",
      providerCallId: "call-1",
      billing: { referenceId: "voice:key-1", units: 2 },
    });
    fake.db.failNext("call_history", "insert", "insert failed");
    await advanceProgress("prog-1");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("call_history"),
      expect.objectContaining({ referenceId: "voice:key-1", correlationId: "key-1" }),
    );
    expect(progress()).toMatchObject({ status: "waiting" });
    consoleError.mockRestore();
  });
});
