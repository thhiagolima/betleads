import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));
vi.mock("./journey-scanner.server", () => ({
  enrollPlayerOnEvent: vi.fn(async () => undefined),
  eventEntryTriggers: () => [],
}));

import { attributeFromLastFirstPartyClick } from "./conversion-attribution.server";
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
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
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
  const sb = {
    from,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: name === "claim_webhook_event" ? true : null, error: null };
    }),
  };
  return { sb: sb as unknown as SupabaseClient, ops, rpcCalls };
}

const TENANT = "00000000-0000-0000-0000-00000000000b";
// 16/10/2026 16:52:23 UTC = 13:52:23 em Brasília. A casa envia `time` com o
// horário de Brasília como se fosse UTC.
const NOW = Date.parse("2026-10-16T17:00:00Z");
const PAID_AT_UTC = "2026-10-16T16:52:23.115Z";
const PAID_TIME_BRT_AS_UTC = Date.parse("2026-10-16T13:52:23.115Z");

const USER = {
  id: "6ad25622df1ea51c6d1c802d",
  email: "jogador@example.com",
  phone: "27999990000",
  referral: null,
  username: "jogador8b71816c",
  created_at: "2026-10-16T16:51:46.514Z",
  first_name: "Wenderson",
};
const TRACKING = {
  fbclid: "PAZXh0bgNhZW0",
  utm_medium: "paid",
  utm_source: "ig",
  utm_content: "120255699527850054",
  utm_campaign: "120255698807120054",
};

const depositPaid = (overrides: Record<string, unknown> = {}) => ({
  time: PAID_TIME_BRT_AS_UTC,
  user: USER,
  event: "deposit_paid",
  amount: 100,
  coupon: null,
  currency: "BRL",
  tracking: TRACKING,
  utm_source: "ig",
  external_id: "5679d48e-650f-4071-bae1-749673ae9bd6",
  internal_id: "6ad2562bdf1ea51c6d1c8083",
  pix_copy_paste: "00020126860014br.gov.bcb.pix",
  paid_deposits_count: 1,
  paid_deposits_amount: 100,
  ...overrides,
});

function setup(existingPlayer: boolean) {
  return fakeSupabase((op) => {
    if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
    if (op.table === "players" && op.op === "select") {
      return { data: existingPlayer ? { id: "player-1" } : null };
    }
    if (op.table === "players" && op.op === "insert") return { data: { id: "player-1" } };
    if (op.table === "financial_webhook_attempts" && op.op === "insert") {
      return { data: { id: "attempt-1" } };
    }
    return undefined;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("payload com o player em `user` e a transação no topo (Sorte da Bet)", () => {
  it("registra o depósito pago com o id da casa, horário corrigido e método PIX", async () => {
    const { sb, ops, rpcCalls } = setup(true);
    const res = await processWebhookEvent(sb, TENANT, "deposito-aprovado", depositPaid());
    expect(await res.json()).toMatchObject({ ok: true });

    const financial = rpcCalls.find((c) => c.name === "record_financial_webhook_event");
    expect(financial?.args).toMatchObject({
      p_kind: "deposit",
      p_status: "aprovado",
      p_external_id: "6ad2562bdf1ea51c6d1c8083",
      p_event_id: "deposit_paid:6ad2562bdf1ea51c6d1c8083",
      p_amount: 100,
      p_method: "pix",
      p_event_at: PAID_AT_UTC,
    });
    expect(attributeFromLastFirstPartyClick).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "deposit_approved", isFtd: true }),
    );
    const logStatuses = ops
      .filter((o) => o.table === "webhook_logs" && o.op === "update")
      .map((o) => o.payload?.status);
    expect(logStatuses.at(-1)).toBe("processado");
  });

  it("não marca FTD a partir do segundo depósito pago", async () => {
    const { sb } = setup(true);
    await processWebhookEvent(
      sb,
      TENANT,
      "deposito-aprovado",
      depositPaid({ paid_deposits_count: 2 }),
    );
    expect(attributeFromLastFirstPartyClick).toHaveBeenCalledWith(
      expect.objectContaining({ isFtd: false }),
    );
  });

  it("cria o player do cadastro com primeiro nome, UTMs do tracking e data real de cadastro", async () => {
    const { sb, ops } = setup(false);
    await processWebhookEvent(sb, TENANT, "cadastro", {
      ip: "2804::1",
      time: Date.parse("2026-10-16T13:51:46.900Z"),
      user: USER,
      event: "register",
      tracking: TRACKING,
      invitation_code: "c0488d9a983cca47",
    });
    const insert = ops.find((o) => o.table === "players" && o.op === "insert");
    expect(insert?.payload).toMatchObject({
      nome: "Wenderson",
      email: USER.email,
      telefone: USER.phone,
      player_external_id: USER.id,
      utm_source: "ig",
      utm_medium: "paid",
      utm_campaign: TRACKING.utm_campaign,
      utm_content: TRACKING.utm_content,
      created_at: USER.created_at,
    });
  });

  it("usa o horário do login (não o do cadastro) e atualiza os saldos", async () => {
    const { sb, ops } = setup(true);
    await processWebhookEvent(sb, TENANT, "login", {
      ip: "2804::1",
      role: "user",
      time: Date.parse("2026-10-16T13:55:00.000Z"),
      user: USER,
      event: "login",
      tracking: TRACKING,
      balance_brl: 220,
      balance_bonus: 5.5,
    });
    const update = ops.find((o) => o.table === "players" && o.op === "update");
    expect(update?.payload).toMatchObject({
      ultimo_login: "2026-10-16T16:55:00.000Z",
      saldo_carteira: 220,
      saldo_bonus: 5.5,
    });
  });

  it("aceita `time` já em UTC se a casa corrigir o relógio", async () => {
    const { sb, rpcCalls } = setup(true);
    await processWebhookEvent(
      sb,
      TENANT,
      "deposito-aprovado",
      depositPaid({ time: Date.parse(PAID_AT_UTC) }),
    );
    const financial = rpcCalls.find((c) => c.name === "record_financial_webhook_event");
    expect(financial?.args.p_event_at).toBe(PAID_AT_UTC);
  });
});
