import { describe, expect, it } from "vitest";
import { campaignDeliveryKey } from "./campaign-recipients";
import {
  MAX_ZERO_GRANTS,
  processSmsCampaignTick,
  type CampaignDispatchDeps,
  type CampaignTarget,
  type SendOutcome,
  type SmsCampaignRow,
} from "./sms-campaign-dispatch.server";

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const phone = (n: number) => `+55119${String(n).padStart(8, "0")}`;

function campaign(recipients: CampaignTarget[], over: Partial<SmsCampaignRow> = {}): SmsCampaignRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "00000000-0000-4000-8000-000000000001",
    name: "Black Friday",
    content: "Oi {nome}",
    route: "iGaming",
    recipients,
    total_count: recipients.length,
    sent_count: 0,
    deduplicated_count: 0,
    failed_count: 0,
    scheduled_at: "2026-10-15T12:00:00Z",
    sent_cursor: 0,
    last_error: null,
    rate_per_minute: 1000,
    track_links: true,
    locked_by: "lock-1",
    ...over,
  };
}

/**
 * In-memory world: `accepted` plays sms_send_logs (keys the provider accepted),
 * `events` records the order of sends and cursor checkpoints.
 */
function world(opts: { clockStepMs?: number; budget?: (want: number) => number } = {}) {
  const state = {
    clock: 0,
    accepted: new Set<string>(),
    sendCalls: [] as string[],
    events: [] as Array<{ type: "send"; key: string } | { type: "cursor"; cursor: number }>,
    patches: [] as Record<string, unknown>[],
    unresolved: null as unknown,
    failCursorWrite: false,
    blockedPlayers: new Set<string>(),
  };
  const deps: CampaignDispatchDeps = {
    now: () => state.clock,
    async resolveRecipients(_tenant, inputs) {
      const assignments = inputs.map((t) =>
        t.phone.endsWith("9")
          ? { phone: t.phone, playerId: null, reason: "sem_cadastro" as const }
          : { phone: t.phone, playerId: `p-${t.phone}`, reason: null },
      );
      return {
        resolved: [],
        unresolved: [],
        duplicates: 0,
        assignments,
      };
    },
    async updateCampaign(_c, patch) {
      if ("sent_cursor" in patch) {
        if (state.failCursorWrite) throw new Error("worker crashed before checkpoint");
        state.events.push({ type: "cursor", cursor: Number(patch.sent_cursor) });
      }
      state.patches.push(patch);
      return true;
    },
    async persistUnresolved(_id, unresolved) {
      state.unresolved = unresolved;
    },
    async acquireSendBudget(_tenant, want) {
      return opts.budget ? opts.budget(want) : want;
    },
    async checkContactLimits(_tenant, playerIds) {
      return new Map(
        playerIds.map((id) => [
          id,
          { allowed: !state.blockedPlayers.has(id), retryAt: "2026-10-15T13:00:00Z" },
        ]),
      );
    },
    async findAcceptedDeliveryKeys(keys) {
      return new Set(keys.filter((k) => state.accepted.has(k)));
    },
    async loadPlayerVariables() {
      return new Map();
    },
    async send({ deliveryKey }) {
      state.clock += opts.clockStepMs ?? 0;
      state.sendCalls.push(deliveryKey);
      state.events.push({ type: "send", key: deliveryKey });
      if (state.accepted.has(deliveryKey)) return { ok: true, alreadySent: true };
      state.accepted.add(deliveryKey);
      return { ok: true };
    },
  };
  return { state, deps };
}

const lastPatch = (patches: Record<string, unknown>[]) => patches[patches.length - 1];

describe("processSmsCampaignTick", () => {
  it("sends to the resolved recipients and reports the rest (5% unresolved → 95% sent)", async () => {
    const recipients: CampaignTarget[] = Array.from({ length: 100 }, (_, i) => ({
      // legacy campaign: phones only; every 20th phone ends with 9 → no player
      phone: i % 20 === 0 ? `+551199999${String(i).padStart(3, "0")}9` : phone(i * 10),
      playerId: null,
    }));
    const { state, deps } = world();
    const r = await processSmsCampaignTick(campaign(recipients), deps, { deadline: 45_000 });
    expect(r.sent).toBe(95);
    expect(r.status).toBe("enviado");
    expect((state.unresolved as unknown[]).length).toBe(5);
    expect(state.patches[0]).toMatchObject({ total_count: 95 });
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviado", locked_by: null });
  });

  it("fails the campaign only when no recipient resolves", async () => {
    const { state, deps } = world();
    const r = await processSmsCampaignTick(
      campaign([
        { phone: "+5511900000009", playerId: null },
        { phone: "+5511900000019", playerId: null },
      ]),
      deps,
      { deadline: 45_000 },
    );
    expect(r.status).toBe("falhou");
    expect(state.sendCalls).toHaveLength(0);
    expect(String(lastPatch(state.patches).last_error)).toContain("Nenhum destinatário");
  });

  it("dedupes by (campaign, player), not by rendered content", async () => {
    const c = campaign([
      { phone: phone(1), playerId: pid(1) },
      { phone: phone(2), playerId: pid(2) },
      { phone: phone(1), playerId: pid(1) }, // same player listed twice
      { phone: phone(3), playerId: pid(3) },
    ]);
    const { state, deps } = world();
    // pid(2) was already accepted by the provider in an earlier run.
    state.accepted.add(await campaignDeliveryKey(c.id, pid(2)));
    const r = await processSmsCampaignTick(c, deps, { deadline: 45_000 });
    expect(r.sent).toBe(2);
    expect(r.deduplicated).toBe(2);
    expect(state.sendCalls).toEqual([
      await campaignDeliveryKey(c.id, pid(1)),
      await campaignDeliveryKey(c.id, pid(3)),
    ]);
  });

  it("achieves rate_per_minute in one tick of the real (1/min) cron", async () => {
    const recipients = Array.from({ length: 3000 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    const { state, deps } = world();
    const r = await processSmsCampaignTick(campaign(recipients), deps, { deadline: 45_000 });
    expect(r.sent).toBe(1000);
    expect(r.stopReason).toBe("quota");
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviando", locked_at: null });
  });

  it("stops at the run deadline and at the provider budget", async () => {
    const recipients = Array.from({ length: 1000 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    const slow = world({ clockStepMs: 100 }); // 100 sends ≈ 10 s per batch
    const r1 = await processSmsCampaignTick(campaign(recipients), slow.deps, { deadline: 25_000 });
    expect(r1.stopReason).toBe("deadline");
    expect(r1.sent).toBe(200);

    // Budget exhausted for good (paused/contended): stops after MAX_ZERO_GRANTS empty grants.
    let grants = 0;
    const capped = world({ budget: (want) => (grants++ === 0 ? Math.min(want, 30) : 0) });
    const r2 = await processSmsCampaignTick(campaign(recipients), capped.deps, { deadline: 45_000 });
    expect(r2.stopReason).toBe("budget");
    expect(r2.sent).toBe(30);
    expect(grants).toBe(1 + MAX_ZERO_GRANTS);
    expect(capped.state.events.at(-1)).toEqual({ type: "cursor", cursor: 30 });
  });

  it("keeps sending after partial grants until the deadline (I1: ~5/s per tenant)", async () => {
    const recipients = Array.from({ length: 1000 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    // Token bucket at 5/s, burst 15: each acquireSendBudget call waits up to
    // 1.5 s (advancing the clock) and returns what accumulated.
    let tokens = 15;
    let calls = 0;
    const paced = world();
    paced.deps.acquireSendBudget = async (_tenant, want) => {
      calls++;
      if (tokens < 1) {
        paced.state.clock += 1_500;
        tokens += 7.5;
      }
      const granted = Math.min(want, Math.floor(tokens));
      tokens -= granted;
      return granted;
    };
    const r = await processSmsCampaignTick(campaign(recipients), paced.deps, { deadline: 45_000 });
    expect(r.stopReason).toBe("deadline");
    expect(r.sent).toBeGreaterThanOrEqual(225);
    expect(r.sent).toBeLessThanOrEqual(240);
    expect(calls).toBeGreaterThan(20);
    // Every recipient was sent exactly once, in order; the cursor matches.
    expect(new Set(paced.state.sendCalls).size).toBe(r.sent);
    expect(r.deduplicated).toBe(0);
    expect(paced.state.events.at(-1)).toEqual({ type: "cursor", cursor: r.sent });
  }, 20_000); // simulated clock; CPU-bound key derivation is slow under the full parallel suite

  it("a partial grant cut before a contact-limited recipient keeps going", async () => {
    const recipients = Array.from({ length: 10 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    const w = world({ budget: (want) => Math.min(want, 2) });
    w.state.blockedPlayers.add(pid(8));
    const r = await processSmsCampaignTick(campaign(recipients), w.deps, { deadline: 45_000 });
    expect(r.sent).toBe(7);
    expect(r.stopReason).toBe("contact_limit");
    expect(w.state.events.at(-1)).toEqual({ type: "cursor", cursor: 7 });
  });

  it("waits for a contact-limited recipient instead of skipping it", async () => {
    const recipients = Array.from({ length: 10 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    const { state, deps } = world();
    state.blockedPlayers.add(pid(4));
    const r = await processSmsCampaignTick(campaign(recipients), deps, { deadline: 45_000 });
    expect(r.sent).toBe(3);
    expect(r.stopReason).toBe("contact_limit");
    expect(lastPatch(state.patches)).toMatchObject({
      status: "enviando",
      scheduled_at: "2026-10-15T13:00:00Z",
    });
    expect(state.events.at(-1)).toEqual({ type: "cursor", cursor: 3 });
  });

  it("advances the cursor only after the batch was sent; a crash re-sends nothing", async () => {
    const recipients = Array.from({ length: 150 }, (_, i) => ({
      phone: phone(i),
      playerId: pid(i + 1),
    }));
    const { state, deps } = world();

    // Run 1 dies after sending the first batch, before its checkpoint.
    state.failCursorWrite = true;
    await expect(
      processSmsCampaignTick(campaign(recipients), deps, { deadline: 45_000 }),
    ).rejects.toThrow("worker crashed");
    const sentInRun1 = state.sendCalls.length;
    expect(sentInRun1).toBe(100);
    expect(state.events.some((e) => e.type === "cursor")).toBe(false);

    // Run 2 restarts from the persisted cursor (0): the 100 already accepted are
    // deduplicated, only the remaining 50 reach the provider.
    state.failCursorWrite = false;
    const r = await processSmsCampaignTick(campaign(recipients), deps, { deadline: 45_000 });
    expect(r.deduplicated).toBe(100);
    expect(r.sent).toBe(50);
    expect(new Set(state.sendCalls).size).toBe(state.sendCalls.length);

    // Every checkpoint is preceded by the sends it covers.
    state.events.forEach((event, index) => {
      if (event.type !== "cursor") return;
      const sentBefore = new Set(
        state.events
          .slice(0, index)
          .flatMap((e) => (e.type === "send" ? [e.key] : [])),
      );
      expect(sentBefore.size).toBeGreaterThanOrEqual(event.cursor);
    });
    expect(state.events.filter((e) => e.type === "cursor").map((e) => e.cursor)).toEqual([
      100, 150,
    ]);
    expect(lastPatch(state.patches)).toMatchObject({ status: "enviado" });
  });
});

describe("processSmsCampaignTick with sendBatch (ENV-10 bulk)", () => {
  const recipients = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ phone: phone(i), playerId: pid(i + 1) }));

  function batchWorld(opts: Parameters<typeof world>[0] = {}) {
    const w = world(opts);
    const batches: string[][] = [];
    const budgetAsks: number[] = [];
    const acquire = w.deps.acquireSendBudget;
    w.deps.acquireSendBudget = async (tenant, want) => {
      budgetAsks.push(want);
      return acquire(tenant, want);
    };
    let behaviour: (key: string) => SendOutcome = (key) => {
      if (w.state.accepted.has(key)) return { ok: true, alreadySent: true };
      w.state.accepted.add(key);
      return { ok: true };
    };
    w.deps.send = async () => {
      throw new Error("per-recipient send must not be used when sendBatch exists");
    };
    w.deps.sendBatch = async ({ items }) => {
      batches.push(items.map((it) => it.deliveryKey));
      return items.map((it) => behaviour(it.deliveryKey));
    };
    return {
      ...w,
      batches,
      budgetAsks,
      setBehaviour: (fn: (key: string) => SendOutcome) => (behaviour = fn),
    };
  }

  it("sends each budgeted batch in one call and checkpoints after it", async () => {
    const w = batchWorld({ budget: (want) => Math.min(want, 45) });
    const r = await processSmsCampaignTick(campaign(recipients(100)), w.deps, { deadline: 45_000 });
    expect(r.sent).toBe(100);
    // Budget is consumed for the batch size before sending; the batch is cut to the grant.
    expect(w.batches.map((b) => b.length)).toEqual([45, 45, 10]);
    expect(w.budgetAsks[0]).toBe(100);
    expect(w.state.patches.filter((p) => "sent_cursor" in p).map((p) => p.sent_cursor)).toEqual([
      45, 90, 100,
    ]);
    expect(lastPatch(w.state.patches)).toMatchObject({ status: "enviado" });
  });

  it("pending confirmation counts as sent and is deduped on the next run", async () => {
    const w = batchWorld();
    w.setBehaviour((key) => {
      w.state.accepted.add(key); // write-ahead log counts as accepted
      return { ok: true, pendingConfirmation: true, error: "timeout" };
    });
    const c = campaign(recipients(10));
    const r1 = await processSmsCampaignTick(c, w.deps, { deadline: 45_000 });
    expect(r1).toMatchObject({ sent: 10, pendingConfirmation: 10, failed: 0 });
    expect(lastPatch(w.state.patches.filter((p) => "last_error" in p)).last_error).toMatch(
      /aguardando confirmação/,
    );

    // Crash before the checkpoint → the same recipients come back: nothing is resent.
    const r2 = await processSmsCampaignTick(c, w.deps, { deadline: 45_000 });
    expect(r2).toMatchObject({ sent: 0, deduplicated: 10 });
    expect(w.batches).toHaveLength(1);
  });

  it("all items retryable (nothing reached the provider): cursor kept, tick stops", async () => {
    const w = batchWorld();
    w.setBehaviour(() => ({ ok: false, retryable: true, error: "Sem resposta do provedor" }));
    const r = await processSmsCampaignTick(campaign(recipients(30)), w.deps, { deadline: 45_000 });
    expect(r).toMatchObject({ sent: 0, failed: 0, advanced: 0, stopReason: "provider_unavailable" });
    expect(w.state.patches.some((p) => "sent_cursor" in p)).toBe(false);
    expect(lastPatch(w.state.patches)).toMatchObject({
      status: "enviando",
      last_error: "Sem resposta do provedor",
      locked_by: null,
    });
  });

  it("a thrown batch (e.g. link tracking blocked) is deferred without moving the cursor", async () => {
    const w = batchWorld();
    w.deps.sendBatch = async () => {
      throw new Error("Rastreamento de links indisponível");
    };
    const r = await processSmsCampaignTick(campaign(recipients(5)), w.deps, { deadline: 45_000 });
    expect(r.stopReason).toBe("provider_unavailable");
    expect(w.state.patches.some((p) => "sent_cursor" in p)).toBe(false);
  });

  it("partial rejection advances past the rejected items as failures", async () => {
    const w = batchWorld();
    let n = 0;
    w.setBehaviour((key) => {
      n++;
      if (n === 2) return { ok: false, error: "rejeitado" };
      w.state.accepted.add(key);
      return { ok: true };
    });
    const r = await processSmsCampaignTick(campaign(recipients(5)), w.deps, { deadline: 45_000 });
    expect(r).toMatchObject({ sent: 4, failed: 1, status: "enviado" });
  });

  it("I1: mixed batch stops the cursor at the first retryable recipient", async () => {
    const w = batchWorld();
    const c = campaign(recipients(6));
    let call = 0;
    w.setBehaviour((key) => {
      call++;
      // 1 accepted, 2 rejected (final), 3.. retryable (their chunk never left)
      if (call === 1) {
        w.state.accepted.add(key);
        return { ok: true };
      }
      if (call === 2) return { ok: false, error: "rejeitado" };
      return { ok: false, retryable: true, error: "Sem resposta do provedor" };
    });
    const r1 = await processSmsCampaignTick(c, w.deps, { deadline: 45_000 });
    expect(r1).toMatchObject({ sent: 1, failed: 1, advanced: 2, stopReason: "provider_unavailable" });
    expect(w.state.patches.filter((p) => "sent_cursor" in p).map((p) => p.sent_cursor)).toEqual([2]);

    // Next tick resumes at recipient 3: the retryable ones are sent now.
    w.setBehaviour((key) => {
      w.state.accepted.add(key);
      return { ok: true };
    });
    const r2 = await processSmsCampaignTick(
      { ...c, sent_cursor: 2, sent_count: 1, failed_count: 1 },
      w.deps,
      { deadline: 45_000 },
    );
    expect(r2).toMatchObject({ sent: 4, status: "enviado" });
    expect(w.batches[1]).toHaveLength(4);
  });
});
