// Web push (OneSignal) — Task 8: recordSubscription. Uses createFakeDb (the
// in-memory Supabase query-builder stand-in already used by the SMS bulk
// path) so these are fast unit tests, not a DB test.
import { describe, expect, it } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { recordSubscription } from "./subscriptions.server";

const TENANT = "tenant-1";
const TOKEN = "tok-1";

function seed() {
  const db = createFakeDb();
  db.rows("tenant_webpush_settings").push({
    tenant_id: TENANT,
    public_token: TOKEN,
  });
  db.rows("tenant_webpush_apps").push(
    {
      id: "app-ativo",
      tenant_id: TENANT,
      origin: "https://casa.example",
      status: "ativo",
      script_seen_at: null,
      player_linked_at: null,
    },
    {
      id: "app-legado",
      tenant_id: TENANT,
      origin: "https://legado.example",
      status: "legado",
      script_seen_at: null,
      player_linked_at: null,
    },
  );
  db.rows("players").push({
    id: "player-1",
    tenant_id: TENANT,
    player_external_id: "ext-1",
  });
  return db;
}

function baseInput(overrides: Partial<Parameters<typeof recordSubscription>[1]> = {}) {
  return {
    token: TOKEN,
    origin: "https://casa.example",
    subscriptionId: "sub-1",
    optedIn: true,
    playerId: null,
    userAgent: "ua-1",
    now: new Date("2026-11-05T12:00:00Z"),
    ...overrides,
  };
}

describe("recordSubscription", () => {
  it("rejects an unknown token", async () => {
    const db = seed();
    const result = await recordSubscription(
      db.client as any,
      baseInput({ token: "unknown-token" }),
    );
    expect(result.status).toBe(404);
  });

  it("rejects an origin with no registered app", async () => {
    const db = seed();
    const result = await recordSubscription(db.client as any, baseInput({ origin: "https://evil.com" }));
    expect(result.status).toBe(403);
  });

  it("rejects an app that is 'legado' (not instalando/ativo)", async () => {
    const db = seed();
    const result = await recordSubscription(
      db.client as any,
      baseInput({ origin: "https://legado.example" }),
    );
    expect(result.status).toBe(403);
  });

  it.each([
    ["empty string", ""],
    ["the literal 'undefined'", "undefined"],
    ["the literal 'null'", "null"],
    ["the literal '0'", "0"],
    ["a number", 42],
    ["a string over 128 chars", "x".repeat(129)],
    ["an id that doesn't exist", "ext-does-not-exist"],
  ])("leaves the subscription anonymous and creates no player for %s", async (_label, playerId) => {
    const db = seed();
    const result = await recordSubscription(db.client as any, baseInput({ playerId }));
    expect(result.status).toBe(200);
    expect(db.rows("players")).toHaveLength(1); // unchanged — no insert
    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0].player_id).toBeNull();
  });

  it("links an existing player and records player_linked_at on the app", async () => {
    const db = seed();
    const result = await recordSubscription(db.client as any, baseInput({ playerId: "ext-1" }));
    expect(result.status).toBe(200);

    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0].player_id).toBe("player-1");
    expect(subs[0].linked_at).toBeTruthy();

    const app = db.rows("tenant_webpush_apps").find((row) => row.id === "app-ativo");
    expect(app?.player_linked_at).toBeTruthy();
  });

  it("flips status to 'inativa' on a second call with optedIn:false, keeping the same clickKey", async () => {
    const db = seed();
    const first = await recordSubscription(db.client as any, baseInput({ optedIn: true }));
    const second = await recordSubscription(db.client as any, baseInput({ optedIn: false }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    if (first.status === 200 && second.status === 200) {
      expect(second.clickKey).toBe(first.clickKey);
    }

    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("inativa");
  });

  it("without a subscriptionId only records script_seen_at on the app", async () => {
    const db = seed();
    const result = await recordSubscription(
      db.client as any,
      baseInput({ subscriptionId: null }),
    );
    expect(result).toEqual({ status: 200, clickKey: null });
    expect(db.rows("push_subscriptions")).toHaveLength(0);

    const app = db.rows("tenant_webpush_apps").find((row) => row.id === "app-ativo");
    expect(app?.script_seen_at).toBeTruthy();
  });

  it("returns the same clickKey across repeated calls", async () => {
    const db = seed();
    const first = await recordSubscription(db.client as any, baseInput());
    const second = await recordSubscription(db.client as any, baseInput());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    if (first.status === 200 && second.status === 200) {
      expect(first.clickKey).toBeTruthy();
      expect(second.clickKey).toBe(first.clickKey);
    }
    expect(db.rows("push_subscriptions")).toHaveLength(1);
  });
});
