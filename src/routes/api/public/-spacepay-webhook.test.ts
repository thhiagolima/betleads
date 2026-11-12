import { createHash, createHmac } from "node:crypto";

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

// Accepted callback secrets come from the gateway config loader (DB + env).
const gatewaySecrets = vi.hoisted(() => ({ spacepay: [] as string[] }));
vi.mock("@/lib/billing/payment-gateway-config.server", () => ({
  spacePayCallbackSecrets: async () => gatewaySecrets.spacepay,
}));

// Self-contained stand-in for the token verifier (same contract:
// `${base64url(externalId)}.${hexHmac}`), so this route test does not depend
// on the token module's internals.
vi.mock("@/lib/billing/spacepay-callback-token", async () => {
  const { createHmac: hmac, timingSafeEqual } = await import("node:crypto");
  return {
    verifySpacePayCallbackToken(token: string, secret: string) {
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]{64}$/.test(parts[1])) {
        return { ok: false, reason: "malformed" };
      }
      const externalId = Buffer.from(parts[0], "base64url").toString("utf8");
      const expected = hmac("sha256", secret).update(externalId).digest("hex");
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) {
        return { ok: false, reason: "bad_signature" };
      }
      return { ok: true, externalId };
    },
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { Route } from "./spacepay/webhook.$token";

type Handler = (input: { request: Request; params: { token: string } }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
  .options.server.handlers.POST;

const SECRET = "spacepay-callback-secret-test-0123456789";
const EXTERNAL_ID = "bl-top-order-1";

function tokenFor(externalId: string, secret = SECRET): string {
  const sig = createHmac("sha256", secret).update(externalId).digest("hex");
  return `${Buffer.from(externalId, "utf8").toString("base64url")}.${sig}`;
}

function post(token: string, body: string, headers: Record<string, string> = {}) {
  return POST({
    request: new Request(`https://app.example.test/api/public/spacepay/webhook/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
    params: { token },
  });
}

function validPost(bodyObj: unknown = { status: "paid" }, headers: Record<string, string> = {}) {
  return post(tokenFor(EXTERNAL_ID), JSON.stringify(bodyObj), headers);
}

function expectedEventId(rawBody: string, externalId = EXTERNAL_ID): string {
  const hash = createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 16);
  return `spacepay:${externalId}:${hash}`;
}

beforeEach(() => {
  fake.admin.reset();
  confirmCharge.mockReset();
  recordBillingSignal.mockClear();
  confirmCharge.mockResolvedValue({ outcome: "credited" });
  gatewaySecrets.spacepay = [SECRET];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/public/spacepay/webhook/$token", () => {
  it("answers 500 when no callback secret is configured, writing nothing", async () => {
    gatewaySecrets.spacepay = [];
    const response = await validPost();
    expect(response.status).toBe(500);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
    expect(confirmCharge).not.toHaveBeenCalled();
  });

  it("accepts a token signed with any of the configured secrets (rotation)", async () => {
    gatewaySecrets.spacepay = ["new-db-secret", SECRET];
    const oldUrl = await post(tokenFor(EXTERNAL_ID, SECRET), '{"status":"paid"}');
    expect(oldUrl.status).toBe(200);
    const newUrl = await post(tokenFor(EXTERNAL_ID, "new-db-secret"), '{"status":"paid","n":2}');
    expect(newUrl.status).toBe(200);
    expect(recordBillingSignal).not.toHaveBeenCalled();
  });

  it("rejects a token signed with none of the configured secrets with 401", async () => {
    gatewaySecrets.spacepay = ["new-db-secret", SECRET];
    const response = await post(tokenFor(EXTERNAL_ID, "other-secret"), '{"status":"paid"}');
    expect(response.status).toBe(401);
    expect(recordBillingSignal).toHaveBeenCalledWith(
      "spacepay_webhook_invalid_token",
      "bad_signature",
    );
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
  });

  it("rejects a token signed with another secret with 401, a billing signal and nothing written", async () => {
    const response = await post(tokenFor(EXTERNAL_ID, "other-secret"), '{"status":"paid"}');
    expect(response.status).toBe(401);
    expect(recordBillingSignal).toHaveBeenCalledWith(
      "spacepay_webhook_invalid_token",
      "bad_signature",
    );
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
    expect(confirmCharge).not.toHaveBeenCalled();
  });

  it("rejects a malformed token with 401 and reason 'malformed'", async () => {
    const response = await post("not-a-token", '{"status":"paid"}');
    expect(response.status).toBe(401);
    expect(recordBillingSignal).toHaveBeenCalledWith("spacepay_webhook_invalid_token", "malformed");
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(0);
  });

  it("rejects a token whose externalId was swapped (signature no longer matches)", async () => {
    const [, sig] = tokenFor(EXTERNAL_ID).split(".");
    const forged = `${Buffer.from("bl-top-other", "utf8").toString("base64url")}.${sig}`;
    const response = await post(forged, '{"status":"paid"}');
    expect(response.status).toBe(401);
    expect(confirmCharge).not.toHaveBeenCalled();
  });

  it("records the event (provider spacepay) then confirms the charge from the token's externalId, answering 200", async () => {
    const body = { status: "paid", id: "sp-tx-1", amount: 999999 };
    const response = await validPost(body, { "user-agent": "SpacePay/1.0" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(confirmCharge).toHaveBeenCalledWith(EXTERNAL_ID);
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: expectedEventId(JSON.stringify(body)),
      provider: "spacepay",
      event: "paid",
      signature_valid: true,
      outcome: "credited",
      error: null,
    });
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].headers).toEqual({
      "user-agent": "SpacePay/1.0",
      "content-type": "application/json",
    });
  });

  it("falls back to body.event for the event name, and null when neither is a string", async () => {
    await validPost({ event: "transaction.paid" });
    await validPost({ status: 3 });
    const rows = fake.admin.rows("payment_webhook_events");
    expect(rows.map((r) => r.event)).toEqual(["transaction.paid", null]);
  });

  it("does not reprocess an identical redelivery already processed", async () => {
    expect((await validPost({ status: "paid" })).status).toBe(200);
    expect((await validPost({ status: "paid" })).status).toBe(200);
    expect(confirmCharge).toHaveBeenCalledTimes(1);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(1);
  });

  it("treats a different body for the same charge as a new event", async () => {
    await validPost({ status: "created" });
    await validPost({ status: "paid" });
    expect(confirmCharge).toHaveBeenCalledTimes(2);
    expect(fake.admin.rows("payment_webhook_events")).toHaveLength(2);
  });

  it("stores outcome 'not_paid' (SpacePay may still say created during the callback) and answers 200", async () => {
    confirmCharge.mockResolvedValue({ outcome: "not_paid" });
    const response = await validPost({ status: "paid" });
    expect(response.status).toBe(200);
    expect(fake.admin.rows("payment_webhook_events")[0].outcome).toBe("not_paid");
  });

  it("still answers 200 when processing throws, storing the error with processed_at null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmCharge.mockRejectedValue(new Error("spacepay unreachable"));
    const response = await validPost({ status: "paid" });
    expect(response.status).toBe(200);
    const row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.error).toContain("spacepay unreachable");
    expect(row.processed_at ?? null).toBeNull();
  });

  it("reprocesses a redelivery of an event whose processing failed, clearing the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmCharge.mockRejectedValueOnce(new Error("temporary failure"));
    await validPost({ status: "paid" });
    confirmCharge.mockResolvedValueOnce({ outcome: "credited" });
    await validPost({ status: "paid" });
    expect(confirmCharge).toHaveBeenCalledTimes(2);
    const row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.processed_at).not.toBeNull();
    expect(row.error).toBeNull();
    expect(row.outcome).toBe("credited");
  });

  it("still answers 200 and still confirms the charge when the event cannot be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_webhook_events", "upsert", "db down");
    const response = await validPost({ status: "paid" });
    expect(response.status).toBe(200);
    expect(confirmCharge).toHaveBeenCalledWith(EXTERNAL_ID);
  });

  it("still answers 200 when both recording and processing fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_webhook_events", "upsert", "db down");
    confirmCharge.mockRejectedValue(new Error("db down too"));
    const response = await validPost({ status: "paid" });
    expect(response.status).toBe(200);
  });

  it("logs and still answers 200, storing the error, when marking processed_at fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.failNext("payment_webhook_events", "update", "write conflict");
    const response = await validPost({ status: "paid" });
    expect(response.status).toBe(200);
    expect(fake.admin.rows("payment_webhook_events")[0].error).toContain(
      "processed_at update failed",
    );
  });

  it("accepts a non-JSON or empty body (the format is undocumented), still confirming via the token", async () => {
    const response = await post(tokenFor(EXTERNAL_ID), "status=paid", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(200);
    expect(confirmCharge).toHaveBeenCalledWith(EXTERNAL_ID);
    const row = fake.admin.rows("payment_webhook_events")[0];
    expect(row.raw_body).toBe("status=paid");
    expect(row.event).toBeNull();

    expect((await post(tokenFor("bl-top-order-2"), "")).status).toBe(200);
    expect(confirmCharge).toHaveBeenLastCalledWith("bl-top-order-2");
  });

  describe("callback deadline (SpacePay rolls back a slow callback)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("answers 200 after 3000 ms even when confirmCharge never settles", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      confirmCharge.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = validPost({ status: "paid" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(confirmCharge).toHaveBeenCalledWith(EXTERNAL_ID);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deadline"),
        expect.objectContaining({ externalId: EXTERNAL_ID }),
      );
      // Still in flight: the event row stays unprocessed for the cron.
      const row = fake.admin.rows("payment_webhook_events")[0];
      expect(row.processed_at ?? null).toBeNull();
    });

    it("keeps processing after the early 200 and stores a late failure on the event row", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        confirmCharge.mockImplementation(
          () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("late spacepay failure")), 5000);
            }),
        );

        const pending = validPost({ status: "paid" });
        await vi.advanceTimersByTimeAsync(3000);
        expect((await pending).status).toBe(200);

        await vi.advanceTimersByTimeAsync(2000);
        const row = fake.admin.rows("payment_webhook_events")[0];
        expect(row.error).toContain("late spacepay failure");
        expect(row.processed_at ?? null).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith(
          "[spacepay-webhook] processing error",
          expect.objectContaining({ error: "late spacepay failure" }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("answers as soon as processing finishes when it is fast", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const response = await validPost({ status: "paid" });
      expect(response.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fake.admin.rows("payment_webhook_events")[0].outcome).toBe("credited");
    });
  });

  it("masks a payer document anywhere in the stored raw_body", async () => {
    await validPost({ status: "paid", payer: { name: "Fulano", document: "123.456.789-09" } });
    const rawBody = fake.admin.rows("payment_webhook_events")[0].raw_body as string;
    expect(rawBody).not.toContain("123.456.789-09");
    expect(JSON.parse(rawBody).payer.document).toBe("***.456.789-**");
  });
});
