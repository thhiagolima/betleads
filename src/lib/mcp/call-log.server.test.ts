// MCP financeiro, Task 9: logCall also accepts an admin-shaped identity
// (no mcp_connections row — the action was taken from the admin panel, not
// through an MCP connection). Same createFakeDb stand-in as access.server.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { argsForLog, logCall } from "./call-log.server";
import { LOG_ARGS_MAX_CHARS } from "./config.server";
import { createFakeDb } from "../sms-bulk.test-support";

const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const CONNECTION = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  fake.admin.reset();
});

describe("logCall", () => {
  it("still logs a normal MCP identity, with its connection_id", async () => {
    await logCall({
      identity: {
        userId: USER,
        connectionId: CONNECTION,
        clientId: "client-1",
        level: "read",
        areas: ["financeiro"],
      },
      tool: "mes_da_casa",
      ok: true,
      durationMs: 5,
    });
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({
      user_id: USER,
      connection_id: CONNECTION,
      tool: "mes_da_casa",
    });
  });

  it("logs an admin row with a null connection_id (no MCP connection involved)", async () => {
    await logCall({
      identity: { userId: ADMIN, connectionId: null },
      tool: "admin.set_access",
      ok: true,
      durationMs: 3,
    });
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({
      user_id: ADMIN,
      connection_id: null,
      tool: "admin.set_access",
      ok: true,
    });
  });
});

describe("logCall args and scope", () => {
  it("stores the args as JSON and the scope", async () => {
    await logCall({
      identity: { userId: USER, connectionId: CONNECTION },
      tool: "visao_geral",
      ok: true,
      durationMs: 1,
      args: { escopo: { tipo: "grupo", id: "g1" }, periodo: { preset: "7d" } },
      scope: { tipo: "grupo", id: "g1", casas: 3 },
    } as never);
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({
      args: { escopo: { tipo: "grupo", id: "g1" }, periodo: { preset: "7d" } },
      scope: { tipo: "grupo", id: "g1", casas: 3 },
    });
  });

  it("writes null args/scope when absent", async () => {
    await logCall({
      identity: { userId: USER, connectionId: null },
      tool: "x",
      ok: true,
      durationMs: 1,
    });
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({ args: null, scope: null });
  });

  it("cuts args longer than 4 KB into a valid JSON wrapper", () => {
    const big = { texto: "a".repeat(LOG_ARGS_MAX_CHARS * 2) };
    const logged = argsForLog(big) as { truncado: boolean; json: string };
    expect(logged.truncado).toBe(true);
    expect(logged.json).toHaveLength(LOG_ARGS_MAX_CHARS);
    expect(argsForLog({ a: 1 })).toEqual({ a: 1 });
  });
});
