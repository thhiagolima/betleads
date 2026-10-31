// Final review item 2: deactivating or deleting a user cuts their MCP access
// (mcp_access row deleted, every connection revoked, tokens stop resolving).
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  updateUserById: null as unknown as ReturnType<typeof vi.fn>,
  deleteUser: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  fake.updateUserById = vi.fn().mockResolvedValue({ data: {}, error: null });
  fake.deleteUser = vi.fn().mockResolvedValue({ data: {}, error: null });
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      auth: { admin: { updateUserById: fake.updateUserById, deleteUser: fake.deleteUser } },
    },
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { resolveBearer } from "@/lib/mcp/access.server";
import { sha256Hex } from "@/lib/mcp/crypto.server";
import { adminDeleteUserFor, adminSetUserActiveFor } from "./admin.functions";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const CONN_1 = "00000000-0000-4000-8000-000000000001";
const CONN_2 = "00000000-0000-4000-8000-000000000002";

async function seedMcpUser(): Promise<string> {
  fake.admin.rows("mcp_access").push({ user_id: USER, level: "write" });
  for (const id of [CONN_1, CONN_2]) {
    fake.admin.rows("mcp_connections").push({
      id,
      user_id: USER,
      client_id: "client-1",
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    });
  }
  const token = "tok-plain";
  fake.admin.rows("mcp_tokens").push({
    token_hash: await sha256Hex(token),
    connection_id: CONN_1,
    kind: "access",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    used_at: null,
  });
  return token;
}

function expectMcpCut() {
  expect(fake.admin.rows("mcp_access").find((r) => r.user_id === USER)).toBeUndefined();
  for (const conn of fake.admin.rows("mcp_connections")) {
    expect(conn.revoked_at).not.toBeNull();
  }
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER, error: null }));
  fake.updateUserById.mockClear();
  fake.deleteUser.mockClear();
});

describe("adminSetUserActiveFor and MCP", () => {
  it("deactivating a user deletes mcp_access and revokes all connections: token stops resolving", async () => {
    const token = await seedMcpUser();
    expect(await resolveBearer(token)).not.toBeNull();

    await adminSetUserActiveFor({ userId: SUPER }, { user_id: USER, active: false });

    expect(fake.updateUserById).toHaveBeenCalledWith(USER, { ban_duration: "876000h" });
    expectMcpCut();
    expect(await resolveBearer(token)).toBeNull();
  });

  it("reactivating a user does not grant MCP back nor touch other rows", async () => {
    const token = await seedMcpUser();
    await adminSetUserActiveFor({ userId: SUPER }, { user_id: USER, active: true });
    expect(fake.admin.rows("mcp_access")).toHaveLength(1);
    expect(await resolveBearer(token)).not.toBeNull();
  });

  it("a non-super-admin cannot deactivate (MCP untouched)", async () => {
    const token = await seedMcpUser();
    await expect(
      adminSetUserActiveFor({ userId: USER }, { user_id: SUPER, active: false }),
    ).rejects.toThrow(/super admin/i);
    expect(await resolveBearer(token)).not.toBeNull();
  });
});

describe("adminDeleteUserFor and MCP", () => {
  it("deleting a user deletes mcp_access and revokes all connections: token stops resolving", async () => {
    const token = await seedMcpUser();
    expect(await resolveBearer(token)).not.toBeNull();

    await adminDeleteUserFor({ userId: SUPER }, { user_id: USER });

    expect(fake.deleteUser).toHaveBeenCalledWith(USER);
    expectMcpCut();
    expect(await resolveBearer(token)).toBeNull();
  });
});
