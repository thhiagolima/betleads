// Web push (OneSignal) — Task 9: prepareWebpushDispatches, markWebpushDispatches
// and resolveWebpushClick. Mocks @/integrations/supabase/client.server so the
// internal getOrCreateFirstPartyTrackedLink (shortio.server.ts, hardwired to
// supabaseAdmin) and buildFirstPartyClickUrl (click-tracking.server.ts) write
// to / read from the same in-memory fake db instance that is also passed
// explicitly as `db` to the functions under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "@/lib/sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import {
  campaignPushUrl,
  markWebpushDispatches,
  prepareWebpushDispatches,
  resolveWebpushClick,
} from "./links.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000c1";
const CAMPAIGN_URL = "https://casa.bet/promo";

const SUB_IDENTIFIED = "00000000-0000-4000-8000-0000000000s1";
const SUB_ANON = "00000000-0000-4000-8000-0000000000s2";
const PLAYER = "00000000-0000-4000-8000-0000000000p1";

beforeEach(() => {
  fake.db.reset();
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
  vi.stubEnv("CLICK_TRACKING_SECRET", "x".repeat(40));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedCampaign(url = CAMPAIGN_URL) {
  fake.db.rows("webpush_campaigns").push({ id: CAMPAIGN, tenant_id: TENANT, url });
}

function seedSubscription(id: string, clickKey: string) {
  fake.db.rows("push_subscriptions").push({ id, tenant_id: TENANT, click_key: clickKey });
}

describe("campaignPushUrl", () => {
  it("builds the literal Liquid placeholder, not URL-encoded", () => {
    expect(campaignPushUrl("https://app.example", CAMPAIGN)).toBe(
      `https://app.example/api/public/push/c/${CAMPAIGN}/{{ blk | default: "x" }}`,
    );
  });

  it("strips a trailing slash from apiBase", () => {
    expect(campaignPushUrl("https://app.example/", CAMPAIGN)).toBe(
      `https://app.example/api/public/push/c/${CAMPAIGN}/{{ blk | default: "x" }}`,
    );
  });
});

describe("prepareWebpushDispatches", () => {
  it("creates one dispatch per recipient, player-bound or hashed, under one first-party tracked link", async () => {
    await prepareWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      url: CAMPAIGN_URL,
      recipients: [
        { subscriptionRowId: SUB_IDENTIFIED, playerId: PLAYER },
        { subscriptionRowId: SUB_ANON, playerId: null },
      ],
    });

    const tracked = fake.db.rows("tracked_links");
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ tenant_id: TENANT, original_url: CAMPAIGN_URL, status: "failed" });
    expect(String(tracked[0].shortio_link_id)).toMatch(/^first-party:/);

    const dispatches = fake.db.rows("link_dispatches");
    expect(dispatches).toHaveLength(2);
    for (const dispatch of dispatches) {
      expect(dispatch).toMatchObject({
        tenant_id: TENANT,
        tracked_link_id: tracked[0].id,
        channel: "webpush",
        source_type: "campaign",
        source_id: CAMPAIGN,
        original_url: CAMPAIGN_URL,
        sent_url: campaignPushUrl("https://app.example", CAMPAIGN),
        send_status: "prepared",
      });
      expect(typeof dispatch.tracking_token).toBe("string");
    }

    const identified = dispatches.find((d) => d.recipient_player_id === PLAYER);
    expect(identified).toBeTruthy();
    expect(identified!.recipient_hash).toBeNull();
    expect(identified!.idempotency_key).toBe(`webpush:${CAMPAIGN}:${SUB_IDENTIFIED}:0`);

    const anon = dispatches.find((d) => d.recipient_player_id == null);
    expect(anon).toBeTruthy();
    expect(typeof anon!.recipient_hash).toBe("string");
    expect(anon!.recipient_hash).not.toBe("");
    expect(anon!.idempotency_key).toBe(`webpush:${CAMPAIGN}:${SUB_ANON}:0`);
  });

  it("is idempotent: calling again for the same campaign/subscription does not duplicate", async () => {
    const run = () =>
      prepareWebpushDispatches(fake.db.client, {
        tenantId: TENANT,
        campaignId: CAMPAIGN,
        url: CAMPAIGN_URL,
        recipients: [{ subscriptionRowId: SUB_IDENTIFIED, playerId: PLAYER }],
      });
    await run();
    await run();

    expect(fake.db.rows("link_dispatches")).toHaveLength(1);
    expect(fake.db.rows("tracked_links")).toHaveLength(1);
  });

  it("does nothing for an empty recipient list", async () => {
    await prepareWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      url: CAMPAIGN_URL,
      recipients: [],
    });
    expect(fake.db.rows("link_dispatches")).toHaveLength(0);
    expect(fake.db.rows("tracked_links")).toHaveLength(0);
  });
});

describe("markWebpushDispatches", () => {
  it("marks sent and failed dispatches by subscription id", async () => {
    await prepareWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      url: CAMPAIGN_URL,
      recipients: [
        { subscriptionRowId: SUB_IDENTIFIED, playerId: PLAYER },
        { subscriptionRowId: SUB_ANON, playerId: null },
      ],
    });
    const sentAt = new Date("2026-11-05T12:00:00Z");

    await markWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      sentIds: [SUB_IDENTIFIED],
      failedIds: [SUB_ANON],
      sentAt,
    });

    const dispatches = fake.db.rows("link_dispatches");
    const sent = dispatches.find((d) => d.recipient_player_id === PLAYER)!;
    const failed = dispatches.find((d) => d.recipient_player_id == null)!;
    expect(sent.send_status).toBe("sent");
    expect(sent.sent_at).toBe(sentAt.toISOString());
    expect(failed.send_status).toBe("failed");
  });
});

describe("resolveWebpushClick", () => {
  it("valid key + sent dispatch resolves to the signed first-party click URL", async () => {
    seedCampaign();
    seedSubscription(SUB_IDENTIFIED, "a".repeat(32));
    await prepareWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      url: CAMPAIGN_URL,
      recipients: [{ subscriptionRowId: SUB_IDENTIFIED, playerId: PLAYER }],
    });
    await markWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      sentIds: [SUB_IDENTIFIED],
      failedIds: [],
      sentAt: new Date("2026-11-05T12:00:00Z"),
    });
    const [dispatch] = fake.db.rows("link_dispatches");

    const destination = await resolveWebpushClick(fake.db.client, {
      campaignId: CAMPAIGN,
      key: "a".repeat(32),
    });

    const url = new URL(destination);
    expect(url.origin).toBe("https://app.example");
    expect(url.pathname).toBe(`/api/public/click/${dispatch.tracking_token}`);
    expect(url.searchParams.get("s")).toBeTruthy();
  });

  it("the dispatch is still 'prepared' (not yet sent): falls back to the campaign URL", async () => {
    seedCampaign();
    seedSubscription(SUB_IDENTIFIED, "b".repeat(32));
    await prepareWebpushDispatches(fake.db.client, {
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      url: CAMPAIGN_URL,
      recipients: [{ subscriptionRowId: SUB_IDENTIFIED, playerId: PLAYER }],
    });

    const destination = await resolveWebpushClick(fake.db.client, {
      campaignId: CAMPAIGN,
      key: "b".repeat(32),
    });
    expect(destination).toBe(CAMPAIGN_URL);
  });

  it.each([
    ["the OneSignal fallback literal", "x"],
    ["an empty key", ""],
    ["unrendered Liquid", "{{ blk }}"],
    ["URL-encoded unrendered Liquid", "%7B%7B%20blk%20%7D%7D"],
    ["an unknown but well-formed 32-hex key", "f".repeat(32)],
  ])("%s falls back to the campaign URL without a 404", async (_label, key) => {
    seedCampaign();
    const destination = await resolveWebpushClick(fake.db.client, { campaignId: CAMPAIGN, key });
    expect(destination).toBe(CAMPAIGN_URL);
  });

  it("an unknown campaign falls back to PUBLIC_APP_URL", async () => {
    const destination = await resolveWebpushClick(fake.db.client, {
      campaignId: "00000000-0000-4000-8000-000000000000",
      key: "a".repeat(32),
    });
    expect(destination).toBe("https://app.example");
  });

  it("an invalid (non-UUID) campaignId falls back to PUBLIC_APP_URL without querying", async () => {
    const destination = await resolveWebpushClick(fake.db.client, {
      campaignId: "not-a-uuid",
      key: "a".repeat(32),
    });
    expect(destination).toBe("https://app.example");
    // No lookups were attempted against webpush_campaigns.
    expect(fake.db.calls.some((c) => c.table === "webpush_campaigns")).toBe(false);
  });

  it("a click_key belonging to a different tenant's subscription is ignored", async () => {
    const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a9";
    seedCampaign();
    fake.db.rows("push_subscriptions").push({
      id: SUB_IDENTIFIED,
      tenant_id: OTHER_TENANT,
      click_key: "c".repeat(32),
    });

    const destination = await resolveWebpushClick(fake.db.client, {
      campaignId: CAMPAIGN,
      key: "c".repeat(32),
    });
    expect(destination).toBe(CAMPAIGN_URL);
  });
});
