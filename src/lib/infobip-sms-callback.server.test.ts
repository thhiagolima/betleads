import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { applyInfobipSmsReports as apply } from "./infobip-sms-callback.server";

const OWN_A = "11111111-1111-4111-8111-111111111111";
const OWN_B = "22222222-2222-4222-8222-222222222222";
const TENANT = "00000000-0000-4000-8000-000000000001";
const OWNED: ReadonlySet<string> = new Set([OWN_A, OWN_B]);
const PLATFORM_SCOPE = { scope: { kind: "platform" as const }, ownedAccountIds: OWNED };
const accountScope = (accountId: string) => ({
  scope: { kind: "account" as const, accountId, tenantId: TENANT },
  ownedAccountIds: new Set<string>(),
});
const applyInfobipSmsReports = (body: unknown) => apply(body, PLATFORM_SCOPE);

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

    expect(result).toEqual({ received: 3, matched: 2, ignored: 0 });
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

  describe("callback scope", () => {
    const delivered = { groupId: 3, groupName: "DELIVERED" };
    beforeEach(() => {
      fake.db.rows("sms_send_logs").push(
        { id: "log-a", provider_message_id: "key-a", provider_account_id: OWN_A, delivery_status: "sent" },
        { id: "log-b", provider_message_id: "key-b", provider_account_id: OWN_B, delivery_status: "sent" },
      );
      fake.db.rows("link_dispatches").push(
        { id: "ld-a", idempotency_key: "key-a:0", delivery_status: "sent" },
        { id: "ld-b", idempotency_key: "key-b:0", delivery_status: "sent" },
      );
    });
    const log = (id: string) => fake.db.rows("sms_send_logs").find((l) => l.id === id)!;
    const link = (id: string) => fake.db.rows("link_dispatches").find((l) => l.id === id)!;

    it("the global token never touches an owned account's send", async () => {
      const result = await apply({ results: [report("key-a", delivered)] }, PLATFORM_SCOPE);
      expect(result).toEqual({ received: 1, matched: 0, ignored: 1 });
      expect(log("log-a").delivery_status).toBe("sent");
      expect(link("ld-a").delivery_status).toBe("sent");
    });

    it("account A's token never touches account B's send nor a platform send", async () => {
      const result = await apply(
        { results: [report("key-b", delivered), report("key-1", delivered), report("key-x", delivered)] },
        accountScope(OWN_A),
      );
      expect(result).toEqual({ received: 3, matched: 0, ignored: 3 });
      expect(log("log-b").delivery_status).toBe("sent");
      expect(log("log-1").delivery_status).toBe("sent");
      expect(link("ld-b").delivery_status).toBe("sent");
      expect(link("ld-1").delivery_status).toBe("sent");
    });

    it("account A's token applies to account A's send", async () => {
      const result = await apply({ results: [report("key-a", delivered)] }, accountScope(OWN_A));
      expect(result).toEqual({ received: 1, matched: 1, ignored: 0 });
      expect(log("log-a").delivery_status).toBe("delivered");
      expect(link("ld-a").delivery_status).toBe("delivered");
    });
  });
});
