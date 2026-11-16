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

const { confirmCharge } = vi.hoisted(() => ({ confirmCharge: vi.fn() }));
vi.mock("@/lib/billing/payment-charges.server", () => ({ confirmCharge }));

const { recordBillingSignal } = vi.hoisted(() => ({
  recordBillingSignal: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/billing-signals.server", () => ({ recordBillingSignal }));

const gatewaySecrets = vi.hoisted(() => ({ paganopay: [] as string[] }));
vi.mock("@/lib/billing/payment-gateway-config.server", () => ({
  paganoPayWebhookSecrets: async () => gatewaySecrets.paganopay,
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { Route } from "./paganopay/webhook";

type Handler = (input: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const SECRET = "pagano-route-secret";
const URL = "https://app.example.test/api/public/paganopay/webhook";

function signedPost(bodyObj: unknown, opts: { secret?: string; ts?: number } = {}) {
  const body = JSON.stringify(bodyObj);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${body}`).digest("hex");
  return POST({
    request: new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": `v1=${sig}`,
        "x-webhook-timestamp": ts,
        "x-webhook-id": "dlv-1",
      },
      body,
    }),
  });
}

const CONFIRMED = {
  event: "pix.confirmed",
  id: 26150,
  status: "PAID",
  amount: 10000,
  external_ref: "bl-top-1",
  payer: { name: "FULANO", document: "12345678909" },
};

function seedOurCharge() {
  fake.admin.rows("payment_charges").push(
    {
      id: "c1",
      provider: "paganopay",
      provider_charge_id: "26150",
      external_id: "bl-top-1",
    },
  );
}

beforeEach(() => {
  fake.admin.reset();
  confirmCharge.mockReset();
  recordBillingSignal.mockClear();
  confirmCharge.mockResolvedValue({ outcome: "credited" });
  gatewaySecrets.paganopay = [SECRET];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/public/paganopay/webhook", () => {
  it("rejects a bad signature with 401, records nothing and raises a signal", async () => {
    const res = await signedPost(CONFIRMED, { secret: "wrong" });
    expect(res.status).toBe(401);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
    expect(confirmCharge).not.toHaveBeenCalled();
    expect(recordBillingSignal).toHaveBeenCalledWith(
      "paganopay_webhook_invalid_signature",
      "mismatch",
    );
  });

  it("answers 500 when no secret is configured", async () => {
    gatewaySecrets.paganopay = [];
    expect((await signedPost(CONFIRMED)).status).toBe(500);
  });

  it("records pix.confirmed for our charge, masks the payer document and confirms by our external id", async () => {
    seedOurCharge();
    const res = await signedPost(CONFIRMED);
    expect(res.status).toBe(200);
    expect(confirmCharge).toHaveBeenCalledWith("bl-top-1");
    const [event] = fake.admin.rows("payment_webhook_events");
    expect(event).toMatchObject({
      event_id: "paganopay:pix.confirmed:26150:PAID",
      provider: "paganopay",
      event: "pix.confirmed",
      delivery_id: "dlv-1",
      outcome: "credited",
      error: null,
    });
    expect(event.processed_at).toBeTruthy();
    expect(String(event.raw_body)).not.toContain("12345678909");
    expect(JSON.stringify(event.headers)).not.toContain("v1=");
  });

  it("answers 200 without confirming a charge that is not ours (shared account)", async () => {
    const res = await signedPost({ ...CONFIRMED, id: 999, external_ref: "spacepay-xyz" });
    expect(res.status).toBe(200);
    expect(confirmCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_webhook_events")[0]).toMatchObject({
      outcome: "unknown_charge",
    });
  });

  it("does not confirm on pix.received (not a payment)", async () => {
    seedOurCharge();
    await signedPost({ ...CONFIRMED, event: "pix.received", status: "PENDING" });
    expect(confirmCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_webhook_events")[0]).toMatchObject({
      outcome: "ignored_received",
    });
  });

  it("ignores non-pix events without storing them", async () => {
    const res = await signedPost({ event: "cashout.completed", id: 5, status: "paid" });
    expect(res.status).toBe(200);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
  });

  it("does not process an already-processed duplicate twice", async () => {
    seedOurCharge();
    await signedPost(CONFIRMED);
    await signedPost(CONFIRMED);
    expect(confirmCharge).toHaveBeenCalledTimes(1);
  });

  it("still answers 200 when processing fails (avoids PaganoPay's pause) and keeps the error", async () => {
    seedOurCharge();
    confirmCharge.mockRejectedValueOnce(new Error("gateway down"));
    const res = await signedPost(CONFIRMED);
    expect(res.status).toBe(200);
    expect(fake.admin.rows("payment_webhook_events")[0]).toMatchObject({
      error: "gateway down",
      processed_at: null,
    });
  });
});
