import { describe, expect, it } from "vitest";
import {
  categoryKey,
  categoryLabel,
  FIXED_COST_CATEGORIES,
  looksLikeBetleadsCost,
  mergeCategories,
} from "./categories";

describe("categoryLabel", () => {
  it("falls back to Outros for a null category", () => {
    expect(categoryLabel(null)).toBe("Outros");
  });

  it("trims and collapses spaces", () => {
    expect(categoryLabel("  equipe  ")).toBe("equipe");
    expect(categoryLabel("time   de   marketing")).toBe("time de marketing");
  });

  it("falls back to Outros for an empty-after-trim category", () => {
    expect(categoryLabel("   ")).toBe("Outros");
  });
});

describe("categoryKey", () => {
  it("lowercases pt-BR style", () => {
    expect(categoryKey("Equipe")).toBe("equipe");
  });
});

describe("mergeCategories", () => {
  it("keeps fixed categories first and does not repeat an existing one by key", () => {
    const merged = mergeCategories(FIXED_COST_CATEGORIES, ["Contador", "equipe"]);
    expect(merged.slice(0, FIXED_COST_CATEGORIES.length)).toEqual(FIXED_COST_CATEGORIES);
    expect(merged.filter((c) => categoryKey(c) === "equipe")).toHaveLength(1);
    expect(merged[merged.length - 1]).toBe("Contador");
  });
});

describe("looksLikeBetleadsCost", () => {
  it("matches on description", () => {
    expect(looksLikeBetleadsCost("SMS outubro", null)).toBe(true);
  });

  it("does not match an unrelated description/category pair", () => {
    expect(looksLikeBetleadsCost("Aluguel", "Equipe")).toBe(false);
  });

  it("matches on category", () => {
    expect(looksLikeBetleadsCost("x", "Mensalidade")).toBe(true);
  });
});
