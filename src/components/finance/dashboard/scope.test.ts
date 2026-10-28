import { describe, expect, it } from "vitest";

import type { DashboardScope } from "@/lib/finance-dashboard.functions";

import { scopeToValue, tenantClickAction, valueToScope, withCurrentScope } from "./scope";

const G1: DashboardScope = { kind: "group", groupId: "g1" };
const G2: DashboardScope = { kind: "group", groupId: "g2" };
const ALL: DashboardScope = { kind: "all" };
const HOUSE: DashboardScope = { kind: "tenant", tenantId: "t1" };

describe("scope values", () => {
  it("round-trips every scope kind", () => {
    for (const scope of [G1, ALL, HOUSE]) expect(valueToScope(scopeToValue(scope))).toEqual(scope);
  });
});

describe("withCurrentScope", () => {
  const options = {
    groups: [{ id: "g1", nome: "Grupo 1" }],
    tenants: [{ id: "t1", nome: "Casa 1" }],
  };

  it("adds a house that is not in the list (demo, inactive), labeled with the dashboard label", () => {
    const demo: DashboardScope = { kind: "tenant", tenantId: "demo" };
    expect(withCurrentScope(options, demo, "Casa Betleads").tenants).toEqual([
      { id: "t1", nome: "Casa 1" },
      { id: "demo", nome: "Casa Betleads" },
    ]);
  });

  it("adds a group that is not in the list", () => {
    expect(withCurrentScope(options, G2, "Grupo 2").groups).toEqual([
      { id: "g1", nome: "Grupo 1" },
      { id: "g2", nome: "Grupo 2" },
    ]);
  });

  it("keeps the options when the scope is listed, is all, or has no label yet", () => {
    expect(withCurrentScope(options, HOUSE, "Casa 1")).toBe(options);
    expect(withCurrentScope(options, G1, "Grupo 1")).toBe(options);
    expect(withCurrentScope(options, ALL, "Todas as casas")).toBe(options);
    expect(withCurrentScope(options, { kind: "tenant", tenantId: "x" }, undefined)).toBe(options);
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
