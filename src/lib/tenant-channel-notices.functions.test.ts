// Final review #6: `disabledAt` of the "Ciente" ack must be a real
// timestamp (it is written to tenant_channel_notice_acks.disabled_at and
// matched against tenant_channels.disabled_at as returned by PostgREST).
import { describe, expect, it } from "vitest";
import { ackChannelNoticeInput } from "./tenant-channel-notices.functions";

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("ackChannelNoticeInput", () => {
  it("accepts a timestamptz as PostgREST returns it (offset, microseconds) and a Z timestamp", () => {
    for (const disabledAt of ["2026-11-05T12:34:56.123456+00:00", "2026-11-05T12:34:56Z"]) {
      expect(
        ackChannelNoticeInput.safeParse({ tenantId: TENANT, channel: "sms", disabledAt }).success,
      ).toBe(true);
    }
  });

  it("refuses an arbitrary string", () => {
    for (const disabledAt of ["", "ontem", "2026-11-05"]) {
      expect(
        ackChannelNoticeInput.safeParse({ tenantId: TENANT, channel: "sms", disabledAt }).success,
      ).toBe(false);
    }
  });
});
