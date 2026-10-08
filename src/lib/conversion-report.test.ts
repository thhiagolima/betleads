import { describe, expect, it } from "vitest";
import {
  canAccessConversionDrilldown,
  deliveryIdentity,
  uniqueDeliveryCount,
} from "./conversion-report";

describe("conversion report delivery semantics", () => {
  it("counts one delivery when the message contains multiple links", () => {
    const rows = [
      { id: "a", idempotency_key: "send-1:0", send_status: "sent" },
      { id: "b", idempotency_key: "send-1:1", send_status: "sent" },
      { id: "c", idempotency_key: "send-2:0", send_status: "sent" },
    ];
    expect(uniqueDeliveryCount(rows, (row) => row.send_status === "sent")).toBe(2);
    expect(deliveryIdentity(rows[0])).toBe("delivery:send-1");
  });

  it("uses the message log identity when available", () => {
    expect(
      uniqueDeliveryCount(
        [
          { id: "a", message_log_id: "log-1", send_status: "sent" },
          { id: "b", message_log_id: "log-1", send_status: "sent" },
        ],
        () => true,
      ),
    ).toBe(1);
  });
});

describe("conversion report permissions", () => {
  it("allows only tenant admin or super admin", () => {
    expect(canAccessConversionDrilldown("admin", false)).toBe(true);
    expect(canAccessConversionDrilldown("super_admin", false)).toBe(true);
    expect(canAccessConversionDrilldown("gestor", false)).toBe(false);
    expect(canAccessConversionDrilldown("member", false)).toBe(false);
    expect(canAccessConversionDrilldown(null, true)).toBe(true);
  });
});
