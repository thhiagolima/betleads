// F0-08 / SEC-21 — "admin" is a per-tenant role. An admin of house A who is a
// plain member of house B must be refused on B's admin-only actions
// (resetDashboards, getFailedSmsBreakdown, resendFailedSms), even though the
// global has_role(uid, 'admin') answers true for them.
//
// Server fn handlers are rewritten by the TanStack Start compiler, so the
// shared guard they call is what is exercised here.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    // The legacy global check: the user IS an admin somewhere.
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: "t", status: "active" }, error: null }),
        }),
      }),
    }),
  },
}));

import { requireActiveTenantAdmin } from "./tenant-access.server";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

/** User JWT client: admin of A, member of B. is_tenant_admin uses auth.uid(). */
function userClient(activeTenant: string, opts: { superAdmin?: boolean; rpcError?: boolean } = {}) {
  return {
    rpc: vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "current_tenant_id") return { data: activeTenant, error: null };
      if (name === "is_tenant_admin") {
        if (opts.rpcError) return { data: null, error: { message: "boom" } };
        return { data: opts.superAdmin || args?._tenant === A, error: null };
      }
      if (name === "has_role") return { data: true, error: null };
      return { data: null, error: null };
    }),
  };
}

describe("requireActiveTenantAdmin", () => {
  it("refuses an admin of A acting on B", async () => {
    await expect(requireActiveTenantAdmin(userClient(B), "Apenas administradores")).rejects.toThrow(
      "Apenas administradores",
    );
  });

  it("returns the active tenant for an admin of that tenant", async () => {
    await expect(requireActiveTenantAdmin(userClient(A), "x")).resolves.toBe(A);
  });

  it("lets a super admin through (is_tenant_admin covers super_admin)", async () => {
    await expect(requireActiveTenantAdmin(userClient(B, { superAdmin: true }), "x")).resolves.toBe(
      B,
    );
  });

  it("checks the tenant with the user's own client, never the global has_role", async () => {
    const client = userClient(B);
    await expect(requireActiveTenantAdmin(client, "x")).rejects.toThrow();
    const names = client.rpc.mock.calls.map((c) => c[0]);
    expect(names).toContain("is_tenant_admin");
    expect(names).not.toContain("has_role");
  });

  it("fails closed when the role check errors", async () => {
    await expect(requireActiveTenantAdmin(userClient(A, { rpcError: true }), "x")).rejects.toThrow(
      "boom",
    );
  });
});
