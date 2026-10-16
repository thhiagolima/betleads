// Task 2 — fail-closed external send guard and demo action guard.
// A demo tenant (is_demo = true) must never reach a real provider call, and a
// null/undefined/unknown tenant must be treated the same way (fail-closed).

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tenants: [] as Row[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => (table === "tenants" ? state.tenants : []);
    const run = () => rows().filter((r) => filters.every((f) => f(r)));
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});

import {
  assertTenantCanSendExternally,
  assertTenantNotDemo,
  listDemoTenantIds,
  __resetDemoTenantCacheForTests,
} from "./tenant-access.server";
import { isDemoBlockedError, DemoTenantBlockedError } from "./demo-tenant";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const SUSPENDED = "00000000-0000-4000-8000-000000000003";
const UNKNOWN = "00000000-0000-4000-8000-00000000000f";

beforeEach(() => {
  __resetDemoTenantCacheForTests();
  state.tenants = [
    { id: NORMAL, status: "active", is_demo: false },
    { id: DEMO, status: "active", is_demo: true },
    { id: SUSPENDED, status: "suspended", is_demo: false },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("assertTenantCanSendExternally", () => {
  it("fails closed when the tenant id is null", async () => {
    await expect(assertTenantCanSendExternally(null)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });

  it("fails closed when the tenant id is undefined", async () => {
    await expect(assertTenantCanSendExternally(undefined)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });

  it("fails closed for an unknown tenant", async () => {
    await expect(assertTenantCanSendExternally(UNKNOWN)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });

  it("blocks a demo tenant", async () => {
    await expect(assertTenantCanSendExternally(DEMO)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });

  it("blocks a suspended tenant with the existing operational message", async () => {
    await expect(assertTenantCanSendExternally(SUSPENDED)).rejects.toThrow(
      "Tenant bloqueado para operacoes. Regularize a conta antes de continuar.",
    );
  });

  it("resolves for a normal, active tenant", async () => {
    await expect(assertTenantCanSendExternally(NORMAL)).resolves.toBeUndefined();
  });

  it("re-checks after the 5s cache expires and the tenant became demo", async () => {
    vi.useFakeTimers();
    await assertTenantCanSendExternally(NORMAL);

    const tenant = state.tenants.find((t) => t.id === NORMAL)!;
    tenant.is_demo = true;

    vi.advanceTimersByTime(6000);

    await expect(assertTenantCanSendExternally(NORMAL)).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
  });
});

describe("assertTenantNotDemo", () => {
  it("blocks a demo tenant with DEMO_ACTION_BLOCKED", async () => {
    await expect(assertTenantNotDemo(DEMO)).rejects.toMatchObject({
      code: "DEMO_ACTION_BLOCKED",
    });
  });

  it("resolves for a normal tenant", async () => {
    await expect(assertTenantNotDemo(NORMAL)).resolves.toBeUndefined();
  });
});

describe("listDemoTenantIds", () => {
  it("returns only tenants flagged is_demo", async () => {
    // The in-memory mock above does not implement eq("is_demo", true) filtering
    // against arbitrary tables generically; listDemoTenantIds queries tenants
    // directly so the shared `from` mock's eq() filter applies here too.
    const ids = await listDemoTenantIds();
    expect(ids).toEqual([DEMO]);
  });
});

describe("isDemoBlockedError", () => {
  it("recognizes a DemoTenantBlockedError instance", () => {
    expect(isDemoBlockedError(new DemoTenantBlockedError("DEMO_SEND_BLOCKED"))).toBe(true);
  });

  it("recognizes an error object carrying a matching code", () => {
    expect(isDemoBlockedError({ code: "DEMO_ACTION_BLOCKED" })).toBe(true);
  });

  it("recognizes a plain Error whose message contains the code (server fn serialization)", () => {
    expect(isDemoBlockedError(new Error("Something failed: DEMO_SEND_BLOCKED"))).toBe(true);
  });

  it("recognizes a plain string containing the code", () => {
    expect(isDemoBlockedError("DEMO_ACTION_BLOCKED: blocked")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isDemoBlockedError(new Error("unrelated"))).toBe(false);
    expect(isDemoBlockedError(null)).toBe(false);
    expect(isDemoBlockedError(undefined)).toBe(false);
  });
});
