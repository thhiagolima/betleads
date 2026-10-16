import { describe, expect, it } from "vitest";

import { comparableTenantIds } from "./tenant-comparison";

const ALL = ["a", "b", "c", "d"];

describe("comparableTenantIds", () => {
  it("allows an admin of two or more houses to compare exactly those houses", () => {
    expect(
      comparableTenantIds(
        [
          { tenant_id: "b", role: "admin" },
          { tenant_id: "a", role: "admin" },
          { tenant_id: "c", role: "gestor" },
        ],
        false,
        ALL,
      ),
    ).toEqual(["a", "b"]);
  });

  it("denies an admin of a single house", () => {
    expect(comparableTenantIds([{ tenant_id: "a", role: "admin" }], false, ALL)).toEqual([]);
  });

  it("never counts gestor or member roles", () => {
    expect(
      comparableTenantIds(
        [
          { tenant_id: "a", role: "admin" },
          { tenant_id: "b", role: "gestor" },
          { tenant_id: "c", role: "member" },
        ],
        false,
        ALL,
      ),
    ).toEqual([]);
  });

  it("does not count the same house twice", () => {
    expect(
      comparableTenantIds(
        [
          { tenant_id: "a", role: "admin" },
          { tenant_id: "a", role: "admin" },
        ],
        false,
        ALL,
      ),
    ).toEqual([]);
  });

  it("lets a platform super admin compare every house", () => {
    expect(comparableTenantIds([], true, ALL)).toEqual(ALL);
  });
});
