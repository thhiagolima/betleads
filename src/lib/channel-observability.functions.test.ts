import { describe, expect, it } from "vitest";

import { summarizeChannelDelivery } from "./channel-observability.functions";

describe("summarizeChannelDelivery", () => {
  it("prioritizes the SMS delivery callback status", () => {
    expect(
      summarizeChannelDelivery("sms", [
        { status: "sent", delivery_status: "delivered" },
        { status: "sent", delivery_status: "failed" },
        { status: "queued", delivery_status: null },
      ]),
    ).toEqual({ total: 3, delivered: 1, failed: 1 });
  });

  it("treats completed voice calls as operational delivery", () => {
    expect(
      summarizeChannelDelivery("voice", [
        { status: "completed" },
        { status: "answered" },
        { status: "failed" },
      ]),
    ).toEqual({ total: 3, delivered: 2, failed: 1 });
  });
});
