import { describe, expect, it } from "vitest";

import { channelDeliveryMetric, summarizeChannelDelivery } from "./channel-observability.functions";

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

  it("counts a dispatched voice call only once it is answered or completed", () => {
    expect(
      summarizeChannelDelivery("voice", [
        { status: "sent" },
        { status: "answered" },
        { status: "no_answer" },
      ]),
    ).toEqual({ total: 3, delivered: 1, failed: 0 });
  });

  it("counts provider-accepted SMS and e-mail (no delivery receipt exists)", () => {
    expect(
      summarizeChannelDelivery("email", [
        { status: "sent" },
        { status: "enviado" },
        { status: "failed" },
      ]),
    ).toEqual({ total: 3, delivered: 2, failed: 1 });
  });
});

describe("channelDeliveryMetric", () => {
  it("labels SMS and e-mail as accepted and voice as answered", () => {
    expect(channelDeliveryMetric("sms")).toBe("accepted");
    expect(channelDeliveryMetric("email")).toBe("accepted");
    expect(channelDeliveryMetric("voice")).toBe("answered");
  });
});
