import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn with the type-scale tokens", () => {
  it("keeps a size token next to a colour", () => {
    expect(cn("text-kpi text-success")).toBe("text-kpi text-success");
    expect(cn("text-meta text-muted-foreground")).toBe("text-meta text-muted-foreground");
  });

  it("lets a later size win over an earlier one", () => {
    expect(cn("text-sm", "text-label")).toBe("text-label");
    expect(cn("text-section", "text-base")).toBe("text-base");
  });

  it("still merges colours", () => {
    expect(cn("text-success", "text-danger")).toBe("text-danger");
  });
});
