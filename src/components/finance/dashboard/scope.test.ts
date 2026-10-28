import { describe, expect, it } from "vitest";

import type { DashboardScope } from "@/lib/finance-dashboard.functions";

import { scopeToValue, tenantClickAction, valueToScope } from "./scope";

const G1: DashboardScope = { kind: "group", groupId: "g1" };
const G2: DashboardScope = { kind: "group", groupId: "g2" };
const ALL: DashboardScope = { kind: "all" };
const HOUSE: DashboardScope = { kind: "tenant", tenantId: "t1" };

describe("scope values", () => {
  it("round-trips every scope kind", () => {
    for (const scope of [G1, ALL, HOUSE]) expect(valueToScope(scopeToValue(scope))).toEqual(scope);
  });
});

describe("tenantClickAction", () => {
  it("group manager on /grupo: a house row opens the caller's page", () => {
    expect(
      tenantClickAction({
        scope: G1,
        initialScope: G1,
        canPickScope: false,
        hasOnOpenTenant: true,
      }),
    ).toBe("open");
  });

  it("super admin on /grupo in the active group: opens the caller's page", () => {
    expect(
      tenantClickAction({ scope: G1, initialScope: G1, canPickScope: true, hasOnOpenTenant: true }),
    ).toBe("open");
  });

  it("super admin on /grupo in Todas as casas or another group: switches the picker to the house", () => {
    expect(
      tenantClickAction({
        scope: ALL,
        initialScope: G1,
        canPickScope: true,
        hasOnOpenTenant: true,
      }),
    ).toBe("switch");
    expect(
      tenantClickAction({ scope: G2, initialScope: G1, canPickScope: true, hasOnOpenTenant: true }),
    ).toBe("switch");
  });

  it("super admin on /financeiro (no callback): switches the picker to the house", () => {
    expect(
      tenantClickAction({
        scope: ALL,
        initialScope: HOUSE,
        canPickScope: true,
        hasOnOpenTenant: false,
      }),
    ).toBe("switch");
  });

  it("no callback and no picker: rows are not clickable", () => {
    expect(
      tenantClickAction({
        scope: G1,
        initialScope: G1,
        canPickScope: false,
        hasOnOpenTenant: false,
      }),
    ).toBeNull();
  });

  it("tenant scope has no house rows to click", () => {
    expect(
      tenantClickAction({
        scope: HOUSE,
        initialScope: HOUSE,
        canPickScope: true,
        hasOnOpenTenant: true,
      }),
    ).toBeNull();
  });
});
