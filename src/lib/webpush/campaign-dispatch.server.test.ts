import { describe, expect, it } from "vitest";
import {
  canSendWithinBurstLimit,
  processWebpushCampaignTick,
  type WebpushBatchRow,
  type WebpushCampaignRow,
  type WebpushDispatchDeps,
  type WebpushLogRow,
} from "./campaign-dispatch.server";
import { deterministicUuid, type OneSignalSendResult } from "./onesignal.server";

const rowId = (n: number) => `row-${String(n).padStart(6, "0")}`;

function campaign(over: Partial<WebpushCampaignRow> = {}): WebpushCampaignRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "00000000-0000-4000-8000-000000000001",
    name: "Black Friday",
    title: "Depósito liberado!",
    body: "Aproveite agora.",
    url: "https://casa.example.com/promo",
    image_url: null,
    audience_kind: "todos",
    audience_criteria: null,
    target_player_ids: null,
    status: "enviando",
    scheduled_at: "2026-11-05T12:00:00Z",
    locked_at: "2026-11-05T12:00:00Z",
    locked_by: "lock-1",
    sent_cursor: null,
    target_count: 0,
    sent_count: 0,
    failed_count: 0,
    last_error: null,
    created_by: null,
    ...over,
  };
}

function sub(n: number, appId = "app-1"): WebpushBatchRow {
  return {
    subscriptionRowId: rowId(n),
    subscriptionId: `s${n}`,
    playerId: `p${n}`,
    appId,
    onesignalAppId: `onesignal-${appId}`,
    clickKey: `ck${n}`,
  };
}

type ReserveCall = { referenceId: string; idempotencyKey: string; units: number };

/**
 * In-memory world mirroring the real schema's invariants:
 *  - `logged` (webpush_send_logs) excludes rows from future `nextBatch` pages,
 *    the same way `webpush_campaign_batch`'s NOT EXISTS clause does;
 *  - `ledger` dedupes reservations by idempotency key, and only a refunded
 *    reservation is "spent" again — the same shape as `wallet_reserve`.
 */
function world(opts: { appStats?: Map<string, { sentLast15m: number; active: number }> } = {}) {
  const state = {
    clock: 0,
    subs: [] as WebpushBatchRow[],
    logged: new Set<string>(),
    ledger: new Map<string, { units: number; refunded: boolean }>(),
    refundCalls: [] as { referenceId: string; idempotencyKey: string }[],
    reserveCalls: [] as ReserveCall[],
    reserveIdempotentFlags: [] as boolean[],
    sendCalls: [] as { appId: string; apiKey: string; subscriptionIds: string[]; idempotencyKey: string }[],
    sendResponder: async (
      _input: Parameters<WebpushDispatchDeps["send"]>[0],
    ): Promise<OneSignalSendResult> => ({
      ok: true,
      notificationId: "note-1",
      invalidSubscriptionIds: [],
    }),
    deactivated: [] as string[],
    logs: [] as WebpushLogRow[],
    marks: [] as { sentIds: string[]; failedIds: string[] }[],
    patches: [] as Record<string, unknown>[],
    credentialsOf: (appRowId: string) => ({ appId: `onesignal-${appRowId}`, apiKey: `key-${appRowId}` }),
  };

  const deps: WebpushDispatchDeps = {
    now: () => new Date(state.clock),
    async nextBatch(c, after, limit) {
      return state.subs
        .filter((r) => !state.logged.has(r.subscriptionRowId))
        .filter((r) => !after || r.subscriptionRowId > after)
        .sort((a, b) => (a.subscriptionRowId < b.subscriptionRowId ? -1 : 1))
        .slice(0, limit);
    },
    async appStats(appId) {
      return opts.appStats?.get(appId) ?? { sentLast15m: 0, active: 10_000 };
    },
    async credentials(appRowId) {
      return state.credentialsOf(appRowId);
    },
    async prepareDispatches() {
      // no-op: tracked links are not under test here.
    },
    async markDispatches(args) {
      state.marks.push({ sentIds: args.sentIds, failedIds: args.failedIds });
    },
    async reserve(args) {
      state.reserveCalls.push({
        referenceId: args.referenceId,
        idempotencyKey: args.idempotencyKey,
        units: args.units,
      });
      const existing = state.ledger.get(args.idempotencyKey);
      if (existing && !existing.refunded) {
        state.reserveIdempotentFlags.push(true);
        return { ok: true, idempotent: true, exempt: false, amount: 0, balance: 1000 };
      }
      state.reserveIdempotentFlags.push(false);
      state.ledger.set(args.idempotencyKey, { units: args.units, refunded: false });
      return { ok: true, idempotent: false, exempt: false, amount: args.units * 0.01, balance: 1000 };
    },
    async refund(args) {
      state.refundCalls.push({ referenceId: args.referenceId, idempotencyKey: args.idempotencyKey });
      // wallet_refund looks up the reservation by referenceId: find the
      // (not yet refunded) ledger entry whose key starts with it.
      for (const [key, entry] of state.ledger) {
        if ((key === args.referenceId || key.startsWith(`${args.referenceId}:`)) && !entry.refunded) {
          entry.refunded = true;
        }
      }
    },
    async send(input) {
      state.sendCalls.push({
        appId: input.appId,
        apiKey: input.apiKey,
        subscriptionIds: input.subscriptionIds,
        idempotencyKey: input.idempotencyKey,
      });
      return state.sendResponder(input);
    },
    async deactivate(subscriptionRowIds) {
      state.deactivated.push(...subscriptionRowIds);
    },
    async writeLogs(rows) {
      for (const r of rows) state.logged.add(r.subscriptionRowId);
      state.logs.push(...rows);
    },
    async updateCampaign(_c, patch) {
      state.patches.push(patch);
      return true;
    },
    async acquireBudget() {
      return true;
    },
  };

  return { state, deps };
}

const lastPatch = (patches: Record<string, unknown>[]) => patches[patches.length - 1];

describe("canSendWithinBurstLimit", () => {
  it("allows exactly 5x active subscriptions", () => {
    expect(canSendWithinBurstLimit(4000, 1000, 1000)).toBe(true);
  });
  it("denies one push over the limit", () => {
    expect(canSendWithinBurstLimit(4001, 1000, 1000)).toBe(false);
  });
});

describe("processWebpushCampaignTick", () => {
  it("pages 2500 subscriptions into 3 OneSignal calls (1000/1000/500) and finishes 'enviado'", async () => {
    const { state, deps } = world();
    state.subs = Array.from({ length: 2500 }, (_, i) => sub(i + 1));
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
    expect(state.sendCalls.map((c) => c.subscriptionIds.length)).toEqual([1000, 1000, 500]);
    expect(r.status).toBe("enviado");
    expect(r.sent).toBe(2500);
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviado", locked_by: null });
  });

  it("Review Focus 2: OneSignal accepts only part of the batch (invalid_player_ids)", async () => {
    const { state, deps } = world();
    state.subs = [sub(1), sub(2), sub(3)];
    state.sendResponder = async () => ({
      ok: true,
      notificationId: "note-1",
      invalidSubscriptionIds: ["s2"],
    });
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.reserveCalls.map((c) => c.units)).toEqual([3, 2]);
    expect(state.reserveCalls[1].idempotencyKey).toBe(`${state.reserveCalls[0].referenceId}:ajuste`);
    expect(state.refundCalls).toHaveLength(1);
    expect(state.deactivated).toEqual([rowId(2)]);
    expect(state.logs.filter((l) => l.status === "enviado")).toHaveLength(2);
    expect(state.logs.filter((l) => l.status === "recusado")).toHaveLength(1);
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.status).toBe("enviado");
  });

  it("Review Focus 3: a crash after send and before the checkpoint is retried with the same idempotency key, no double charge or duplicate log", async () => {
    const { state, deps } = world();
    state.subs = [sub(1)];
    let writeLogsCalls = 0;
    const realWriteLogs = deps.writeLogs;
    deps.writeLogs = async (rows) => {
      writeLogsCalls++;
      if (writeLogsCalls === 1) throw new Error("worker crashed before checkpoint");
      return realWriteLogs(rows);
    };

    await expect(
      processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 }),
    ).rejects.toThrow("worker crashed");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.reserveCalls).toHaveLength(1);

    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(2);
    expect(state.sendCalls[0].idempotencyKey).toBe(state.sendCalls[1].idempotencyKey);
    expect(state.reserveCalls).toHaveLength(2);
    expect(state.reserveCalls[0].idempotencyKey).toBe(state.reserveCalls[1].idempotencyKey);
    expect(state.reserveIdempotentFlags).toEqual([false, true]);
    expect(state.logs).toHaveLength(1);
    expect(r.status).toBe("enviado");
    expect(r.sent).toBe(1);

    // The OneSignal idempotency key is a deterministic hash of the reference id.
    expect(state.sendCalls[0].idempotencyKey).toBe(
      await deterministicUuid(state.reserveCalls[0].referenceId),
    );
  });

  it("'Saldo insuficiente' pauses the campaign before any send", async () => {
    const { state, deps } = world();
    state.subs = [sub(1)];
    deps.reserve = async () => ({ ok: false, error: "Saldo insuficiente" });
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(0);
    expect(r.status).toBe("pausada");
    expect(lastPatch(state.patches)).toMatchObject({
      status: "pausada",
      last_error: "Saldo insuficiente",
      locked_by: null,
    });
  });

  it("a temporary provider failure (e.g. 429) refunds, leaves the cursor untouched and keeps status 'enviando'", async () => {
    const { state, deps } = world();
    state.subs = [sub(1)];
    state.sendResponder = async () => ({
      ok: false,
      temporary: true,
      status: 429,
      error: "rate limited",
    });
    const r = await processWebpushCampaignTick(campaign({ sent_cursor: null }), deps, {
      deadline: 1_000_000,
    });

    expect(state.refundCalls).toHaveLength(1);
    expect(r.status).toBe("enviando");
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviando", sent_cursor: null });
    expect(state.logs).toHaveLength(0);
  });

  it("a burst-limit denial sends nothing and leaves the status unchanged", async () => {
    const { state, deps } = world({
      appStats: new Map([["app-1", { sentLast15m: 4001, active: 1000 }]]),
    });
    state.subs = Array.from({ length: 1000 }, (_, i) => sub(i + 1));
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(0);
    expect(r.status).toBe("enviando");
    expect(r.sent).toBe(0);
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviando" });
  });

  it("two apps in the same batch: one OneSignal call per app with the right credentials", async () => {
    const { state, deps } = world();
    state.subs = [sub(1, "app-a"), sub(2, "app-a"), sub(3, "app-b")];
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(2);
    const byApp = new Map(state.sendCalls.map((c) => [c.appId, c]));
    expect(byApp.get("onesignal-app-a")?.subscriptionIds).toEqual(["s1", "s2"]);
    expect(byApp.get("onesignal-app-b")?.subscriptionIds).toEqual(["s3"]);
    expect(byApp.get("onesignal-app-a")?.apiKey).toBe("key-app-a");
    expect(byApp.get("onesignal-app-b")?.apiKey).toBe("key-app-b");
    expect(r.sent).toBe(3);
    expect(r.status).toBe("enviado");
  });
});
