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
  adminSetMcpAreasFor,
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
      areas: [],
      mcpUrl: expect.stringContaining("/api/mcp"),
      connections: [],
      hasUsedTools: false,
    });
  });

  it("reports the areas and whether a Claude connection already called a tool", async () => {
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "read", areas: ["operacao"] });
    seedConnection();
    // An admin action (no connection) does not count as using the MCP.
    fake.admin.rows("mcp_call_log").push({ id: 1, user_id: USER_A, connection_id: null, tool: "admin.set_access" });
    let status = await getMyMcpStatusFor({ userId: USER_A });
    expect(status.areas).toEqual(["operacao"]);
    expect(status.hasUsedTools).toBe(false);

    fake.admin.rows("mcp_call_log").push({ id: 2, user_id: USER_A, connection_id: CONNECTION, tool: "listar_escopos" });
    status = await getMyMcpStatusFor({ userId: USER_A });
    expect(status.hasUsedTools).toBe(true);
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
      {
        userId: USER_A,
        nome: "Dona da Casa",
        email: "dono@casa.com",
        level: "read",
        areas: ["financeiro"],
        operacaoElegivel: true,
        connections: [],
      },
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

  it("writes an admin audit row mcp.access_set with target user and before/after level", async () => {
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "read" });
    await adminSetMcpAccessFor({ userId: SUPER }, { userId: USER_A, level: "write" });
    await adminSetMcpAccessFor({ userId: SUPER }, { userId: USER_A, level: "none" });

    expect(fake.admin.rows("admin_audit_logs")).toEqual([
      expect.objectContaining({
        actor_user_id: SUPER,
        action: "mcp.access_set",
        target_user_id: USER_A,
        before_data: { level: "read" },
        after_data: { level: "write" },
      }),
      expect.objectContaining({
        actor_user_id: SUPER,
        action: "mcp.access_set",
        target_user_id: USER_A,
        before_data: { level: "write" },
        after_data: { level: "none" },
      }),
    ]);
    // The mcp_call_log rows are still written.
    expect(fake.admin.rows("mcp_call_log")).toHaveLength(2);
  });

  it("writes no audit row when the caller is not super admin", async () => {
    await expect(
      adminSetMcpAccessFor({ userId: USER_A }, { userId: USER_B, level: "write" }),
    ).rejects.toThrow();
    expect(fake.admin.rows("admin_audit_logs")).toHaveLength(0);
  });
});

describe("adminListMcpAccessFor areas", () => {
  it("shows stored areas and who may receive operação (admin, super admin, group manager; not gestor)", async () => {
    const GESTOR = "00000000-0000-4000-8000-0000000000dd";
    const MANAGER = "00000000-0000-4000-8000-0000000000ee";
    fake.admin.rows("user_roles").push(
      { user_id: USER_A, role: "admin", tenant_id: "t1" },
      { user_id: GESTOR, role: "gestor", tenant_id: "t1" },
      { user_id: SUPER, role: "super_admin", tenant_id: null },
    );
    fake.admin.rows("tenant_group_managers").push({ user_id: MANAGER, group_id: "g1" });
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "read", areas: ["financeiro", "operacao"] });

    const rows = await adminListMcpAccessFor({ userId: SUPER });
    const byId = new Map(rows.map((row) => [row.userId, row]));

    expect(byId.get(USER_A)).toMatchObject({ areas: ["financeiro", "operacao"], operacaoElegivel: true });
    expect(byId.get(GESTOR)).toMatchObject({ level: "none", operacaoElegivel: false });
    expect(byId.get(MANAGER)?.operacaoElegivel).toBe(true);
    expect(byId.get(SUPER)?.operacaoElegivel).toBe(true);
  });
});

describe("adminSetMcpAreasFor", () => {
  beforeEach(() => {
    fake.admin.rows("mcp_access").push({ user_id: USER_A, level: "read", areas: ["financeiro"] });
  });

  it("rejects a non-super-admin caller and logs the attempt", async () => {
    await expect(
      adminSetMcpAreasFor({ userId: USER_A }, { userId: USER_A, areas: ["operacao"] }),
    ).rejects.toThrow("Apenas o super admin pode realizar esta ação.");
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({ tool: "admin.set_areas", ok: false });
    expect(fake.admin.rows("admin_audit_logs")).toHaveLength(0);
  });

  it("turns operação on for a house admin, audits before/after and logs the call", async () => {
    fake.admin.rows("user_roles").push({ user_id: USER_A, role: "admin", tenant_id: "t1" });
    await adminSetMcpAreasFor({ userId: SUPER }, { userId: USER_A, areas: ["operacao", "financeiro"] });

    expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)?.areas).toEqual([
      "financeiro",
      "operacao",
    ]);
    expect(fake.admin.rows("admin_audit_logs")).toEqual([
      expect.objectContaining({
        actor_user_id: SUPER,
        action: "mcp.areas_set",
        target_user_id: USER_A,
        before_data: { areas: ["financeiro"] },
        after_data: { areas: ["financeiro", "operacao"] },
      }),
    ]);
    expect(fake.admin.rows("mcp_call_log")[0]).toMatchObject({
      user_id: SUPER,
      connection_id: null,
      tool: "admin.set_areas",
      ok: true,
    });
  });

  it("refuses operação for a user who is only gestor/member", async () => {
    fake.admin.rows("user_roles").push({ user_id: USER_A, role: "gestor", tenant_id: "t1" });
    await expect(
      adminSetMcpAreasFor({ userId: SUPER }, { userId: USER_A, areas: ["financeiro", "operacao"] }),
    ).rejects.toThrow("A área de operação só pode ser liberada");
    expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)?.areas).toEqual([
      "financeiro",
    ]);
  });

  it("allows operação for a group manager", async () => {
    fake.admin.rows("tenant_group_managers").push({ user_id: USER_A, group_id: "g1" });
    await adminSetMcpAreasFor({ userId: SUPER }, { userId: USER_A, areas: ["operacao"] });
    expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)?.areas).toEqual([
      "operacao",
    ]);
  });

  it("refuses an empty list and a user without a level", async () => {
    await expect(
      adminSetMcpAreasFor({ userId: SUPER }, { userId: USER_A, areas: [] }),
    ).rejects.toThrow("Escolha pelo menos uma área.");
    await expect(
      adminSetMcpAreasFor({ userId: SUPER }, { userId: USER_B, areas: ["financeiro"] }),
    ).rejects.toThrow("Conceda um nível de acesso antes de escolher as áreas.");
  });

  it("changing the level keeps the areas (upsert only touches the level)", async () => {
    fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)!.areas = ["financeiro", "operacao"];
    await adminSetMcpAccessFor({ userId: SUPER }, { userId: USER_A, level: "write" });
    expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER_A)).toMatchObject({
      level: "write",
      areas: ["financeiro", "operacao"],
    });
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

  it("writes an admin audit row mcp.connection_revoked with target user and connection id", async () => {
    seedConnection();
    await adminRevokeConnectionFor({ userId: SUPER }, { connectionId: CONNECTION });
    expect(fake.admin.rows("admin_audit_logs")).toEqual([
      expect.objectContaining({
        actor_user_id: SUPER,
        action: "mcp.connection_revoked",
        target_user_id: USER_A,
        after_data: { connection_id: CONNECTION },
      }),
    ]);
  });

  it("refuses an unknown connection id without auditing", async () => {
    await expect(
      adminRevokeConnectionFor({ userId: SUPER }, { connectionId: CONNECTION }),
    ).rejects.toThrow("Conexão não encontrada.");
    expect(fake.admin.rows("admin_audit_logs")).toHaveLength(0);
  });
});
