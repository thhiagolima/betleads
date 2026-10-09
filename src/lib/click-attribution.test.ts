import { describe, expect, it } from "vitest";
import { resolveAttributionWindow } from "./conversion-attribution.server";
import {
  isTrackingToken,
  resolveBetleadsClickCapturedAt,
  resolveBetleadsClickId,
  resolveBetleadsClickTokenSource,
} from "./webhook-process.server";
import { deterministicToken } from "./shortio.server";

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("BetLeads click attribution contract", () => {
  it("prefers the dedicated click id and accepts the legacy UUID fallback", () => {
    expect(
      resolveBetleadsClickId({}, { bl_click_id: token }, {}, { utm_content: "creative" } as never),
    ).toBe(token);
    expect(resolveBetleadsClickId({}, {}, {}, { utm_content: token } as never)).toBe(token);
    expect(resolveBetleadsClickTokenSource({}, {}, {}, { utm_content: token } as never)).toBe(
      "utm_content",
    );
    expect(resolveBetleadsClickId({}, {}, {}, { utm_content: "video-01" } as never)).toBeNull();
    expect(isTrackingToken("video-01")).toBe(false);
  });

  it("accepts deterministic tokens without requiring RFC version bits", async () => {
    const generated = await deterministicToken(
      {
        tenantId: "tenant",
        channel: "sms",
        sourceType: "campaign",
        deliveryKey: "delivery",
        recipientPlayerId: "player",
      },
      0,
    );
    expect(isTrackingToken(generated)).toBe(true);
  });

  it("normalizes a valid landing capture timestamp", () => {
    expect(
      resolveBetleadsClickCapturedAt({}, { blClickCapturedAt: "2026-10-09T11:30:00-03:00" }, {}),
    ).toBe("2026-10-09T14:30:00.000Z");
    expect(resolveBetleadsClickCapturedAt({}, { bl_click_captured_at: "invalid" }, {})).toBeNull();
  });

  it("anchors the direct window on the captured click", () => {
    const result = resolveAttributionWindow(
      "2026-10-01T00:00:00Z",
      "2026-10-10T00:00:00Z",
      "2026-10-04T00:00:00Z",
    );
    expect(result).toEqual({
      classification: "direct",
      windowStartedAt: "2026-10-04T00:00:00.000Z",
      anchor: "click_captured_at",
    });
  });

  it("falls back to send time for an invalid click timestamp", () => {
    const result = resolveAttributionWindow(
      "2026-10-01T00:00:00Z",
      "2026-10-09T00:00:00Z",
      "2026-09-30T00:00:00Z",
    );
    expect(result?.classification).toBe("assisted");
    expect(result?.anchor).toBe("sent_at");
  });
});
