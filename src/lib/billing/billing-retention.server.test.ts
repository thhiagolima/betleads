import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { purgeOldWebhookBodies, WEBHOOK_BODY_RETENTION_DAYS } from "./billing-retention.server";

beforeEach(() => {
  fake.admin.reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purgeOldWebhookBodies", () => {
  it("keeps calling the batch RPC with 90 days until a batch comes back short", async () => {
    const results = [3, 3, 1];
    const calls: Record<string, unknown>[] = [];
    fake.admin.onRpc("billing_purge_webhook_bodies", (args) => {
      calls.push(args);
      return { data: results.shift() ?? 0, error: null };
    });
    const result = await purgeOldWebhookBodies({ batchSize: 3, maxBatches: 10 });
    expect(result).toEqual({ purged: 7, batches: 3, ok: true });
    expect(WEBHOOK_BODY_RETENTION_DAYS).toBe(90);
    expect(calls).toEqual([
      { _older_than_days: 90, _limit: 3 },
      { _older_than_days: 90, _limit: 3 },
      { _older_than_days: 90, _limit: 3 },
    ]);
  });

  it("stops at maxBatches so one run stays bounded", async () => {
    fake.admin.onRpc("billing_purge_webhook_bodies", () => ({ data: 2, error: null }));
    const result = await purgeOldWebhookBodies({ batchSize: 2, maxBatches: 4 });
    expect(result).toEqual({ purged: 8, batches: 4, ok: true });
  });

  it("never throws: an RPC error or exception ends the stage with ok=false", async () => {
    fake.admin.onRpc("billing_purge_webhook_bodies", () => ({
      data: null,
      error: { message: "boom" },
    }));
    expect(await purgeOldWebhookBodies()).toEqual({ purged: 0, batches: 0, ok: false });

    fake.admin.onRpc("billing_purge_webhook_bodies", () => {
      throw new Error("network");
    });
    expect(await purgeOldWebhookBodies()).toEqual({ purged: 0, batches: 0, ok: false });
  });
});
