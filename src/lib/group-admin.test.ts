import { describe, expect, it } from "vitest";

import { selectableTenantsForGroup } from "@/lib/group-admin";

describe("selectableTenantsForGroup", () => {
  it("keeps only ungrouped houses matching the group's demo-ness, plus the group's own houses", () => {
    const result = selectableTenantsForGroup({
      groupIsDemo: false,
      ungroupedTenants: [
        { id: "1", nome: "Beta", is_demo: false },
        { id: "2", nome: "Demo House", is_demo: true },
      ],
      groupTenants: [{ id: "3", nome: "Casa C" }],
    });
    expect(result).toEqual([
      { id: "1", nome: "Beta" },
      { id: "3", nome: "Casa C" },
    ]);
  });

  it("offers only demo houses when the group is a demo group", () => {
    const result = selectableTenantsForGroup({
      groupIsDemo: true,
      ungroupedTenants: [
        { id: "1", nome: "Beta", is_demo: false },
        { id: "2", nome: "Demo House", is_demo: true },
      ],
      groupTenants: [],
    });
    expect(result).toEqual([{ id: "2", nome: "Demo House" }]);
  });

  it("sorts by name and de-duplicates a house that is both ungrouped-listed and in the group", () => {
    const result = selectableTenantsForGroup({
      groupIsDemo: false,
      ungroupedTenants: [{ id: "1", nome: "Zeta", is_demo: false }],
      groupTenants: [
        { id: "1", nome: "Zeta" },
        { id: "2", nome: "Alfa" },
      ],
    });
    expect(result).toEqual([
      { id: "2", nome: "Alfa" },
      { id: "1", nome: "Zeta" },
    ]);
  });

  it("returns an empty list when there are no candidate houses", () => {
    expect(
      selectableTenantsForGroup({ groupIsDemo: false, ungroupedTenants: [], groupTenants: [] }),
    ).toEqual([]);
  });
});
