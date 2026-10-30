import { describe, expect, it } from "vitest";

import { FINANCE_TERMS } from "./definitions";

describe("FINANCE_TERMS", () => {
  const entries = Object.entries(FINANCE_TERMS);

  it("every term has a non-empty label and how", () => {
    for (const [key, term] of entries) {
      expect(term.label.trim(), `${key} label`).not.toBe("");
      expect(term.how.trim(), `${key} how`).not.toBe("");
    }
  });

  it("labels are unique", () => {
    const labels = entries.map(([, term]) => term.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
