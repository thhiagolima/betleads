import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenants.functions", () => ({ getTenantSwitcher: vi.fn() }));

import { isDemoTenantIn } from "./use-is-demo-tenant";

const DEMO = "00000000-0000-4000-8000-00000000d0d0";
const HOUSE = "00000000-0000-4000-8000-00000000a0a0";
const switcher = (activeTenantId: string | null) => ({
  activeTenantId,
  tenants: [
    { id: DEMO, is_demo: true },
    { id: HOUSE, is_demo: false },
  ],
});

describe("isDemoTenantIn", () => {
  it("follows the active tenant when no tenant is given", () => {
    expect(isDemoTenantIn(switcher(DEMO))).toBe(true);
    expect(isDemoTenantIn(switcher(HOUSE))).toBe(false);
  });

  it("follows the given tenant, not the active one (super admin editing another house)", () => {
    expect(isDemoTenantIn(switcher(DEMO), HOUSE)).toBe(false);
    expect(isDemoTenantIn(switcher(HOUSE), DEMO)).toBe(true);
  });

  it("is false while loading or for an unknown tenant", () => {
    expect(isDemoTenantIn(undefined, DEMO)).toBe(false);
    expect(isDemoTenantIn(switcher(null))).toBe(false);
    expect(isDemoTenantIn(switcher(DEMO), "00000000-0000-4000-8000-0000000000ff")).toBe(false);
  });
});
