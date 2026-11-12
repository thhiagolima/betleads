import { describe, expect, it } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { endToEndFromPayload, getEndToEndOrExternalId } from "./payment-reference.server";

describe("endToEndFromPayload", () => {
  it("reads Upper's top-level endToEndId", () => {
    expect(endToEndFromPayload("upper", { endToEndId: "E123" })).toBe("E123");
    expect(endToEndFromPayload(null, { endToEndId: "E123" })).toBe("E123");
    expect(endToEndFromPayload("upper", { status: "PAID" })).toBeNull();
  });

  it("reads SpacePay's top-level endToEndId from the allow-listed payload", () => {
    expect(
      endToEndFromPayload("spacepay", { id: "tx-1", status: "paid", endToEndId: "E-top" }),
    ).toBe("E-top");
    expect(endToEndFromPayload("spacepay", { id: "tx-1", endToEndId: null })).toBeNull();
  });

  it("falls back to data.history[].payload for older full-body rows, latest entry first", () => {
    const payload = {
      data: {
        history: [
          { status: "created", payload: { endToEndId: "E-old" } },
          { status: "paid", payload: { end_to_end_id: "E-new" } },
          { status: "callback_failed", payload: { foo: "bar" } },
        ],
      },
    };
    expect(endToEndFromPayload("spacepay", payload)).toBe("E-new");
  });

  it("accepts the e2eId and end2end spellings", () => {
    expect(
      endToEndFromPayload("spacepay", { data: { history: [{ payload: { e2eId: "E-a" } }] } }),
    ).toBe("E-a");
    expect(
      endToEndFromPayload("spacepay", { data: { history: [{ payload: { end2end: "E-b" } }] } }),
    ).toBe("E-b");
  });

  it("returns null for SpacePay without an end-to-end id anywhere", () => {
    expect(endToEndFromPayload("spacepay", { endToEndId: "  " })).toBeNull();
    expect(endToEndFromPayload("spacepay", { data: { history: "nope" } })).toBeNull();
    expect(endToEndFromPayload("spacepay", null)).toBeNull();
  });
});

describe("getEndToEndOrExternalId", () => {
  it("returns null without a charge id", async () => {
    expect(await getEndToEndOrExternalId(createFakeDb().client, null)).toBeNull();
  });

  it("uses the charge's provider to find the end-to-end, falling back to external_id", async () => {
    const db = createFakeDb();
    db.rows("payment_charges").push(
      {
        id: "c-sp",
        provider: "spacepay",
        external_id: "bl-inv-1-1",
        last_provider_payload: { data: { history: [{ payload: { endToEndId: "E-sp" } }] } },
      },
      {
        id: "c-sp-none",
        provider: "spacepay",
        external_id: "bl-inv-2-1",
        last_provider_payload: { data: { id: "tx" } },
      },
      {
        id: "c-up",
        provider: "upper",
        external_id: "bl-inv-3-1",
        last_provider_payload: { endToEndId: "E-up" },
      },
    );
    expect(await getEndToEndOrExternalId(db.client, "c-sp")).toBe("E-sp");
    expect(await getEndToEndOrExternalId(db.client, "c-sp-none")).toBe("bl-inv-2-1");
    expect(await getEndToEndOrExternalId(db.client, "c-up")).toBe("E-up");
  });
});
