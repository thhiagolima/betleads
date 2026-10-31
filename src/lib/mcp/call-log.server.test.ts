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

import { logCall } from "./call-log.server";
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
      identity: { userId: USER, connectionId: CONNECTION, clientId: "client-1", level: "read" },
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
