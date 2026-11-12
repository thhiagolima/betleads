// V1-03: a voice send creates a `voice_campaigns` row and links every queue
// item to it; the campaigns hub lists those rows plus the older queue items
// (no campaign) grouped by trigger_name; a cancel closes the campaign.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SCRIPT = "00000000-0000-4000-8000-0000000000aa";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const calls = vi.hoisted(() => ({ runVoiceQueueDispatcher: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./calls.server", () => ({
  runVoiceQueueDispatcher: calls.runVoiceQueueDispatcher,
  VOICE_INSUFFICIENT_BALANCE_MESSAGE: "Saldo insuficiente",
}));
vi.mock("./tenant-access.server", () => ({
  resolveOperationalTenantId: vi.fn(async () => TENANT),
}));
vi.mock("./tenant-channels.server", () => ({ assertChannelEnabled: vi.fn(async () => undefined) }));

import { bulkDispatchCallsFor } from "./calls-bulk.server";
import {
  cancelVoiceCampaignFor,
  listVoiceCampaignsFor,
  syncVoiceCampaignAfterItemCancel,
} from "./voice-campaigns.server";

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    lead_id: null,
    phone_number: `55119${String(i).padStart(8, "0")}`,
  }));

type Row = Record<string, unknown>;

// public.voice_campaign_item_counts over the fake rows: grouped by (campaign,
// status, provider_status, time still ahead); RLS keeps the active house.
function itemCountsRpc(args: Row) {
  const ids = args.p_campaign_ids as string[];
  const now = Date.parse(String(args.p_now));
  const groups = new Map<string, Row & { ids: string[] }>();
  for (const r of fake.db.rows("call_queue")) {
    if (r.tenant_id !== TENANT || !ids.includes(String(r.voice_campaign_id))) continue;
    const time = Date.parse(String(r.scheduled_at ?? r.created_at ?? ""));
    const isFuture = Number.isFinite(time) && time > now;
    const key = [r.voice_campaign_id, r.status, r.provider_status ?? "", isFuture].join("|");
    const group = groups.get(key) ?? {
      voice_campaign_id: r.voice_campaign_id,
      status: r.status,
      provider_status: r.provider_status ?? null,
      is_future: isFuture,
      ids: [],
    };
    group.ids.push(String(r.id));
    groups.set(key, group);
  }
  return {
    data: [...groups.values()].map(({ ids: itemIds, ...row }) => ({
      ...row,
      item_count: itemIds.length,
      sample_item_id: itemIds.length === 1 ? itemIds[0] : null,
    })),
    error: null,
  };
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.db.reset();
  fake.db.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
  fake.db.onRpc("voice_campaign_item_counts", itemCountsRpc);
  calls.runVoiceQueueDispatcher
    .mockReset()
    .mockResolvedValue({ dispatched: 1, deferred: 0, failed: 0, insufficientBalance: 0 });
});

describe("voice campaign creation", () => {
  it("creates the campaign and links every queued item (chunked inserts > 500)", async () => {
    const result = await bulkDispatchCallsFor(
      fake.db.client as never,
      { script_id: SCRIPT, campaign_name: "Reativação", targets: many(1_250) },
      { userId: "user-1" },
    );

    const [campaign] = fake.db.rows("voice_campaigns");
    expect(fake.db.rows("voice_campaigns")).toHaveLength(1);
    expect(campaign).toMatchObject({
      tenant_id: TENANT,
      name: "Reativação",
      dispatch_mode: "cml",
      script_id: SCRIPT,
      voice_asset_id: null,
      recipient_count: 1_250,
      created_by: "user-1",
      status: "sending",
    });
    const rows = fake.db.rows("call_queue");
    expect(rows).toHaveLength(1_250);
    expect(
      rows.every((r) => r.voice_campaign_id === campaign.id && r.dispatch_mode === "cml"),
    ).toBe(true);
    // Three chunks of at most 500.
    expect(fake.db.calls.filter((c) => c.table === "call_queue" && c.op === "insert")).toHaveLength(
      3,
    );
    expect(result).toMatchObject({ voiceCampaignId: campaign.id, enfileirado: true });
  });

  it("a scheduled send creates a scheduled campaign", async () => {
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    await bulkDispatchCallsFor(fake.db.client as never, {
      script_id: SCRIPT,
      targets: many(2),
      scheduled_at: at,
    });
    expect(fake.db.rows("voice_campaigns")[0]).toMatchObject({
      status: "scheduled",
      scheduled_at: at,
      name: "Campanha de voz",
    });
  });

  it("links the inline (Disparar agora) items too", async () => {
    await bulkDispatchCallsFor(fake.db.client as never, {
      script_id: SCRIPT,
      targets: many(3),
    });
    const [campaign] = fake.db.rows("voice_campaigns");
    const rows = fake.db.rows("call_queue");
    expect(rows).toHaveLength(3);
    expect(calls.runVoiceQueueDispatcher).toHaveBeenCalledTimes(3);
    expect(
      rows.every((r) => r.voice_campaign_id === campaign.id && r.dispatch_mode === "cml"),
    ).toBe(true);
  });

  it("creates no queue item (and dials nothing) when the campaign insert fails", async () => {
    fake.db.failNext("voice_campaigns", "insert", "permission denied");
    await expect(
      bulkDispatchCallsFor(fake.db.client as never, { script_id: SCRIPT, targets: many(3) }),
    ).rejects.toThrow("Não foi possível criar a campanha de voz: permission denied");
    await expect(
      bulkDispatchCallsFor(fake.db.client as never, { script_id: SCRIPT, targets: many(700) }),
    ).resolves.toBeTruthy();
    // Only the second (successful) send queued anything.
    expect(fake.db.rows("voice_campaigns")).toHaveLength(1);
    expect(fake.db.rows("call_queue")).toHaveLength(700);
    expect(calls.runVoiceQueueDispatcher).not.toHaveBeenCalled();
  });

  it("stops a half-queued campaign when a later chunk fails", async () => {
    const base = fake.db.client;
    let inserts = 0;
    const client = {
      ...base,
      from: (table: string) => {
        const builder = base.from(table);
        if (table !== "call_queue") return builder;
        const insert = builder.insert;
        builder.insert = (value: unknown) => {
          inserts += 1;
          if (inserts === 2) fake.db.failNext("call_queue", "insert", "timeout");
          return insert(value);
        };
        return builder;
      },
    };
    await expect(
      bulkDispatchCallsFor(client as never, { script_id: SCRIPT, targets: many(1_200) }),
    ).rejects.toThrow("timeout");
    const rows = fake.db.rows("call_queue");
    expect(rows).toHaveLength(500);
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("cancelled");
  });
});

describe("Disparar agora (inline) and the campaign status", () => {
  it("cancels the campaign when no queue item could be inserted", async () => {
    for (let i = 0; i < 3; i++) fake.db.failNext("call_queue", "insert", "permission denied");
    const result = await bulkDispatchCallsFor(fake.db.client as never, {
      script_id: SCRIPT,
      targets: many(3),
    });
    expect(result).toMatchObject({ failed: 3, queued: 0 });
    expect(fake.db.rows("call_queue")).toHaveLength(0);
    expect(calls.runVoiceQueueDispatcher).not.toHaveBeenCalled();
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("cancelled");
  });

  it("keeps the campaign sending when at least one item was inserted", async () => {
    fake.db.failNext("call_queue", "insert", "permission denied");
    await bulkDispatchCallsFor(fake.db.client as never, { script_id: SCRIPT, targets: many(2) });
    expect(fake.db.rows("call_queue")).toHaveLength(1);
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("sending");
  });

  it("stops inserting and dialing once the campaign is cancelled", async () => {
    // The hub cancels the campaign while the first call is being dialed.
    calls.runVoiceQueueDispatcher.mockImplementationOnce(async () => {
      fake.db.rows("voice_campaigns")[0].status = "cancelled";
      return { dispatched: 1, deferred: 0, failed: 0, insufficientBalance: 0 };
    });
    const result = await bulkDispatchCallsFor(fake.db.client as never, {
      script_id: SCRIPT,
      targets: many(4),
    });
    expect(calls.runVoiceQueueDispatcher).toHaveBeenCalledTimes(1);
    expect(fake.db.rows("call_queue")).toHaveLength(1);
    expect(fake.db.rows("call_queue")[0].status).toBe("audio_ready");
    expect(result).toMatchObject({ queued: 1, failed: 0, notAttempted: 0, campaignCancelled: 3 });
    expect(result.results.slice(1)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          ok: false,
          not_attempted: true,
          error: "Não tentado: campanha cancelada",
        }),
      ),
    );
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("cancelled");
  });

  it("never revives an item cancelled between its insert and audio_ready", async () => {
    const base = fake.db.client;
    let readyUpdates = 0;
    const client = {
      ...base,
      from: (table: string) => {
        const builder = base.from(table);
        if (table !== "call_queue") return builder;
        const update = builder.update;
        builder.update = (value: Row) => {
          if (value.status === "audio_ready" && ++readyUpdates === 2) {
            // cancelVoiceCampaignFor ran right after the second insert.
            for (const r of fake.db.rows("call_queue")) {
              if (r.status === "pending_audio") r.status = "cancelled";
            }
            fake.db.rows("voice_campaigns")[0].status = "cancelled";
          }
          return update(value);
        };
        return builder;
      },
    };
    const result = await bulkDispatchCallsFor(client as never, {
      script_id: SCRIPT,
      targets: many(3),
    });
    expect(calls.runVoiceQueueDispatcher).toHaveBeenCalledTimes(1);
    expect(fake.db.rows("call_queue").map((r) => r.status)).toEqual(["audio_ready", "cancelled"]);
    expect(result).toMatchObject({ queued: 1, failed: 0, campaignCancelled: 2 });
  });
});

describe("voice campaign listing", () => {
  const now = new Date("2026-11-11T12:00:00.000Z").getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("lists campaign entities with item counters and keeps the legacy grouping", async () => {
    fake.db.rows("voice_campaigns").push(
      {
        id: "vc-1",
        tenant_id: TENANT,
        name: "Nova",
        status: "sending",
        scheduled_at: at(-10),
        created_at: at(-10),
        recipient_count: 3,
      },
      {
        id: "vc-2",
        tenant_id: TENANT,
        name: "Agendada",
        status: "scheduled",
        scheduled_at: at(60),
        created_at: at(-5),
        recipient_count: 1,
      },
      // Another house: never listed.
      {
        id: "vc-x",
        tenant_id: "other",
        name: "Outra casa",
        status: "scheduled",
        scheduled_at: at(60),
        created_at: at(-5),
      },
    );
    const item = (id: string, extra: Record<string, unknown>) => ({
      id,
      tenant_id: TENANT,
      created_at: at(-10),
      scheduled_at: at(-10),
      ...extra,
    });
    fake.db.rows("call_queue").push(
      item("q1", { voice_campaign_id: "vc-1", status: "completed" }),
      item("q2", { voice_campaign_id: "vc-1", status: "failed" }),
      item("q3", { voice_campaign_id: "vc-1", status: "waiting_provider" }),
      item("q4", { voice_campaign_id: "vc-2", status: "audio_ready", scheduled_at: at(60) }),
      // Legacy: no campaign, grouped by trigger_name like before.
      item("l1", { voice_campaign_id: null, status: "completed", trigger_name: "Antiga" }),
      item("l2", { status: "completed", trigger_name: "Antiga" }),
    );

    const { campaigns } = await listVoiceCampaignsFor(fake.db.client as never, now);

    expect(campaigns.map((c) => c.name)).toEqual(["Agendada", "Nova", "Antiga"]);
    expect(campaigns[1]).toMatchObject({
      id: "vc-1",
      isCampaign: true,
      total: 3,
      sent: 2,
      completed: 1,
      failed: 1,
      finished: 2,
      status: "enviando",
      campaignStatus: "sending",
      itemIds: [],
    });
    expect(campaigns[0]).toMatchObject({
      id: "vc-2",
      status: "agendada",
      total: 1,
      itemIds: ["q4"],
    });
    expect(campaigns[2]).toMatchObject({
      id: "l1",
      isCampaign: false,
      campaignStatus: null,
      total: 2,
      completed: 2,
      status: "concluida",
    });
  });

  it("derives finished when no item is pending", async () => {
    fake.db.rows("voice_campaigns").push({
      id: "vc-1",
      tenant_id: TENANT,
      name: "Feita",
      status: "sending",
      scheduled_at: at(-10),
      created_at: at(-10),
    });
    fake.db
      .rows("call_queue")
      .push(
        { id: "q1", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "completed" },
        { id: "q2", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "cancelled" },
      );
    const { campaigns } = await listVoiceCampaignsFor(fake.db.client as never, now);
    expect(campaigns[0]).toMatchObject({ status: "concluida", campaignStatus: "finished" });
  });

  it("asks the database for the counters (one rpc, no item paging)", async () => {
    fake.db
      .rows("voice_campaigns")
      .push(
        { id: "vc-1", tenant_id: TENANT, name: "A", status: "sending", created_at: at(-10) },
        { id: "vc-2", tenant_id: TENANT, name: "B", status: "sending", created_at: at(-20) },
      );
    const rpcArgs: Row[] = [];
    fake.db.onRpc("voice_campaign_item_counts", (args) => {
      rpcArgs.push(args);
      return itemCountsRpc(args);
    });
    await listVoiceCampaignsFor(fake.db.client as never, now);
    expect(rpcArgs).toEqual([
      { p_campaign_ids: ["vc-1", "vc-2"], p_now: new Date(now).toISOString() },
    ]);
    // Only the legacy read touches call_queue directly.
    expect(fake.db.calls.filter((c) => c.table === "call_queue")).toHaveLength(1);
  });

  it("a sending campaign with no item for over 10 minutes is shown cancelled", async () => {
    fake.db
      .rows("voice_campaigns")
      .push(
        { id: "vc-old", tenant_id: TENANT, name: "Velha", status: "sending", created_at: at(-11) },
        { id: "vc-new", tenant_id: TENANT, name: "Nova", status: "sending", created_at: at(-1) },
      );
    const { campaigns } = await listVoiceCampaignsFor(fake.db.client as never, now);
    const byId = Object.fromEntries(campaigns.map((c) => [c.id, c]));
    expect(byId["vc-old"]).toMatchObject({ status: "cancelada", campaignStatus: "cancelled" });
    expect(byId["vc-new"]).toMatchObject({ status: "enviando", campaignStatus: "sending" });
  });
});

describe("voice campaign cancel", () => {
  it("cancels the unclaimed items and marks the campaign cancelled", async () => {
    fake.db.rows("voice_campaigns").push({ id: "vc-1", tenant_id: TENANT, status: "scheduled" });
    fake.db
      .rows("call_queue")
      .push(
        { id: "q1", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "audio_ready" },
        { id: "q2", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "calling" },
        { id: "q3", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "completed" },
        { id: "q4", tenant_id: TENANT, voice_campaign_id: "vc-other", status: "audio_ready" },
      );

    const result = await cancelVoiceCampaignFor(fake.db.client as never, "vc-1");

    expect(result).toEqual({ ok: true, cancelled: 1 });
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("cancelled");
    expect(fake.db.rows("call_queue").map((r) => r.status)).toEqual([
      "cancelled",
      "calling",
      "completed",
      "audio_ready",
    ]);
  });

  it("never cancels a campaign of another house (super admin on house A)", async () => {
    fake.db.rows("voice_campaigns").push({ id: "vc-b", tenant_id: "tenant-b", status: "sending" });
    fake.db
      .rows("call_queue")
      .push({ id: "qb", tenant_id: "tenant-b", voice_campaign_id: "vc-b", status: "audio_ready" });
    await expect(cancelVoiceCampaignFor(fake.db.client as never, "vc-b")).rejects.toThrow(
      "Campanha de voz não encontrada.",
    );
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("sending");
    expect(fake.db.rows("call_queue")[0].status).toBe("audio_ready");
  });

  it("refuses without an active house", async () => {
    fake.db.onRpc("current_tenant_id", () => ({ data: null, error: null }));
    fake.db.rows("voice_campaigns").push({ id: "vc-1", tenant_id: TENANT, status: "scheduled" });
    await expect(cancelVoiceCampaignFor(fake.db.client as never, "vc-1")).rejects.toThrow(
      "Casa ativa não encontrada.",
    );
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("scheduled");
  });

  it("refuses an unknown campaign", async () => {
    await expect(cancelVoiceCampaignFor(fake.db.client as never, "nope")).rejects.toThrow(
      "Campanha de voz não encontrada.",
    );
  });

  it("closes the campaign when its last pending item is cancelled in the queue", async () => {
    fake.db.rows("voice_campaigns").push({ id: "vc-1", tenant_id: TENANT, status: "scheduled" });
    fake.db
      .rows("call_queue")
      .push(
        { id: "q1", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "cancelled" },
        { id: "q2", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "audio_ready" },
      );
    await syncVoiceCampaignAfterItemCancel(fake.db.client as never, "q1");
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("scheduled");

    fake.db.rows("call_queue")[1].status = "cancelled";
    await syncVoiceCampaignAfterItemCancel(fake.db.client as never, "q2");
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("cancelled");
  });

  it("a campaign with completed calls ends as finished, legacy items are ignored", async () => {
    fake.db.rows("voice_campaigns").push({ id: "vc-1", tenant_id: TENANT, status: "sending" });
    fake.db
      .rows("call_queue")
      .push(
        { id: "q1", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "completed" },
        { id: "q2", tenant_id: TENANT, voice_campaign_id: "vc-1", status: "cancelled" },
        { id: "l1", tenant_id: TENANT, voice_campaign_id: null, status: "cancelled" },
      );
    await syncVoiceCampaignAfterItemCancel(fake.db.client as never, "q2");
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("finished");
    await syncVoiceCampaignAfterItemCancel(fake.db.client as never, "l1");
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("finished");
  });

  it("leaves a campaign of another house alone after an item cancel", async () => {
    fake.db.rows("voice_campaigns").push({ id: "vc-b", tenant_id: "tenant-b", status: "sending" });
    fake.db
      .rows("call_queue")
      .push({ id: "qb", tenant_id: "tenant-b", voice_campaign_id: "vc-b", status: "cancelled" });
    await syncVoiceCampaignAfterItemCancel(fake.db.client as never, "qb");
    expect(fake.db.rows("voice_campaigns")[0].status).toBe("sending");
  });
});
