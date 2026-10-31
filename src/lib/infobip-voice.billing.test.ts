// PG3 Task 4 — callInfobipVoice reserves voice blocks before dialing.
//
// Runs the real send guard and the real reserveForDelivery against an
// in-memory database (wallet_reserve/wallet_refund stand-ins from
// installCreditLedger) and a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { callInfobipVoice, voiceReservationUnits } from "./infobip-voice.server";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const LOCKED = "00000000-0000-4000-8000-000000000003";

let fetchMock: ReturnType<typeof vi.fn>;
let wallet: ReturnType<typeof installCreditLedger>;
let balanceUnits: number;

const content = { type: "tts" as const, text: "Oi", language: "pt" };

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  fake.db.rows("tenants").push(
    { id: NORMAL, status: "active", is_demo: false },
    { id: DEMO, status: "active", is_demo: true },
    { id: LOCKED, status: "active", is_demo: false, tenant_billing: { access_state: "frozen" } },
  );
  balanceUnits = 1000;
  wallet = installCreditLedger(fake.db, { balance: () => balanceUnits });
  vi.stubEnv("INFOBIP_BASE_URL", "https://infobip.example");
  vi.stubEnv("INFOBIP_API_KEY", "infobip-test-key");
  vi.stubEnv("INFOBIP_VOICE_FROM", "+551130000000");
  vi.stubEnv("INFOBIP_VOICE_CALLBACK_TOKEN", "callback-token");
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example.test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchMock = vi.fn(async () => Response.json({ callId: "call-1" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reservations = () =>
  wallet.ledger().filter((row) => row.entry_type === "usage_reservation");
const refunds = () => wallet.ledger().filter((row) => row.entry_type === "usage_refund");

describe("voiceReservationUnits", () => {
  it("reserves ceil((maxSeconds + 10) / 30) blocks", () => {
    expect(voiceReservationUnits(120)).toBe(5);
    expect(voiceReservationUnits(20)).toBe(1);
    expect(voiceReservationUnits(21)).toBe(2);
    expect(voiceReservationUnits(60)).toBe(3);
  });

  it("falls back to VOICE_MAX_CALL_SECONDS, then 120, for a missing or invalid cap", () => {
    expect(voiceReservationUnits(null)).toBe(5);
    expect(voiceReservationUnits(0)).toBe(5);
    vi.stubEnv("VOICE_MAX_CALL_SECONDS", "50");
    expect(voiceReservationUnits(undefined)).toBe(2);
    vi.stubEnv("VOICE_MAX_CALL_SECONDS", "lixo");
    expect(voiceReservationUnits(undefined)).toBe(5);
  });
});

describe("callInfobipVoice wallet reservation", () => {
  it("reserves voice_30s blocks under the voice keys before dialing and returns billing", async () => {
    const result = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      idempotencyKey: "journey-key-1",
      maxSeconds: 60,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reservations()).toHaveLength(1);
    expect(reservations()[0]).toMatchObject({
      tenant_id: NORMAL,
      units: 3,
      reference_id: "voice:journey-key-1",
      idempotency_key: "voice-reserve:voice:journey-key-1",
    });
    expect(result.billing).toEqual({ referenceId: "voice:journey-key-1", units: 3 });
    expect(refunds()).toHaveLength(0);
  });

  it("passes item voice_30s and reference type voice_call to wallet_reserve", async () => {
    const seen: Array<Record<string, unknown>> = [];
    fake.db.onRpc("wallet_reserve", (args) => {
      seen.push(args);
      return { data: { ok: true, idempotent: false, amount: -0.45 }, error: null };
    });
    await callInfobipVoice("+5511999999999", content, { tenantId: NORMAL });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ _item: "voice_30s", _reference_type: "voice_call", _units: 5 });
  });

  it("without balance: does not dial and returns insufficient_balance", async () => {
    balanceUnits = 0;
    const result = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      idempotencyKey: "journey-key-2",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 0, errorKind: "insufficient_balance" });
    expect(result.billing).toBeUndefined();
  });

  it("refunds the reservation when Infobip answers 4xx", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "bad request" }, { status: 400 }));
    const result = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      idempotencyKey: "journey-key-3",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(reservations()).toHaveLength(1);
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toMatchObject({
      reference_id: "voice:journey-key-3",
      idempotency_key: "voice-refund:voice:journey-key-3",
    });
    expect(wallet.charged()).toBe(0);
  });

  it("refunds the reservation on a transport error (timeout)", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const result = await callInfobipVoice("+5511999999999", content, { tenantId: NORMAL });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(refunds()).toHaveLength(1);
    expect(wallet.charged()).toBe(0);
  });

  it("a journey retry after a refunded failure reserves a new generation", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503 }));
    const first = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      idempotencyKey: "journey-key-4",
    });
    expect(first.ok).toBe(false);
    const retry = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      idempotencyKey: "journey-key-4",
    });
    expect(retry.ok).toBe(true);
    expect(retry.billing?.referenceId).toBe("voice:journey-key-4:1");
    expect(reservations().map((row) => row.reference_id)).toEqual([
      "voice:journey-key-4",
      "voice:journey-key-4:1",
    ]);
    expect(wallet.charged()).toBe(5);
  });

  it("billingKey keys the reservation while each dial keeps a fresh correlation", async () => {
    const first = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      billingKey: "queue-1",
    });
    // A duplicate dispatch of the same queue item: same reservation, no
    // second charge.
    const duplicate = await callInfobipVoice("+5511999999999", content, {
      tenantId: NORMAL,
      billingKey: "queue-1",
    });
    expect(first.billing?.referenceId).toBe("voice:queue-1");
    expect(duplicate.billing?.referenceId).toBe("voice:queue-1");
    expect(first.idempotencyKey).not.toBe(duplicate.idempotencyKey);
    expect(reservations().map((row) => row.reference_id)).toEqual(["voice:queue-1"]);
    expect(wallet.charged()).toBe(5);
  });

  it("a demo house never reserves", async () => {
    await expect(
      callInfobipVoice("+5511999999999", content, { tenantId: DEMO }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(wallet.ledger()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a locked house never reserves", async () => {
    await expect(callInfobipVoice("+5511999999999", content, { tenantId: LOCKED })).rejects.toThrow();
    expect(wallet.ledger()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
