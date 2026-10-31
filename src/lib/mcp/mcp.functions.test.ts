// MCP financeiro, Task 9: super admin access panel + "Conectar ao Claude"
// page. Same createFakeDb stand-in as the other mcp/*.test.ts files;
// isSuperAdminUser is mocked directly (same pattern as write-gate.server.test.ts)
// so each scenario is driven without a real is_super_admin RPC.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  listUsers: null as unknown as ReturnType<typeof vi.fn>,
}));

const mocks = vi.hoisted(() => ({ isSuperAdminUser: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  fake.listUsers = vi.fn().mockResolvedValue({ data: { users: [] }, error: null });
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      auth: { admin: { listUsers: fake.listUsers } },
    },
  };
});

vi.mock("@/lib/billing/billing-state.server", () => ({
  isSuperAdminUser: mocks.isSuperAdminUser,
}));

import { resolveBearer } from "./access.server";
import { sha256Hex } from "./crypto.server";
import {
  adminListMcpAccessFor,
  adminRevokeConnectionFor,
  adminSetMcpAccessFor,
  getMyMcpStatusFor,
  revokeMyConnectionFor,
} from "./mcp.functions";
import { createFakeDb } from "../sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const USER_A = "00000000-0000-4000-8000-0000000000bb";
const USER_B = "00000000-0000-4000-8000-0000000000cc";
const CONNECTION = "00000000-0000-4000-8000-000000000002";
const CLIENT = "client-abc";

function seedConnection(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("mcp_connections").push({
    id: CONNECTION,
    user_id: USER_A,
    client_id: CLIENT,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  });
  fake.admin.rows("mcp_oauth_clients").push({ id: CLIENT, client_name: "Claude.ai" });
}

async function seedAccessToken(connectionId = CONNECTION) {
  const token = "tok-plain";
  fake.admin.rows("mcp_tokens").push({
    token_hash: await sha256Hex(token),
    connection_id: connectionId,
    kind: "access",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    used_at: null,
  });
  return token;
}

beforeEach(() => {
  fake.admin.reset();
  fake.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  mocks.isSuperAdminUser.mockReset();
  mocks.isSuperAdminUser.mockImplementation((userId: string) => Promise.resolve(userId === SUPER));
  delete process.env.VITE_PUBLIC_APP_URL;
  process.env.MCP_ENABLED = "true";
});

describe("getMyMcpStatusFor", () => {
  it("reports disabled (and no connections) when MCP_ENABLED is off", async () => {
    process.env.MCP_ENABLED = "false";
    seedConnection();
    const status = await getMyMcpStatusFor({ userId: USER_A });
    expect(status).toEqual({
      enabled: false,
      level: "none",
      mcpUrl: expect.stringContaining("/api/mcp"),
      connections: [],
    });
  });

  it("returns the user's level and own non-revoked connections, with the client name", async () => {
    process.env.VITE_PUBLIC_APP_URL = "https://betleads.io/";
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "write" });
    seedConnection();
    seedConnection({ id: "conn-revoked", revoked_at: new Date().toISOString() });

    const status = await getMyMcpStatusFor({ userId: USER_A });

    expect(status.enabled).toBe(true);
    expect(status.level).toBe("write");
    expect(status.mcpUrl).toBe("https://betleads.io/api/mcp");
    expect(status.connections).toEqual([
      expect.objectContaining({ id: CONNECTION, clientName: "Claude.ai" }),
    ]);
  });
});

describe("revokeMyConnectionFor", () => {
  it("revokes the caller's own connection", async () => {
    seedConnection();
    await revokeMyConnectionFor({ userId: USER_A }, { connectionId: CONNECTION });
    const row = fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION);
    expect(row?.revoked_at).not.toBeNull();
  });

  it("rejects another user's connection, and leaves it untouched", async () => {
    seedConnection();
    await expect(
      revokeMyConnectionFor({ userId: USER_B }, { connectionId: CONNECTION }),
    ).rejects.toThrow("Conexão não encontrada.");
    const row = fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION);
    expect(row?.revoked_at).toBeNull();
  });
});

describe("adminListMcpAccessFor", () => {
  it("rejects a non-super-admin caller", async () => {
    await expect(adminListMcpAccessFor({ userId: USER_A })).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
  });

  it("lists candidate users (user_roles admin/owner/gestor) with their level and name/email", async () => {
    fake.admin.rows("user_roles").push({ user_id: USER_A, role: "admin", tenant_id: "t1" });
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "read" });
    fake.listUsers.mockResolvedValue({
      data: { users: [{ id: USER_A, email: "dono@casa.com", user_metadata: { nome: "Dona da Casa" } }] },
      error: null,
    });

    const rows = await adminListMcpAccessFor({ userId: SUPER });

    expect(rows).toEqual([
      { userId: USER_A, nome: "Dona da Casa", email: "dono@casa.com", level: "read", connections: [] },
    ]);
  });
});

describe("adminSetMcpAccessFor", () => {
  it("rejects a non-super-admin caller and still logs the attempt", async () => {
    await expect(
      adminSetMcpAccessFor({ userId: USER_A }, { userId: USER_B, level: "write" }),
    ).rejects.toThrow("Apenas o super admin pode realizar esta ação.");
    const log = fake.admin.rows("mcp_call_log")[0];
    expect(log).toMatchObject({ user_id: USER_A, connection_id: null, tool: "admin.set_access", ok: false });
  });

  it("grants a level by upserting mcp_access, and logs ok:true with no connection", async () => {
    await adminSetMcpAccessFor({ userId: SUPER }, { userId: USER_A, level: "write" });
    const row = fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A);
    expect(row?.level).toBe("write");
    const log = fake.admin.rows("mcp_call_log")[0];
    expect(log).toMatchObject({ user_id: SUPER, connection_id: null, tool: "admin.set_access", ok: true });
  });

  it("setting level:none deletes the mcp_access row and revokes every connection — tokens stop resolving", async () => {
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "write" });
    seedConnection();
    const token = await seedAccessToken();
    expect(await resolveBearer(token)).not.toBeNull();

    await adminSetMcpAccessFor({ userId: SUPER }, { userId: USER_A, level: "none" });

    expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)).toBeUndefined();
    const conn = fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION);
    expect(conn?.revoked_at).not.toBeNull();
    expect(await resolveBearer(token)).toBeNull();
  });
});

describe("adminRevokeConnectionFor", () => {
  it("rejects a non-super-admin caller", async () => {
    seedConnection();
    await expect(
      adminRevokeConnectionFor({ userId: USER_A }, { connectionId: CONNECTION }),
    ).rejects.toThrow("Apenas o super admin pode realizar esta ação.");
  });

  it("revokes any user's connection and logs with no connection_id of its own", async () => {
    seedConnection();
    await adminRevokeConnectionFor({ userId: SUPER }, { connectionId: CONNECTION });
    const conn = fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION);
    expect(conn?.revoked_at).not.toBeNull();
    const log = fake.admin.rows("mcp_call_log")[0];
    expect(log).toMatchObject({
      user_id: SUPER,
      connection_id: null,
      tool: "admin.revoke_connection",
      ok: true,
    });
  });
});
