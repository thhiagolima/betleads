// Write gate for the MCP server (Task 5): assertMcpCanWrite is re-checked on
// every write path, independent of listFinanceScopesFor (list-only). Mocks
// tenant-access/billing-state so each scenario is driven directly, plus the
// client.server module for the is_super_admin RPC.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantStatus: vi.fn(),
  isBillingLockedFor: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));
vi.mock("@/lib/tenant-access.server", () => ({
  getTenantStatus: mocks.getTenantStatus,
}));
vi.mock("@/lib/billing/billing-state.server", () => ({
  isBillingLockedFor: mocks.isBillingLockedFor,
}));

import { assertMcpCanWrite } from "./write-gate.server";

const TENANT = "00000000-0000-4000-8000-000000000101";
const ADMIN = "00000000-0000-4000-8000-0000000000cc";
const SUPER = "00000000-0000-4000-8000-0000000000aa";

function setSuperAdmin(userId: string) {
  mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === "is_super_admin") return Promise.resolve({ data: args._user_id === SUPER, error: null });
    throw new Error(`unexpected rpc ${fn}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setSuperAdmin(ADMIN);
  mocks.isBillingLockedFor.mockResolvedValue(false);
});

describe("assertMcpCanWrite", () => {
  it("throws for a suspended house and a regular admin", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "suspended" });
    await expect(assertMcpCanWrite(TENANT, ADMIN)).rejects.toThrow(
      "Casa suspensa ou cancelada: só leitura pelo MCP.",
    );
  });

  it("resolves for a suspended house when the caller is super admin", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "suspended" });
    await expect(assertMcpCanWrite(TENANT, SUPER)).resolves.toBeUndefined();
    expect(mocks.getTenantStatus).not.toHaveBeenCalled();
  });

  it("throws for a billing-locked house and a regular admin", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "active" });
    mocks.isBillingLockedFor.mockResolvedValue(true);
    await expect(assertMcpCanWrite(TENANT, ADMIN)).rejects.toThrow(
      "Casa bloqueada por cobrança: só leitura pelo MCP.",
    );
  });

  it("resolves for an active, unlocked house", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "active" });
    mocks.isBillingLockedFor.mockResolvedValue(false);
    await expect(assertMcpCanWrite(TENANT, ADMIN)).resolves.toBeUndefined();
  });
});
