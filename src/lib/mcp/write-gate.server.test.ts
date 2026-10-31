// Write gate for the MCP server (Task 5): assertMcpCanWrite is re-checked on
// every write path, independent of listFinanceScopesFor (list-only). Mocks
// tenant-access/billing-state (including the shared isSuperAdminUser check)
// so each scenario is driven directly.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantStatus: vi.fn(),
  isBillingLockedFor: vi.fn(),
  isSuperAdminUser: vi.fn(),
}));

vi.mock("@/lib/tenant-access.server", () => ({
  getTenantStatus: mocks.getTenantStatus,
}));
vi.mock("@/lib/billing/billing-state.server", () => ({
  isBillingLockedFor: mocks.isBillingLockedFor,
  isSuperAdminUser: mocks.isSuperAdminUser,
}));

import { assertMcpCanWrite } from "./write-gate.server";

const TENANT = "00000000-0000-4000-8000-000000000101";
const ADMIN = "00000000-0000-4000-8000-0000000000cc";
const SUPER = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSuperAdminUser.mockImplementation((userId: string) => Promise.resolve(userId === SUPER));
  mocks.isBillingLockedFor.mockResolvedValue(false);
});

describe("assertMcpCanWrite", () => {
  it("throws for a suspended house and a regular admin", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "suspended" });
    await expect(assertMcpCanWrite(TENANT, ADMIN)).rejects.toThrow(
      "Casa suspensa ou cancelada: só leitura pelo MCP.",
    );
  });

  it("throws for a canceled house and a regular admin", async () => {
    mocks.getTenantStatus.mockResolvedValue({ status: "canceled" });
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
