import { afterEach, describe, expect, it, vi } from "vitest";
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
  const sb = {
    from,
    rpc: vi.fn(async (name: string) => ({
      data: name === "claim_webhook_event" ? true : null,
      error: null,
    })),
  };
  return { sb: sb as unknown as SupabaseClient, ops };
}

const TENANT = "00000000-0000-0000-0000-00000000000c";
const USER_ID = "a4d2d3ab-ef18-4c06-8f06-914e17f02466";

// Formato da PixReals: nome, e-mail e telefone vêm em `data.userContact` em
// todos os eventos (cadastro, login, depósito, saque).
const event = (name = "auth.signup.success") => ({
  data: {
    userId: USER_ID,
    axioAffId: "QGWTH",
    countryCode: "BR",
    userContact: {
      email: "jogador@example.com",
      phone: "(62) 98585-0000",
      fullName: "JAELTON DA MATA SOUSA",
      lastName: "SOUSA",
      username: "jajafepasa",
      firstName: "JAELTON",
    },
  },
  event: name,
  eventId: "57c43239-7e38-4eb8-8c20-9c6fafae712b",
  subject: { id: "d425ed1c-89c3-4e93-8c8a-5a6f3e9e12b8", type: "session" },
  occurredAt: "2026-11-10 14:18:58.41+00",
});

function setup(existing: Record<string, unknown> | null) {
  return fakeSupabase((op) => {
    if (op.table === "webhook_logs" && op.op === "insert") return { data: { id: "log-1" } };
    if (op.table === "players" && op.op === "select") return { data: existing };
    if (op.table === "players" && op.op === "insert") return { data: { id: "player-1" } };
    return undefined;
  });
}

const playerUpdate = (ops: Op[]) =>
  ops.find((o) => o.table === "players" && o.op === "update")?.payload ?? {};

afterEach(() => vi.clearAllMocks());

describe("contato em data.userContact (PixReals)", () => {
  it("cria o player do cadastro com nome, e-mail e telefone", async () => {
    const { sb, ops } = setup(null);
    await processWebhookEvent(sb, TENANT, "cadastro", event());
    const insert = ops.find((o) => o.table === "players" && o.op === "insert");
    expect(insert?.payload).toMatchObject({
      nome: "JAELTON DA MATA SOUSA",
      email: "jogador@example.com",
      telefone: "(62) 98585-0000",
      player_external_id: USER_ID,
    });
  });

  it("preenche o contato de um player que ficou como Novo player", async () => {
    const { sb, ops } = setup({ id: "player-1", nome: "Novo player", email: null, telefone: null });
    await processWebhookEvent(sb, TENANT, "login", event("auth.login.success"));
    expect(playerUpdate(ops)).toMatchObject({
      nome: "JAELTON DA MATA SOUSA",
      email: "jogador@example.com",
      telefone: "(62) 98585-0000",
    });
  });

  it("não sobrescreve o contato que o player já tem", async () => {
    const { sb, ops } = setup({
      id: "player-1",
      nome: "Jaelton Sousa",
      email: "antigo@example.com",
      telefone: "+5562985850001",
    });
    await processWebhookEvent(sb, TENANT, "login", event("auth.login.success"));
    const update = playerUpdate(ops);
    expect(update).not.toHaveProperty("nome");
    expect(update).not.toHaveProperty("email");
    expect(update).not.toHaveProperty("telefone");
  });
});
