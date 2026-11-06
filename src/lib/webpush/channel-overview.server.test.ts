// Web push (OneSignal): numbers of the /webpush overview, over the in-memory
// fake db (same helper as campaigns.server.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";

import { getWebpushChannelOverview } from "./channel-overview.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";

let db: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db = createFakeDb();
});

function seedSubscription(overrides: Record<string, unknown> = {}) {
  db.rows("push_subscriptions").push({
    id: `sub-${db.rows("push_subscriptions").length + 1}`,
    tenant_id: TENANT,
    status: "ativa",
    player_id: null,
    ...overrides,
  });
}

function seedLog(createdAt: string, status = "enviado", tenantId = TENANT) {
  db.rows("webpush_send_logs").push({
    id: `log-${db.rows("webpush_send_logs").length + 1}`,
    tenant_id: tenantId,
    status,
    created_at: createdAt,
  });
}

function seedDispatch(clickedAt: string | null, overrides: Record<string, unknown> = {}) {
  db.rows("link_dispatches").push({
    id: `ld-${db.rows("link_dispatches").length + 1}`,
    tenant_id: TENANT,
    channel: "webpush",
    first_party_first_clicked_at: clickedAt,
    ...overrides,
  });
}

describe("getWebpushChannelOverview", () => {
  it("counts subscriptions of the house only: active, total and linked to a player", async () => {
    seedSubscription();
    seedSubscription({ player_id: "p-1" });
    seedSubscription({ status: "inativa", player_id: "p-2" });
    seedSubscription({ tenant_id: OTHER_TENANT });

    const result = await getWebpushChannelOverview(db.client, TENANT, {
      from: "2026-11-01",
      to: "2026-11-03",
    });

    expect(result.subscriptions).toEqual({ active: 2, total: 3, linked: 1 });
  });

  it("counts sent, refused and clicked pushes inside the Brasília period", async () => {
    // 2026-11-01 00:00 BRT = 03:00 UTC; 2026-11-03 23:59 BRT = 2026-11-04 02:59 UTC.
    seedLog("2026-11-01T03:00:00.000Z");
    seedLog("2026-11-02T15:00:00.000Z");
    seedLog("2026-11-04T02:00:00.000Z", "recusado");
    seedLog("2026-11-01T02:59:00.000Z"); // 31/10 in Brasília: outside
    seedLog("2026-11-02T15:00:00.000Z", "enviado", OTHER_TENANT);
    seedDispatch("2026-11-02T16:00:00.000Z");
    seedDispatch(null);
    seedDispatch("2026-11-02T16:00:00.000Z", { channel: "sms" });
    seedDispatch("2026-11-02T16:00:00.000Z", { tenant_id: OTHER_TENANT });

    const result = await getWebpushChannelOverview(db.client, TENANT, {
      from: "2026-11-01",
      to: "2026-11-03",
    });

    expect(result.totals).toEqual({ sent: 2, refused: 1, clicks: 1 });
    expect(result.by_day).toEqual([
      { date: "2026-11-01", sent: 1, refused: 0 },
      { date: "2026-11-02", sent: 1, refused: 0 },
      { date: "2026-11-03", sent: 0, refused: 1 },
    ]);
    expect(result.by_hour).toEqual([]);
  });

  it("fills every hour of a single past day, in Brasília time", async () => {
    seedLog("2026-11-02T15:10:00.000Z"); // 12h BRT
    seedLog("2026-11-02T15:50:00.000Z", "recusado");

    const result = await getWebpushChannelOverview(
      db.client,
      TENANT,
      { from: "2026-11-02", to: "2026-11-02" },
      new Date("2026-11-06T12:00:00.000Z"),
    );

    expect(result.by_hour).toHaveLength(24);
    expect(result.by_hour[0]).toEqual({ t: "2026-11-02T03:00:00.000Z", count: 0 });
    expect(result.by_hour[12]).toEqual({ t: "2026-11-02T15:00:00.000Z", count: 2 });
  });

  it("stops today's hourly series at the current hour", async () => {
    const result = await getWebpushChannelOverview(
      db.client,
      TENANT,
      { from: "2026-11-06", to: "2026-11-06" },
      new Date("2026-11-06T13:30:00.000Z"), // 10:30 BRT
    );

    expect(result.by_hour.map((point) => point.t).at(-1)).toBe("2026-11-06T13:00:00.000Z");
    expect(result.by_hour).toHaveLength(11);
  });

  it("surfaces a database error", async () => {
    db.failNext("push_subscriptions", "select", "boom");
    await expect(
      getWebpushChannelOverview(db.client, TENANT, { from: "2026-11-01", to: "2026-11-01" }),
    ).rejects.toThrow("boom");
  });
});
