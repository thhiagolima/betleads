import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { consentRowsToCsv, consentSearchPattern } from "./consent.functions";

describe("consentSearchPattern", () => {
  it("returns null for empty search", () => {
    expect(consentSearchPattern("")).toBeNull();
    expect(consentSearchPattern("   ")).toBeNull();
    expect(consentSearchPattern(null)).toBeNull();
  });

  it("keeps only digits for phone-like terms (subjects are stored as digits)", () => {
    expect(consentSearchPattern("(11) 99999-1234")).toBe("%11999991234%");
  });

  it("lowercases e-mail terms and escapes LIKE wildcards", () => {
    expect(consentSearchPattern(" Ana_B%@Exemplo.com ")).toBe(String.raw`%ana\_b\%@exemplo.com%`);
  });
});

describe("consentRowsToCsv", () => {
  it("writes header and quoted rows", () => {
    const csv = consentRowsToCsv([
      {
        channel: "sms",
        subject: "5511999991234",
        status: "revoked",
        reason: 'disse "pare"',
        legal_basis: null,
        source: "operator",
        updated_at: "2026-10-21T00:00:00Z",
      },
    ]);
    expect(csv.split("\n")).toEqual([
      "channel,subject,status,reason,legal_basis,source,updated_at",
      '"sms","5511999991234","revoked","disse ""pare""","","operator","2026-10-21T00:00:00Z"',
    ]);
  });
});
