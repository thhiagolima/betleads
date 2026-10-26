import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { confirmChargeFromUpper } = vi.hoisted(() => ({ confirmChargeFromUpper: vi.fn() }));
vi.mock("@/lib/billing/payment-charges.server", () => ({ confirmChargeFromUpper }));

const { recordBillingSignal } = vi.hoisted(() => ({
  recordBillingSignal: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/billing-signals.server", () => ({ recordBillingSignal }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { Route } from "./upper/webhook";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const SECRET = "whsec-upper-route-test-0123456789";
const URL = "https://app.example.test/api/public/upper/webhook";

function sign(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST({
    request: new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  });
}

function signedPost(bodyObj: unknown, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(bodyObj);
  const now = Math.floor(Date.now() / 1000);
  return post(body, { "x-upper-signature": sign(body, now), ...extraHeaders });
}

beforeEach(() => {
  fake.admin.reset();
  confirmChargeFromUpper.mockReset();
  recordBillingSignal.mockClear();
  confirmChargeFromUpper.mockResolvedValue({ outcome: "credited" });
  vi.stubEnv("UPPER_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/public/upper/webhook", () => {
  it("rejects a bad signature with 400 and records nothing", async () => {
    const body = JSON.stringify({ id: "evt-bad-sig", event: "charge.paid" });
    const response = await post(body, { "x-upper-signature": "t=1,v1=" + "0".repeat(64) });
    expect(response.status).toBe(400);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
    expect(confirmChargeFromUpper).not.toHaveBeenCalled();
  });

  it("records an invalid-signature billing signal (reason only) on a bad or missing signature", async () => {
    const body = JSON.stringify({ id: "evt-bad-sig-2", event: "charge.paid" });
    await post(body, { "x-upper-signature": "t=1,v1=" + "0".repeat(64) });
    await post(body);
    expect(recordBillingSignal).toHaveBeenCalledTimes(2);
    expect(recordBillingSignal).toHaveBeenNthCalledWith(1, "webhook_invalid_signature", "mismatch");
    expect(recordBillingSignal).toHaveBeenNthCalledWith(2, "webhook_invalid_signature", "missing");
  });

  it("does not record a signal for a valid signature", async () => {
    await signedPost({ id: "evt-valid-no-signal", event: "ping" });
    expect(recordBillingSignal).not.toHaveBeenCalled();
  });

  it("answers 500 when UPPER_WEBHOOK_SECRET is not configured", async () => {
    vi.stubEnv("UPPER_WEBHOOK_SECRET", "");
    const response = await post(JSON.stringify({ id: "evt-no-secret", event: "charge.paid" }));
    expect(response.status).toBe(500);
  });

  it("records and processes a valid charge.paid event, responding 200", async () => {
    const response = await signedPost({
      id: "evt-1",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    });

    expect(response.status).toBe(200);
    expect(confirmChargeFromUpper).toHaveBeenCalledWith("bl-top-order-1");
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].signature_valid).toBe(true);
    expect(rows[0].outcome).toBe("credited");
  });

  it("answers 503 and calls confirmChargeFromUpper zero times when the event cannot be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_webhook_events", "upsert", "db down");
    const response = await signedPost({
      id: "evt-db-down",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    });
    expect(response.status).toBe(503);
    expect(confirmChargeFromUpper).not.toHaveBeenCalled();
  });

  it("records payment.* events as ignored without calling confirmChargeFromUpper", async () => {
    const response = await signedPost({ id: "evt-payment-created", event: "payment.created" });
    expect(response.status).toBe(200);
    expect(confirmChargeFromUpper).not.toHaveBeenCalled();
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows[0].outcome).toBe("ignored");
  });

  it("stores raw_body with payer.document masked at both the top level and data.payer, never the original", async () => {
    const unmaskedDoc = "123.456.789-09";
    const response = await signedPost({
      id: "evt-lgpd",
      event: "charge.paid",
      payer: { name: "Fulano", document: unmaskedDoc },
      data: {
        externalId: "bl-top-order-1",
        payer: { name: "Fulano", document: unmaskedDoc },
      },
    });
    expect(response.status).toBe(200);
    const row = fake.admin.rows("payment_webhook_events")[0];
    const rawBody = row.raw_body as string;
    expect(rawBody).not.toContain(unmaskedDoc);
    const stored = JSON.parse(rawBody);
    expect(stored.payer.document).toBe("***.456.789-**");
    expect(stored.data.payer.document).toBe("***.456.789-**");
  });

  it("stores only the allow-listed headers, never the signature", async () => {
    const body = JSON.stringify({ id: "evt-headers", event: "ping" });
    const now = Math.floor(Date.now() / 1000);
    await post(body, {
      "x-upper-signature": sign(body, now),
      "x-upper-event": "charge.paid",
      "x-upper-delivery": "delivery-999",
      "user-agent": "Upper/1.0",
    });
    const row = fake.admin.rows("payment_webhook_events")[0];
    const headers = row.headers as Record<string, string>;
    expect(headers).toMatchObject({
      "x-upper-event": "charge.paid",
      "x-upper-delivery": "delivery-999",
      "user-agent": "Upper/1.0",
      "content-type": "application/json",
    });
    expect(headers["x-upper-signature"]).toBeUndefined();
  });

  it("clears a stale error on a successful reprocessing of the same event", async () => {
    const eventBody = {
      id: "evt-retry",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmChargeFromUpper.mockRejectedValueOnce(new Error("temporary failure"));
    const first = await signedPost(eventBody);
    expect(first.status).toBe(503);
    let row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.error).toContain("temporary failure");
    expect(row.processed_at).toBeFalsy();

    confirmChargeFromUpper.mockResolvedValueOnce({ outcome: "credited" });
    const second = await signedPost(eventBody);
    expect(second.status).toBe(200);
    row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.processed_at).not.toBeNull();
    expect(row.error).toBeNull();
    expect(row.outcome).toBe("credited");
  });

  it("logs and still answers 200, storing the error, when marking processed_at fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_webhook_events", "update", "write conflict");
    const response = await signedPost({ id: "evt-mark-fail", event: "ping" });
    expect(response.status).toBe(200);
    const row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.error).toContain("processed_at update failed");
  });

  it("does not reprocess the same event_id a second time", async () => {
    const eventBody = {
      id: "evt-dup",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    };
    await signedPost(eventBody);
    expect(confirmChargeFromUpper).toHaveBeenCalledTimes(1);

    const response = await signedPost(eventBody);
    expect(response.status).toBe(200);
    expect(confirmChargeFromUpper).toHaveBeenCalledTimes(1);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(1);
  });

  it("answers 200 for ping without processing a charge", async () => {
    const response = await signedPost({ id: "evt-ping", event: "ping" });
    expect(response.status).toBe(200);
    expect(confirmChargeFromUpper).not.toHaveBeenCalled();
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("ping");
  });

  it("records an unknown externalId (another account) and still answers 200", async () => {
    confirmChargeFromUpper.mockResolvedValue({ outcome: "unknown_charge" });
    const response = await signedPost({
      id: "evt-unknown",
      event: "charge.paid",
      data: { externalId: "bl-top-other-account" },
    });
    expect(response.status).toBe(200);
    expect(confirmChargeFromUpper).toHaveBeenCalledWith("bl-top-other-account");
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].outcome).toBe("unknown_charge");
  });

  it("falls back to X-Upper-Delivery for the event id when the body has none", async () => {
    const body = JSON.stringify({ event: "ping" });
    const now = Math.floor(Date.now() / 1000);
    const response = await post(body, {
      "x-upper-signature": sign(body, now),
      "x-upper-delivery": "delivery-123",
    });
    expect(response.status).toBe(200);
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("delivery-123");
  });

  it("returns 400 for a validly-signed but malformed event with no id anywhere", async () => {
    const body = JSON.stringify({ event: "ping" });
    const now = Math.floor(Date.now() / 1000);
    const response = await post(body, { "x-upper-signature": sign(body, now) });
    expect(response.status).toBe(400);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
  });

  it("records the error, leaves processed_at null and answers 503 when processing throws, so Upper redelivers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmChargeFromUpper.mockRejectedValue(new Error("upper unreachable"));
    const response = await signedPost({
      id: "evt-error",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    });
    expect(response.status).toBe(503);
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toContain("upper unreachable");
    expect(rows[0].processed_at ?? null).toBeNull();
  });

  it("still answers 200 for a redelivery of an event already processed", async () => {
    const eventBody = {
      id: "evt-processed",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    };
    expect((await signedPost(eventBody)).status).toBe(200);
    confirmChargeFromUpper.mockRejectedValue(new Error("must not be called again"));
    expect((await signedPost(eventBody)).status).toBe(200);
    expect(confirmChargeFromUpper).toHaveBeenCalledTimes(1);
  });

  it("masks a payer document nested anywhere in the stored raw_body (arrays, any key case)", async () => {
    const response = await signedPost({
      id: "evt-lgpd-deep",
      event: "payment.created",
      data: {
        payments: [{ payer: { Document: "123.456.789-09" } }, { other: [{ document: 123 }] }],
      },
    });
    expect(response.status).toBe(200);
    const rawBody = fake.admin.rows("payment_webhook_events")[0].raw_body as string;
    expect(rawBody).not.toContain("123.456.789-09");
    const stored = JSON.parse(rawBody);
    expect(stored.data.payments[0].payer.Document).toBe("***.456.789-**");
    expect(stored.data.payments[1].other[0].document).toBeNull();
  });
});
