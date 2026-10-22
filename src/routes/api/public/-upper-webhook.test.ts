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
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(1);
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

  it("records the error message and still answers 200 when processing throws", async () => {
    confirmChargeFromUpper.mockRejectedValue(new Error("upper unreachable"));
    const response = await signedPost({
      id: "evt-error",
      event: "charge.paid",
      data: { externalId: "bl-top-order-1" },
    });
    expect(response.status).toBe(200);
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toContain("upper unreachable");
    expect(rows[0].processed_at).toBeFalsy();
  });
});
