import { describe, expect, it } from "vitest";

import { normalizeEmail, normalizePhone } from "./channel-eligibility.server";

describe("channel eligibility normalization", () => {
  it("normalizes Brazilian mobile and landline numbers to E.164", () => {
    expect(normalizePhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(normalizePhone("55 11 3456-7890")).toBe("+551134567890");
  });

  it("rejects phone numbers outside the supported BR contract", () => {
    expect(normalizePhone("98765-4321")).toBeNull();
    expect(normalizePhone("+1 415 555 2671")).toBeNull();
  });

  it("normalizes valid email and rejects invalid email", () => {
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmail("invalid@")).toBeNull();
  });
});
