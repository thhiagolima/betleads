// Web push (OneSignal) — Task 8: recordSubscription. Uses createFakeDb (the
// in-memory Supabase query-builder stand-in already used by the SMS bulk
// path) so these are fast unit tests, not a DB test.
import { describe, expect, it } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { recordSubscription } from "./subscriptions.server";

const TENANT = "tenant-1";
const TOKEN = "tok-1";

function seed() {
  // Mirrors the real `UNIQUE (app_id, subscription_id)` constraint on
  // push_subscriptions (20261210100000_webpush_core.sql) so the conflict
  // path can be exercised deterministically below.
  const db = createFakeDb({ unique: { push_subscriptions: [["app_id", "subscription_id"]] } });
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
  db.rows("players").push(
    { id: "player-1", tenant_id: TENANT, player_external_id: "ext-1" },
    { id: "player-2", tenant_id: TENANT, player_external_id: "ext-2" },
  );
  return db;
}

function baseInput(overrides: Partial<Parameters<typeof recordSubscription>[1]> = {}) {
  return {
    token: TOKEN,
    origin: "https://casa.example",
    subscriptionId: "aaaaaaaa-0000-4000-8000-000000000001",
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
    expect(db.rows("players")).toHaveLength(2); // unchanged — no insert
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

  it("keeps a previous link when a later call has a garbage/unknown playerId", async () => {
    const db = seed();
    await recordSubscription(db.client as any, baseInput({ playerId: "ext-1" }));
    const result = await recordSubscription(db.client as any, baseInput({ playerId: "ext-does-not-exist" }));
    expect(result.status).toBe(200);

    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0].player_id).toBe("player-1"); // unchanged — not cleared
  });

  it("re-links to a different existing player on a later call (design §5.4: liga ou religa)", async () => {
    const db = seed();
    await recordSubscription(db.client as any, baseInput({ playerId: "ext-1" }));
    const result = await recordSubscription(db.client as any, baseInput({ playerId: "ext-2" }));
    expect(result.status).toBe(200);

    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0].player_id).toBe("player-2"); // re-linked
    expect(subs[0].linked_at).toBeTruthy();
  });

  it("falls back to updating the row when a concurrent report wins the insert race (23505)", async () => {
    const db = seed();
    const RACE_SUBSCRIPTION_ID = "aaaaaaaa-0000-4000-8000-0000000000ff";
    let selectCalls = 0;
    const realFrom = db.client.from;
    const wrappedDb = {
      ...db.client,
      from: (table: string) => {
        const builder = realFrom(table);
        if (table !== "push_subscriptions") return builder;
        const originalMaybeSingle = builder.maybeSingle.bind(builder);
        builder.maybeSingle = async () => {
          selectCalls += 1;
          if (selectCalls === 1) {
            // Simulate another request's report landing its insert for the
            // same (app_id, subscription_id) right after our select saw
            // nothing — the row below is what that concurrent insert would
            // have created.
            db.rows("push_subscriptions").push({
              id: "race-row",
              tenant_id: TENANT,
              app_id: "app-ativo",
              subscription_id: RACE_SUBSCRIPTION_ID,
              click_key: "race-click-key",
              status: "ativa",
              user_agent: "other-ua",
              player_id: null,
              first_seen_at: "2020-01-01T00:00:00.000Z",
              last_seen_at: "2020-01-01T00:00:00.000Z",
              linked_at: null,
            });
            return { data: null, error: null };
          }
          return originalMaybeSingle();
        };
        return builder;
      },
    };

    const result = await recordSubscription(
      wrappedDb as any,
      baseInput({ subscriptionId: RACE_SUBSCRIPTION_ID }),
    );

    expect(result.status).toBe(200);
    if (result.status === 200) expect(result.clickKey).toBe("race-click-key");

    const subs = db
      .rows("push_subscriptions")
      .filter((r) => r.subscription_id === RACE_SUBSCRIPTION_ID);
    expect(subs).toHaveLength(1); // no duplicate row from the losing insert
    expect(subs[0].first_seen_at).toBe("2020-01-01T00:00:00.000Z"); // preserved
    expect(subs[0].last_seen_at).not.toBe("2020-01-01T00:00:00.000Z"); // updated
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

  it.each([
    ["the literal 'undefined'", "undefined"],
    ["a non-UUID slug", "sub-1"],
    ["a bare number", "12345"],
    ["a UUID-shaped string over 64 chars", "aaaaaaaa-0000-4000-8000-000000000001".padEnd(65, "a")],
  ])("rejects a junk subscriptionId (%s) with 400 and no write", async (_label, subscriptionId) => {
    const db = seed();
    const result = await recordSubscription(db.client as any, baseInput({ subscriptionId }));
    expect(result.status).toBe(400);
    expect(db.rows("push_subscriptions")).toHaveLength(0);
  });

  it("truncates a user_agent over 512 chars before writing it", async () => {
    const db = seed();
    const longUa = "x".repeat(600);
    const result = await recordSubscription(db.client as any, baseInput({ userAgent: longUa }));
    expect(result.status).toBe(200);
    const subs = db.rows("push_subscriptions");
    expect(subs).toHaveLength(1);
    expect((subs[0].user_agent as string).length).toBe(512);
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
