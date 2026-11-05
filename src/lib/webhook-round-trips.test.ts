// R1 phase 0 (docs/AUDITORIA_CONSUMO_SUPABASE_2026-11-04.md §9): one webhook of
// an existing player reads the player once and skips the pre-selects the
// upserts already cover. Every round trip here is a PostgREST request.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));
vi.mock("./journey-scanner.server", () => ({
  enrollPlayerOnEvent: vi.fn(async () => undefined),
  eventEntryTriggers: () => [],
}));

import { processWebhookEvent } from "./webhook-process.server";

type Op = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
};
type Result = { data?: unknown; error?: unknown };

function fakeSupabase(handler: (op: Op) => Result | undefined) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: "select", filters: [] };
    let registered = false;
    const resolve = (): Result => {
      if (!registered) {
        ops.push(op);
        registered = true;
      }
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
    builder.then = (ok: (v: Result) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(ok, ko);
    return builder;
  };
  const rpc = vi.fn(async (name: string) => ({
    data: name === "claim_webhook_event" ? true : null,
    error: null,
  }));
  return { sb: { from, rpc } as unknown as SupabaseClient, ops, rpc };
}

const TENANT = "00000000-0000-0000-0000-00000000000c";
const TENANT_FIELDS = { crm_model: null, moeda: null };

function existingPlayer(stored: Record<string, unknown>) {
  return fakeSupabase((op) => {
    if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
    if (op.table === "financial_webhook_attempts" && op.op === "insert")
      return { data: { id: "attempt-1" } };
    if (op.table === "players" && op.op === "select")
      return { data: { id: "player-1", ...stored } };
    return undefined;
  });
}

// A payload carrying every optional field that used to cost its own read.
const RICH = {
  userId: "ext-1",
  utm_source: "ig",
  utm_campaign: "camp-1",
  affiliate_id: "AFF1",
  cpf: "52998224725",
};

const reads = (ops: Op[], table: string) =>
  ops.filter((o) => o.table === table && o.op === "select");

describe("webhook round trips (R1 phase 0)", () => {
  it("deposit of an existing player: one player read, no tenant or expert read", async () => {
    const { sb, ops, rpc } = existingPlayer({
      utm_source: "fb",
      utm_campaign: null,
      utm_content: null,
      utm_id: null,
      affiliate_id: "AFF0",
      expert: "Ana",
      cpf: "11144477735",
    });
    const response = await processWebhookEvent(
      sb,
      TENANT,
      "deposito-aprovado",
      { eventId: "evt-dep-1", data: { ...RICH, amount: 50, transactionId: "tx-1" } },
      { tenant: TENANT_FIELDS },
    );
    expect(response.status).toBe(200);

    expect(reads(ops, "players")).toHaveLength(1);
    expect(reads(ops, "tenants")).toHaveLength(0);
    expect(reads(ops, "expert_affiliates")).toHaveLength(0);
    expect(reads(ops, "events")).toHaveLength(0);
    expect(ops.find((o) => o.table === "events" && o.op === "upsert")).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith("record_financial_webhook_event", expect.anything());

    // Same rules as before: first touch kept, filled fields left alone.
    const update = ops.find((o) => o.table === "players" && o.op === "update")?.payload ?? {};
    expect(update).not.toHaveProperty("utm_source");
    expect(update).not.toHaveProperty("affiliate_id");
    expect(update).not.toHaveProperty("expert");
    expect(update).not.toHaveProperty("cpf");
  });

  it("login of an existing player: no session or event pre-select", async () => {
    const { sb, ops } = existingPlayer({
      utm_source: null,
      utm_campaign: null,
      utm_content: null,
      utm_id: null,
      affiliate_id: null,
      expert: null,
      cpf: null,
    });
    await processWebhookEvent(
      sb,
      TENANT,
      "login",
      { eventId: "evt-login-1", data: { userId: "ext-1" } },
      { tenant: TENANT_FIELDS },
    );
    expect(reads(ops, "sessions")).toHaveLength(0);
    expect(reads(ops, "events")).toHaveLength(0);
    const session = ops.find((o) => o.table === "sessions" && o.op === "upsert");
    expect(session?.payload).toMatchObject({ player_id: "player-1" });
  });

  it("fills empty affiliate, expert and cpf from the same single read", async () => {
    const { sb, ops } = fakeSupabase((op) => {
      if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
      if (op.table === "players" && op.op === "select")
        return {
          data: {
            id: "player-1",
            utm_source: null,
            utm_campaign: null,
            utm_content: null,
            utm_id: null,
            affiliate_id: null,
            expert: null,
            cpf: null,
          },
        };
      if (op.table === "expert_affiliates") return { data: { experts: { nome: "Bia" } } };
      return undefined;
    });
    await processWebhookEvent(
      sb,
      TENANT,
      "login",
      { eventId: "evt-login-2", data: RICH },
      { tenant: TENANT_FIELDS },
    );
    expect(reads(ops, "players")).toHaveLength(1);
    expect(reads(ops, "expert_affiliates")).toHaveLength(1);
    const update = ops.find((o) => o.table === "players" && o.op === "update")?.payload ?? {};
    expect(update).toMatchObject({
      utm_source: "ig",
      affiliate_id: "AFF1",
      expert: "Bia",
      cpf: "52998224725",
    });
  });

  it("replay without tenant fields still reads them", async () => {
    const { sb, ops } = existingPlayer({});
    await processWebhookEvent(sb, TENANT, "login", { data: { userId: "ext-1" } });
    expect(reads(ops, "tenants")).toHaveLength(1);
  });
});
