import { describe, expect, it } from "vitest";
import {
  canSendWithinBurstLimit,
  processWebpushCampaignTick,
  refundOrThrow,
  WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE,
  WEBPUSH_SETTLEMENT_NO_BALANCE_MESSAGE,
  type WebpushBatchRow,
  type WebpushCampaignRow,
  type WebpushDispatchBatch,
  type WebpushDispatchDeps,
  type WebpushLogRow,
} from "./campaign-dispatch.server";
import { deterministicUuid, type OneSignalSendResult } from "./onesignal.server";

const rowId = (n: number) => `row-${String(n).padStart(6, "0")}`;
let batchCounter = 0;
const nextBatchId = () => `batch-${String(++batchCounter).padStart(6, "0")}`;
/** Matches the fake wallet's own pricing below (`reserve`'s `units * UNIT_PRICE`). */
const UNIT_PRICE = 0.01;

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
 * In-memory world mirroring the REAL wallet SQL's two load-bearing
 * properties (pinned independently against PGlite in
 * wallet-reserve-refund-semantics.db.test.ts):
 *   - a mutation dedupes FOREVER on idempotencyKey — reserving again with a
 *     key already used (even if that reservation was since refunded)
 *     returns `idempotent: true` and charges nothing new;
 *   - a refund targets only the newest (here: the current, since this
 *     fake — like the real dispatcher — never reuses a referenceId for two
 *     different charges) reservation for a referenceId, and refunding the
 *     same referenceId again is a no-op.
 * `logged` mirrors `webpush_send_logs`: `nextBatch` excludes rows that have
 * one, the same way the real `webpush_campaign_batch` RPC does.
 */
function world(opts: { appStats?: Map<string, { sentLast15m: number; active: number }> } = {}) {
  const state = {
    clock: 0,
    subs: [] as WebpushBatchRow[],
    /** Simulates a push_subscriptions row deleted (player/app cascade) after its batch was created. */
    deletedRowIds: new Set<string>(),
    logged: new Set<string>(),
    ledger: new Map<string, { referenceId: string; units: number; refunded: boolean }>(),
    refundedReferenceIds: new Set<string>(),
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
    batches: new Map<string, WebpushDispatchBatch>(),
    credentialsOf: (appRowId: string) => ({ appId: `onesignal-${appRowId}`, apiKey: `key-${appRowId}` }),
  };

  const deps: WebpushDispatchDeps = {
    now: () => new Date(state.clock),
    async nextBatch(_c, after, limit) {
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
    async acquireBudget() {
      return true;
    },
    async createBatch(input) {
      const batch: WebpushDispatchBatch = {
        id: nextBatchId(),
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        appId: input.appId,
        subscriptionRowIds: input.subscriptionRowIds,
        units: input.units,
        status: "pendente",
        accepted: null,
        refusedRowIds: null,
        onesignalNotificationId: null,
        lastError: null,
      };
      state.batches.set(batch.id, batch);
      return batch;
    },
    async listOpenBatches(campaignId) {
      return [...state.batches.values()]
        .filter((b) => b.campaignId === campaignId && b.status !== "concluido")
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async updateBatch(batchId, patch) {
      const existing = state.batches.get(batchId);
      if (!existing) throw new Error(`batch not found: ${batchId}`);
      const updated: WebpushDispatchBatch = {
        ...existing,
        ...("status" in patch ? { status: patch.status as WebpushDispatchBatch["status"] } : {}),
        ...("accepted" in patch ? { accepted: patch.accepted as number | null } : {}),
        ...("refused_row_ids" in patch
          ? { refusedRowIds: patch.refused_row_ids as string[] | null }
          : {}),
        ...("onesignal_notification_id" in patch
          ? { onesignalNotificationId: patch.onesignal_notification_id as string | null }
          : {}),
        ...("last_error" in patch ? { lastError: patch.last_error as string | null } : {}),
      };
      state.batches.set(batchId, updated);
      return updated;
    },
    async rowDetails(subscriptionRowIds) {
      const byId = new Map(state.subs.map((r) => [r.subscriptionRowId, r]));
      // Mirrors a real `select ... where id in (...)`: a deleted row is
      // simply absent from the result, never synthesized.
      return subscriptionRowIds
        .filter((id) => !state.deletedRowIds.has(id))
        .map((id) => {
          const r = byId.get(id);
          return { subscriptionRowId: id, subscriptionId: r?.subscriptionId ?? id, playerId: r?.playerId ?? null };
        });
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
      if (existing) {
        // Real semantics: the key dedupes forever, refunded or not.
        state.reserveIdempotentFlags.push(true);
        return { ok: true, idempotent: true, exempt: false, amount: 0, balance: 1000 };
      }
      state.reserveIdempotentFlags.push(false);
      state.ledger.set(args.idempotencyKey, { referenceId: args.referenceId, units: args.units, refunded: false });
      return { ok: true, idempotent: false, exempt: false, amount: args.units * UNIT_PRICE, balance: 1000 };
    },
    async refund(args) {
      state.refundCalls.push({ referenceId: args.referenceId, idempotencyKey: args.idempotencyKey });
      if (state.refundedReferenceIds.has(args.referenceId)) return; // already_refunded, no-op
      // Real semantics: targets the (here: the only) reservation for this referenceId.
      for (const entry of state.ledger.values()) {
        if (entry.referenceId === args.referenceId) entry.refunded = true;
      }
      state.refundedReferenceIds.add(args.referenceId);
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
    async concludedTotals(campaignId) {
      let maxRowId: string | null = null;
      let sent = 0;
      let failed = 0;
      for (const b of state.batches.values()) {
        if (b.campaignId !== campaignId || b.status !== "concluido") continue;
        const accepted = b.accepted ?? 0;
        sent += accepted;
        failed += b.units - accepted;
        for (const id of b.subscriptionRowIds) {
          if (maxRowId === null || id > maxRowId) maxRowId = id;
        }
      }
      return { maxRowId, sent, failed };
    },
  };

  return { state, deps };
}

const lastPatch = (patches: Record<string, unknown>[]) => patches[patches.length - 1];

/**
 * Net amount currently reserved-and-not-refunded in the fake ledger — the
 * real "how much is the house actually out" number, computed independently
 * of whatever `sent`/`failed` the tick reports. Pins "accepted × price"
 * directly instead of trusting the tick's own counters, which is exactly
 * the kind of double-charge/free-retry bug this fake's ledger exists to
 * catch (see the module doc comment above).
 */
function netCharge(state: ReturnType<typeof world>["state"]): number {
  let total = 0;
  for (const entry of state.ledger.values()) {
    if (!entry.refunded) total += entry.units * UNIT_PRICE;
  }
  return total;
}

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

  it("two apps in the same page: one OneSignal call per app with the right credentials, no denial", async () => {
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

  it("OneSignal accepts only part of the batch (invalid_player_ids): net charge = accepted only", async () => {
    const { state, deps } = world();
    state.subs = [sub(1), sub(2), sub(3)];
    state.sendResponder = async () => ({
      ok: true,
      notificationId: "note-1",
      invalidSubscriptionIds: ["s2"],
    });
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    // Initial reserve(3), refund it, fresh reserve(2) under ":ajuste".
    expect(state.reserveCalls.map((c) => c.units)).toEqual([3, 2]);
    expect(state.reserveCalls[1].referenceId).toBe(`${state.reserveCalls[0].referenceId}:ajuste`);
    expect(state.reserveCalls[1].idempotencyKey).toBe(state.reserveCalls[1].referenceId);
    expect(state.refundCalls).toHaveLength(1);
    expect(state.deactivated).toEqual([rowId(2)]);
    expect(state.logs.filter((l) => l.status === "enviado")).toHaveLength(2);
    expect(state.logs.filter((l) => l.status === "recusado")).toHaveLength(1);
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.status).toBe("enviado");
    expect(netCharge(state)).toBeCloseTo(2 * UNIT_PRICE, 6); // accepted × price, not 3 × price
  });

  it("permanent send failure, all invalid: net charge is 0 (reserved then fully refunded); subscriptions stay 'ativa'", async () => {
    const { state, deps } = world();
    state.subs = [sub(1), sub(2)];
    state.sendResponder = async () => ({ ok: false, temporary: false, status: 400, error: "bad request" });
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.reserveCalls).toHaveLength(1);
    expect(state.refundCalls).toHaveLength(1);
    expect(state.refundCalls[0].referenceId).toBe(state.reserveCalls[0].referenceId);
    expect(state.logs.every((l) => l.status === "recusado")).toBe(true);
    expect(state.logs).toHaveLength(2);
    // Ruling correction (fix round 2): a `falhou` batch's failure is about
    // the WHOLE call (bad key, malformed request, ...), not about any one
    // subscription's validity — `deactivate` must never be called for it.
    // Only an ok:true send's `invalidSubscriptionIds` (OneSignal itself
    // reporting "not subscribed") ever deactivates anything (see the
    // "OneSignal accepts only part of the batch" test above).
    expect(state.deactivated).toEqual([]);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(2);
    // Nothing was ever actually sent (every row failed permanently), so the
    // campaign is reported `falhou`, same formula as "no recipient resolved"
    // elsewhere in the codebase (sent === 0 && failed > 0).
    expect(r.status).toBe("falhou");
    expect(netCharge(state)).toBe(0);
  });

  it("'Saldo insuficiente' on the initial reservation pauses the campaign before any send; the batch stays pendente (never deleted)", async () => {
    const { state, deps } = world();
    state.subs = [sub(1)];
    deps.reserve = async () => ({ ok: false, error: "Saldo insuficiente" });
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(0);
    // Fix round 2: deleting the batch here was the bug — nothing was ever
    // charged (a failed reserve writes no ledger row), so there's nothing
    // to clean up; keeping it `pendente` is what lets the next resume
    // retry THIS SAME batch instead of a sibling batch's cursor advancing
    // past its never-sent rows (see the multi-app test below).
    expect(state.batches.size).toBe(1);
    expect([...state.batches.values()][0].status).toBe("pendente");
    expect(r.status).toBe("pausada");
    expect(lastPatch(state.patches)).toMatchObject({
      status: "pausada",
      last_error: WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE,
      locked_by: null,
    });
  });

  describe("Review Focus (fix round 2): 'Saldo insuficiente' on one batch of a multi-app page must never let the cursor skip its rows", () => {
    it("app A's reserve fails first; app B's batch is never even attempted; a later tick (after top-up) sends BOTH, cursor covers both", async () => {
      const { state, deps } = world();
      // app-b's row has the HIGHEST id — if app-a's failed batch were
      // deleted (the old bug) and app-b were left to finish on its own, the
      // cursor-flush would advance past app-a's never-sent row forever.
      state.subs = [sub(1, "app-a"), sub(2, "app-b")];
      let reserveCalls = 0;
      const realReserve = deps.reserve;
      deps.reserve = async (args) => {
        reserveCalls++;
        if (reserveCalls === 1) return { ok: false, error: "Saldo insuficiente" };
        return realReserve(args);
      };

      const tick1 = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      expect(tick1.status).toBe("pausada");
      expect(state.sendCalls).toHaveLength(0); // app-b's batch was created but never even reached
      expect(state.batches.size).toBe(2); // BOTH batches exist — neither was deleted
      expect([...state.batches.values()].map((b) => b.status)).toEqual(["pendente", "pendente"]);
      expect(lastPatch(state.patches).sent_cursor).toBeUndefined(); // cursor untouched

      // "Top-up": every reserve from here on succeeds.
      const tick2 = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(2); // both app-a and app-b now sent
      expect(tick2.status).toBe("enviado");
      expect(tick2.sent).toBe(2);
      expect(netCharge(state)).toBeCloseTo(2 * UNIT_PRICE, 6);
    });
  });

  it("a burst-limit denial sends nothing and leaves the status unchanged (cursor unchanged too)", async () => {
    const { state, deps } = world({
      appStats: new Map([["app-1", { sentLast15m: 4001, active: 1000 }]]),
    });
    state.subs = Array.from({ length: 1000 }, (_, i) => sub(i + 1));
    const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

    expect(state.sendCalls).toHaveLength(0);
    expect(state.batches.size).toBe(0);
    expect(r.status).toBe("enviando");
    expect(r.sent).toBe(0);
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviando" });
  });

  describe("Review Focus: cursor never skips a denied app's rows in a multi-app page", () => {
    it("app A sent, app B's burst denied → cursor unchanged this tick; a later tick (B's burst clear) sends BOTH again, since no batch exists yet for either", async () => {
      const { state, deps } = world({
        appStats: new Map([
          ["app-a", { sentLast15m: 0, active: 10_000 }],
          ["app-b", { sentLast15m: 0, active: 0 }], // denied: 0 active subscriptions, any batch > 0 is over 5x0
        ]),
      });
      // app-a's row has the HIGHEST id in the page — if the cursor were
      // naively advanced to "the last processed row", it would skip app-b's
      // (lower-id) row forever.
      state.subs = [sub(1, "app-b"), sub(2, "app-a")];

      const c = campaign();
      const tick1 = await processWebpushCampaignTick(c, deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(0); // all-or-nothing: app-a never batched either
      expect(state.batches.size).toBe(0);
      expect(tick1.status).toBe("enviando");
      expect(lastPatch(state.patches).sent_cursor).toBeUndefined();

      // Later tick: app-b's burst now clears.
      deps.appStats = async (appId) =>
        appId === "app-b" ? { sentLast15m: 0, active: 1000 } : { sentLast15m: 0, active: 10_000 };
      const tick2 = await processWebpushCampaignTick(c, deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(2);
      expect(tick2.status).toBe("enviado");
      expect(tick2.sent).toBe(2);
    });
  });

  describe("Review Focus: crash-safe idempotency with the real wallet semantics", () => {
    it("429 then retry succeeds: total charge = accepted x price, not free (the critical bug)", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      let calls = 0;
      state.sendResponder = async () => {
        calls++;
        if (calls === 1) return { ok: false, temporary: true, status: 429, error: "rate limited" };
        return { ok: true, notificationId: "note-1", invalidSubscriptionIds: [] };
      };

      // Tick 1: 429 stops the tick (the batch stays `pendente`, WITH its
      // reservation — never refunded). Tick 2 (a later scheduled run) resumes
      // the same batch and succeeds.
      const c = campaign();
      const tick1 = await processWebpushCampaignTick(c, deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(1);
      expect(state.refundCalls).toHaveLength(0); // temporary failure never refunds
      expect(tick1.status).toBe("enviando");

      const tick2 = await processWebpushCampaignTick(c, deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(2);
      expect(state.sendCalls[0].idempotencyKey).toBe(state.sendCalls[1].idempotencyKey);
      // Exactly ONE reservation ever created for the initial charge (a
      // second "reserve" call on resume must be idempotent) — never
      // refunded by the 429, so the retry is NOT free.
      const initialReserveCalls = state.reserveCalls.filter((c) => !c.referenceId.includes(":ajuste"));
      expect(initialReserveCalls.length).toBeGreaterThanOrEqual(1);
      expect(state.reserveIdempotentFlags.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      expect(state.refundCalls).toHaveLength(0);
      expect(tick2.status).toBe("enviado");
      expect(tick2.sent).toBe(2); // charged for 2, not 0
      expect(netCharge(state)).toBeCloseTo(2 * UNIT_PRICE, 6);
    });

    it("crash after send (ok) and before settlement: retry converges to the same accepted charge, no duplicate log", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      state.sendResponder = async () => ({
        ok: true,
        notificationId: "note-1",
        invalidSubscriptionIds: ["s2"],
      });
      let updateBatchCalls = 0;
      const realUpdateBatch = deps.updateBatch;
      deps.updateBatch = async (id, patch) => {
        updateBatchCalls++;
        // Crash right when the batch is about to move from 'pendente' to 'enviado'.
        if (updateBatchCalls === 1) throw new Error("crash after send, before persisting enviado");
        return realUpdateBatch(id, patch);
      };

      await expect(
        processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 }),
      ).rejects.toThrow("crash after send");
      expect(state.sendCalls).toHaveLength(1);

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      expect(state.sendCalls).toHaveLength(2);
      expect(state.sendCalls[0].idempotencyKey).toBe(state.sendCalls[1].idempotencyKey);
      expect(state.logs.filter((l) => l.status === "enviado")).toHaveLength(1);
      expect(state.logs.filter((l) => l.status === "recusado")).toHaveLength(1);
      expect(r.status).toBe("enviado");
      expect(r.sent).toBe(1);
    });

    it("crash after the settlement refund and before the :ajuste reserve: retry converges (no double charge, no lost charge)", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      state.sendResponder = async () => ({
        ok: true,
        notificationId: "note-1",
        invalidSubscriptionIds: ["s2"],
      });
      let refundCalls = 0;
      const realRefund = deps.refund;
      deps.refund = async (args) => {
        refundCalls++;
        await realRefund(args);
        if (refundCalls === 1) throw new Error("crash after refund, before :ajuste reserve");
      };

      await expect(
        processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 }),
      ).rejects.toThrow("crash after refund");
      // The refund itself went through before the crash.
      expect(state.refundCalls).toHaveLength(1);

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      // Refund is retried (idempotent no-op) and the :ajuste reserve finally runs once.
      expect(state.refundCalls).toHaveLength(2);
      const ajusteReserves = state.reserveCalls.filter((c) => c.referenceId.endsWith(":ajuste"));
      expect(ajusteReserves).toHaveLength(1);
      expect(ajusteReserves[0].units).toBe(1);
      expect(r.status).toBe("enviado");
      expect(r.sent).toBe(1);
      expect(netCharge(state)).toBeCloseTo(1 * UNIT_PRICE, 6); // the accepted unit only, not 2
    });

    it("crash right after the :ajuste reserve succeeds (before marking liquidado): retry converges without a second charge", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      state.sendResponder = async () => ({
        ok: true,
        notificationId: "note-1",
        invalidSubscriptionIds: ["s2"],
      });
      let updateBatchCalls = 0;
      const realUpdateBatch = deps.updateBatch;
      deps.updateBatch = async (id, patch) => {
        updateBatchCalls++;
        // 1st updateBatch call = pendente->enviado (let it through); crash on
        // the 2nd, which is the enviado->liquidado transition right after
        // the :ajuste reserve succeeded.
        if (updateBatchCalls === 2) throw new Error("crash after :ajuste reserve, before liquidado");
        return realUpdateBatch(id, patch);
      };

      await expect(
        processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 }),
      ).rejects.toThrow("crash after :ajuste");
      const ajusteReservesAfterCrash = state.reserveCalls.filter((c) => c.referenceId.endsWith(":ajuste"));
      expect(ajusteReservesAfterCrash).toHaveLength(1);

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      // Retried settlement: refund is re-attempted (no-op) and the :ajuste
      // reserve is re-attempted too, but must come back idempotent — never a
      // second charge.
      const ajusteReservesTotal = state.reserveCalls.filter((c) => c.referenceId.endsWith(":ajuste"));
      expect(ajusteReservesTotal.length).toBeGreaterThanOrEqual(1);
      const idempotentAjuste = state.reserveIdempotentFlags.filter(
        (_, i) => state.reserveCalls[i].referenceId.endsWith(":ajuste"),
      );
      expect(idempotentAjuste.some((v) => v === true) || ajusteReservesTotal.length === 1).toBe(true);
      expect(r.status).toBe("enviado");
      expect(r.sent).toBe(1);
    });

    it("the :ajuste reserve failing (no balance) pauses the campaign; the batch stays settleable and a later tick (after top-up) settles before sending anything new", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2), sub(3)];
      state.sendResponder = async () => ({
        ok: true,
        notificationId: "note-1",
        invalidSubscriptionIds: ["s2"],
      });
      let adjustShouldFail = true;
      const realReserve = deps.reserve;
      deps.reserve = async (args) => {
        if (args.referenceId.endsWith(":ajuste") && adjustShouldFail) {
          state.reserveCalls.push({
            referenceId: args.referenceId,
            idempotencyKey: args.idempotencyKey,
            units: args.units,
          });
          return { ok: false, error: "Saldo insuficiente" };
        }
        return realReserve(args);
      };

      const r1 = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      expect(r1.status).toBe("pausada");
      expect(lastPatch(state.patches)).toMatchObject({
        status: "pausada",
        last_error: WEBPUSH_SETTLEMENT_NO_BALANCE_MESSAGE,
      });
      // The batch is still around (not concluded, not deleted) — settlement
      // retries it before anything new is fetched.
      expect(state.logs).toHaveLength(0);

      adjustShouldFail = false; // "top-up"
      const r2 = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      expect(r2.status).toBe("enviado");
      expect(state.sendCalls).toHaveLength(1); // no new send: same batch, just settled
      expect(r2.sent).toBe(2);
      expect(r2.failed).toBe(1);
    });

    it("page drift: a subscription inserted between crash and retry does not join the open (already-sized) batch — it gets its own, later batch", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      let sendCalls = 0;
      state.sendResponder = async () => {
        sendCalls++;
        if (sendCalls === 1) throw new Error("crash during send");
        return { ok: true, notificationId: "note-1", invalidSubscriptionIds: [] };
      };

      await expect(
        processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 }),
      ).rejects.toThrow("crash during send");

      // Drift: a third subscription shows up before the retry.
      state.subs.push(sub(3));

      // One call resumes the open (already-sized) batch to completion, then
      // naturally pages on to fetch the next page — which now includes the
      // drifted row as its OWN, separate batch (never merged into the first).
      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
      // 3 send attempts total: the crashed one (s1,s2), its successful retry
      // (s1,s2 again — the SAME stored ids, never the drifted s3), and the
      // drifted row's own, separate batch (s3).
      expect(state.sendCalls).toHaveLength(3);
      expect(state.sendCalls[0].subscriptionIds).toEqual(["s1", "s2"]); // crashed attempt
      expect(state.sendCalls[1].subscriptionIds).toEqual(["s1", "s2"]); // resumed batch, unchanged
      expect(state.sendCalls[2].subscriptionIds).toEqual(["s3"]); // the drifted row, its own later batch
      expect(r.status).toBe("enviado");
      expect(r.sent).toBe(3);
    });
  });

  describe("Review Focus (fix round 2 — controller ruling): a subscription deleted while its batch is open", () => {
    it("a row removed by a player/app cascade is refused, not charged, not logged, not deactivated — never blocks the campaign", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2), sub(3)];
      // Row 2's push_subscriptions row is gone by the time the batch is
      // advanced (player or app deleted while the batch sat `pendente`).
      state.deletedRowIds.add(rowId(2));

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

      // Never sent to OneSignal: the send list is derived from rows that
      // still exist, not from the batch's original stored id count.
      expect(state.sendCalls[0].subscriptionIds).toEqual(["s1", "s3"]);
      // Never charged: `accepted` is 2 (rows.length, not the original 3),
      // so the batch is fully accepted and settles with no refund/adjust.
      expect(netCharge(state)).toBeCloseTo(2 * UNIT_PRICE, 6);
      // Never logged (an insert would fail its FK against push_subscriptions
      // forever) and never deactivated (nothing to deactivate).
      expect(state.logs.map((l) => l.subscriptionRowId).sort()).toEqual(
        [rowId(1), rowId(3)].sort(),
      );
      expect(state.deactivated).toEqual([]);
      expect(r.status).toBe("enviado");
      expect(r.sent).toBe(2);
    });

    it("a row that disappears between settlement and the logging step is dropped from logs/marks/deactivate, not retried forever", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)];
      state.sendResponder = async () => ({
        ok: true,
        notificationId: "note-1",
        invalidSubscriptionIds: ["s2"], // row 2 refused by OneSignal itself
      });
      // Row 1 (the ACCEPTED one) disappears only after settlement — i.e. the
      // batch already reached `liquidado` with accepted=1 before this.
      let updateBatchCalls = 0;
      const realUpdateBatch = deps.updateBatch;
      deps.updateBatch = async (id, patch) => {
        updateBatchCalls++;
        const result = await realUpdateBatch(id, patch);
        if (updateBatchCalls === 2) state.deletedRowIds.add(rowId(1)); // right after liquidado is persisted
        return result;
      };

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

      // Row 1 was charged (it was genuinely accepted before it vanished)
      // but is never logged/marked/deactivated once gone; row 2 (refused,
      // never charged) is logged `recusado` and deactivated as usual.
      expect(state.logs.map((l) => l.subscriptionRowId)).toEqual([rowId(2)]);
      expect(state.marks).toEqual([{ sentIds: [], failedIds: [rowId(2)] }]);
      expect(state.deactivated).toEqual([rowId(2)]);
      expect(r.status).toBe("enviado");
    });
  });

  describe("Review Focus (fix round 2 — controller ruling): the lock-token guard must stop the tick immediately, not just the report", () => {
    it("a lost lock at the cursor flush stops before fetching a new page or creating any new batch", async () => {
      const { state, deps } = world();
      state.subs = [sub(1), sub(2)]; // one page, one batch
      let nextBatchCalls = 0;
      const realNextBatch = deps.nextBatch;
      deps.nextBatch = async (c, after, limit) => {
        nextBatchCalls++;
        return realNextBatch(c, after, limit);
      };
      const realUpdateCampaign = deps.updateCampaign;
      deps.updateCampaign = async (c, patch) => {
        // Another worker re-claimed the campaign exactly at the cursor flush.
        if ("sent_cursor" in patch) return false;
        return realUpdateCampaign(c, patch);
      };

      const r = await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });

      // The one batch from the first (and only) page fetch still ran its
      // own money/log steps to completion (those aren't gated by the
      // campaign's lock) — but the tick must stop right there: no second
      // page fetch, no second batch, under a lock this worker no longer holds.
      expect(nextBatchCalls).toBe(1);
      expect(state.batches.size).toBe(1);
      expect([...state.batches.values()][0].status).toBe("concluido");
      expect(r.status).toBe("enviando");
    });
  });

  it("the OneSignal idempotency key is a deterministic hash of the batch id (referenceId)", async () => {
    const { state, deps } = world();
    state.subs = [sub(1)];
    await processWebpushCampaignTick(campaign(), deps, { deadline: 1_000_000 });
    expect(state.sendCalls[0].idempotencyKey).toBe(
      await deterministicUuid(state.reserveCalls[0].referenceId),
    );
  });
});

describe("refundOrThrow (fix round 2 — the real wallet_refund wiring must never swallow an error)", () => {
  type FakeRpcDb = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };

  function fakeDb(response: { data?: unknown; error?: { message: string } | null }): FakeRpcDb {
    return {
      rpc: async () => ({ data: response.data ?? null, error: response.error ?? null }),
    };
  }

  const args = {
    tenantId: "00000000-0000-4000-8000-000000000001",
    referenceId: "batch-x",
    idempotencyKey: "batch-x:refund",
    reason: "test",
  };

  it("throws on a transport/RPC error (never silently swallows it)", async () => {
    const db = fakeDb({ error: { message: "connection reset" } });
    await expect(refundOrThrow(db, args)).rejects.toThrow(/connection reset/);
  });

  it("throws when wallet_refund refuses for a reason other than 'nothing left to refund'", async () => {
    const db = fakeDb({ data: { ok: false, reason: "idempotency_key_conflict" } });
    await expect(refundOrThrow(db, args)).rejects.toThrow(/idempotency_key_conflict/);
  });

  it("resolves (does not throw) when the reservation was already refunded by a previous attempt", async () => {
    const db = fakeDb({ data: { ok: false, reason: "already_refunded" } });
    await expect(refundOrThrow(db, args)).resolves.toBeUndefined();
  });

  it("resolves (does not throw) when the reservation was never found (settled by a previous attempt)", async () => {
    const db = fakeDb({ data: { ok: false, reason: "reservation_not_found" } });
    await expect(refundOrThrow(db, args)).resolves.toBeUndefined();
  });

  it("resolves on a genuine success", async () => {
    const db = fakeDb({ data: { ok: true, idempotent: false, amount: 0.02, balance: 10 } });
    await expect(refundOrThrow(db, args)).resolves.toBeUndefined();
  });
});
