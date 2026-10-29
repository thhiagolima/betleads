import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { applyInfobipSmsReports } from "./infobip-sms-callback.server";

function report(
  messageId: string,
  status: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    bulkId: "b-1",
    messageId,
    to: "5511999990000",
    callbackData: messageId,
    status,
    ...extra,
  };
}

beforeEach(() => {
  fake.db.reset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fake.db
    .rows("sms_send_logs")
    .push(
      { id: "log-1", provider: "infobip", provider_message_id: "key-1", delivery_status: "sent" },
      { id: "log-2", provider: "infobip", provider_message_id: "key-2", delivery_status: "sent" },
    );
  fake.db
    .rows("link_dispatches")
    .push(
      { id: "ld-1", idempotency_key: "key-1:0", delivery_status: "sent" },
      { id: "ld-2", idempotency_key: "key-2:0", delivery_status: "sent" },
    );
});

describe("Infobip SMS delivery reports", () => {
  it("marks delivered and failed sends, and carries them to the tracked links", async () => {
    const result = await applyInfobipSmsReports({
      results: [
        report(
          "key-1",
          { groupId: 3, groupName: "DELIVERED", name: "DELIVERED_TO_HANDSET" },
          {
            doneAt: "2026-10-29T15:00:00.000+0000",
          },
        ),
        report(
          "key-2",
          { groupId: 2, groupName: "UNDELIVERABLE", name: "UNDELIVERABLE_NOT_DELIVERED" },
          {
            error: { name: "EC_ABSENT_SUBSCRIBER", description: "Absent subscriber" },
          },
        ),
        report("key-unknown", { groupId: 3, groupName: "DELIVERED" }),
      ],
    });

    expect(result).toEqual({ received: 3, matched: 2 });
    const logs = fake.db.rows("sms_send_logs");
    expect(logs.find((l) => l.id === "log-1")).toMatchObject({
      delivery_status: "delivered",
      delivered_at: "2026-10-29T15:00:00.000Z",
    });
    expect(logs.find((l) => l.id === "log-2")).toMatchObject({
      delivery_status: "failed",
      error: "Absent subscriber",
    });
    expect(fake.db.rows("link_dispatches").map((d) => d.delivery_status)).toEqual([
      "delivered",
      "failed",
    ]);
  });

  it("a pending report keeps the send as sent and does not touch the links", async () => {
    await applyInfobipSmsReports({
      results: [report("key-1", { groupId: 1, groupName: "PENDING" })],
    });
    expect(fake.db.rows("sms_send_logs")[0].delivery_status).toBe("sent");
    expect(fake.db.rows("link_dispatches")[0].delivery_status).toBe("sent");
  });
});
