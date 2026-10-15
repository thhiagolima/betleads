import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));

import {
  MAX_RETRY_AFTER_SECONDS,
  RECEIPT_PROCESSING_LEASE_MS,
  processWebhookEvent,
  readReceiptState,
} from "./webhook-process.server";

type Op = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
};
type Result = { data?: unknown; error?: unknown };
type Handler = (op: Op) => Result | undefined;

/** Minimal chainable PostgREST fake: every call is recorded, results come from `handler`. */
function fakeSupabase(
  handler: Handler,
  rpc: (name: string, args: Record<string, unknown>) => Result,
) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: "select", filters: [] };
    let registered = false;
    const register = () => {
      if (!registered) {
        ops.push(op);
        registered = true;
      }
    };
    const resolve = (): Result => {
      register();
      return { data: null, error: null, ...(handler(op) ?? {}) };
    };
    const builder: Record<string, unknown> = {};
    for (const m of ["insert", "update", "upsert", "delete"] as const) {
      builder[m] = (payload?: Record<string, unknown>) => {
        op.op = m;
        op.payload = payload;
        return builder;
      };
    }
    builder.select = () => builder;
    for (const f of ["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "order", "limit"]) {
      builder[f] = (...args: unknown[]) => {
        op.filters.push([f, ...args]);
        return builder;
      };
    }
    builder.single = async () => resolve();
    builder.maybeSingle = async () => resolve();
    builder.then = (ok: (v: Result) => unknown, ko: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(resolve()).then(ok, ko);
      } catch (e) {
        return Promise.reject(e).then(ok, ko);
      }
    };
    return builder;
  };
  const sb = {
    from,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data: null,
      error: null,
      ...rpc(name, args),
    })),
  };
  return { sb: sb as unknown as SupabaseClient, ops };
}

const NOW = new Date("2026-10-14T12:00:00Z").getTime();
const TENANT = "00000000-0000-0000-0000-00000000000a";
const PAYLOAD = { eventId: "evt-1", data: { userId: "user-1" } };

const filterValue = (op: Op, column: string) =>
  op.filters.find((f) => f[0] === "eq" && f[1] === column)?.[2];
const logUpdates = (ops: Op[]) =>
  ops.filter((o) => o.table === "webhook_logs" && o.op === "update");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readReceiptState", () => {
  const receipt = (data: Result) =>
    fakeSupabase(
      () => data,
      () => ({}),
    ).sb;

  it("reports completed receipts as already processed", async () => {
    const state = await readReceiptState(receipt({ data: { status: "completed" } }), TENANT, "e");
    expect(state.state).toBe("completed");
  });

  it("computes Retry-After from the remaining processing lease", async () => {
    const lockedAt = new Date(NOW - 2 * 60_000).toISOString();
    const state = await readReceiptState(
      receipt({ data: { status: "processing", locked_at: lockedAt } }),
      TENANT,
      "e",
      NOW,
    );
    expect(state).toEqual({ state: "in_progress", status: "processing", retryAfterSeconds: 480 });
  });

  it("uses the failed cool-down (min 30 s) and clamps to the lease", async () => {
    const failed = await readReceiptState(
      receipt({ data: { status: "failed", updated_at: new Date(NOW - 5_000).toISOString() } }),
      TENANT,
      "e",
      NOW,
    );
    expect(failed.retryAfterSeconds).toBe(30);
    const fresh = await readReceiptState(
      receipt({ data: { status: "processing", locked_at: new Date(NOW + 60_000).toISOString() } }),
      TENANT,
      "e",
      NOW,
    );
    expect(fresh.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("treats an unreadable receipt as in progress (retry is safe, dropping is not)", async () => {
    const state = await readReceiptState(receipt({ error: { message: "boom" } }), TENANT, "e");
    expect(state).toMatchObject({ state: "in_progress", status: null, retryAfterSeconds: 60 });
  });
});

describe("processWebhookEvent duplicate vs in-progress (CON-04)", () => {
  function setup(receipt: Result, opts: { missingColumn?: boolean } = {}) {
    return fakeSupabase(
      (op) => {
        if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
        if (op.table === "webhook_event_receipts" && op.op === "select") return receipt;
        if (
          opts.missingColumn &&
          op.table === "webhook_logs" &&
          op.op === "update" &&
          op.payload &&
          "next_replay_at" in op.payload
        ) {
          return {
            error: { code: "PGRST204", message: "Could not find the 'next_replay_at' column" },
          };
        }
        return undefined;
      },
      (name) => (name === "claim_webhook_event" ? { data: false } : {}),
    );
  }

  it("acknowledges a really processed event as duplicate (200, duplicado)", async () => {
    const { sb, ops } = setup({ data: { status: "completed" } });
    const res = await processWebhookEvent(sb, TENANT, "login", PAYLOAD);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
    expect(logUpdates(ops).map((o) => o.payload?.status)).toEqual(["duplicado"]);
  });

  it("answers 202 + Retry-After and keeps the log replayable while another delivery holds the receipt", async () => {
    const lockedAt = new Date(NOW - 2 * 60_000).toISOString();
    const { sb, ops } = setup({ data: { status: "processing", locked_at: lockedAt } });
    const res = await processWebhookEvent(sb, TENANT, "login", PAYLOAD);
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("480");
    expect(await res.json()).toMatchObject({ ok: true, in_progress: true, retry_after: 480 });

    const updates = logUpdates(ops);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      status: "recebido",
      next_replay_at: new Date(NOW + (480 + 30) * 1000).toISOString(),
      payload: { _processing: { deferred: "receipt_in_progress", receipt_status: "processing" } },
    });
    expect(filterValue(updates[0], "id")).toBe("log-1");
    expect(ops.some((o) => o.payload?.status === "duplicado")).toBe(false);
    // Nothing downstream ran: no player/event writes.
    expect(ops.some((o) => o.table === "events" || o.table === "players")).toBe(false);
  });

  it("still keeps the log replayable when next_replay_at does not exist yet (pre-migration DB)", async () => {
    const { sb, ops } = setup(
      { data: { status: "failed", updated_at: new Date(NOW).toISOString() } },
      {
        missingColumn: true,
      },
    );
    const res = await processWebhookEvent(sb, TENANT, "login", PAYLOAD);
    expect(res.status).toBe(202);
    const updates = logUpdates(ops);
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).not.toHaveProperty("next_replay_at");
    expect(updates[1].payload).toMatchObject({ status: "recebido" });
  });

  it("on replay, an in-progress event keeps the existing row recebido instead of duplicado", async () => {
    const lockedAt = new Date(NOW - 60_000).toISOString();
    const { sb, ops } = setup({ data: { status: "processing", locked_at: lockedAt } });
    const res = await processWebhookEvent(sb, TENANT, "login", PAYLOAD, {
      mirror: true,
      existingLogId: "replayed-log",
    });
    expect(res.status).toBe(202);
    expect(ops.some((o) => o.table === "webhook_logs" && o.op === "insert")).toBe(false);
    const updates = logUpdates(ops);
    expect(filterValue(updates[0], "id")).toBe("replayed-log");
    expect(updates[0].payload?.status).toBe("recebido");
  });
});

describe("crash after claim followed by retry processes the event exactly once", () => {
  it("defers while the dead worker's lease is live, then processes once, then dedups", async () => {
    // In-memory receipts reproducing claim_webhook_event's rules.
    const receipts = new Map<string, { status: string; locked_at: number; updated_at: number }>();
    let logSeq = 0;
    const eventInserts: unknown[] = [];
    const { sb, ops } = fakeSupabase(
      (op) => {
        if (op.table === "webhook_logs" && op.op === "insert")
          return { data: { id: `log-${++logSeq}` } };
        if (op.table === "players" && op.op === "select") return { data: { id: "player-1" } };
        if (op.table === "events" && op.op === "upsert") eventInserts.push(op.payload);
        if (op.table === "webhook_event_receipts") {
          const key = String(filterValue(op, "provider_event_id"));
          const r = receipts.get(key);
          if (op.op === "select") {
            return {
              data: r && {
                status: r.status,
                locked_at: new Date(r.locked_at).toISOString(),
                updated_at: new Date(r.updated_at).toISOString(),
              },
            };
          }
          if (op.op === "update" && r) {
            r.status = String(op.payload?.status);
            r.updated_at = Date.now();
          }
        }
        return undefined;
      },
      (name, args) => {
        if (name !== "claim_webhook_event") return {};
        const key = String(args.p_provider_event_id);
        const r = receipts.get(key);
        const now = Date.now();
        const claimable =
          !r ||
          (r.status === "failed" && r.updated_at < now - 30_000) ||
          (r.status === "processing" && r.locked_at < now - RECEIPT_PROCESSING_LEASE_MS);
        if (!claimable) return { data: false };
        receipts.set(key, { status: "processing", locked_at: now, updated_at: now });
        return { data: true };
      },
    );

    // Worker 1 claimed the receipt and died before finishing (no completion written).
    receipts.set("evt-1", { status: "processing", locked_at: NOW, updated_at: NOW });

    // Provider retry 1 minute later: must not be swallowed as a duplicate.
    vi.setSystemTime(new Date(NOW + 60_000));
    const retry = await processWebhookEvent(sb, TENANT, "login", PAYLOAD, { mirror: false });
    expect(retry.status).toBe(202);
    expect(eventInserts).toHaveLength(0);
    const deferred = logUpdates(ops).at(-1)!;
    expect(deferred.payload?.status).toBe("recebido");

    // Replay after the lease expired: claims and processes the event.
    vi.setSystemTime(new Date(NOW + RECEIPT_PROCESSING_LEASE_MS + 60_000));
    const replay = await processWebhookEvent(sb, TENANT, "login", PAYLOAD, {
      mirror: false,
      existingLogId: "log-1",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true });
    expect(eventInserts).toHaveLength(1);
    expect(receipts.get("evt-1")?.status).toBe("completed");
    expect(logUpdates(ops).at(-1)?.payload?.status).toBe("processado");

    // A late duplicate delivery is now acknowledged as a real duplicate.
    const late = await processWebhookEvent(sb, TENANT, "login", PAYLOAD, { mirror: false });
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ ok: true, duplicate: true });
    expect(eventInserts).toHaveLength(1);
  });
});
