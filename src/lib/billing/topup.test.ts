import { describe, expect, it } from "vitest";

import {
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  resolveTopupAmount,
  shouldPollTopupStatus,
  topupDescription,
  topupView,
} from "./topup";

describe("resolveTopupAmount", () => {
  it("resolves a known package by code", () => {
    expect(resolveTopupAmount({ packageCode: "p1000" })).toEqual({
      amountCents: 100000,
      packageCode: "p1000",
    });
  });

  it("accepts a free amount at the minimum", () => {
    expect(resolveTopupAmount({ amountCents: MIN_TOPUP_CENTS })).toEqual({
      amountCents: MIN_TOPUP_CENTS,
      packageCode: null,
    });
  });

  it("rejects a free amount below the minimum", () => {
    expect(() => resolveTopupAmount({ amountCents: 9999 })).toThrow(
      "Valor mínimo de compra: R$ 100,00",
    );
  });

  it("rejects a free amount above the maximum", () => {
    expect(() => resolveTopupAmount({ amountCents: MAX_TOPUP_CENTS + 1 })).toThrow(
      "Valor máximo de compra: R$ 50.000,00",
    );
  });

  it("rejects an unknown package code", () => {
    expect(() => resolveTopupAmount({ packageCode: "does-not-exist" })).toThrow(
      "Pacote inválido",
    );
  });

  it("rejects a non-integer free amount", () => {
    expect(() => resolveTopupAmount({ amountCents: 15000.5 })).toThrow("Valor inválido");
  });
});

describe("topupDescription", () => {
  it("formats the house name, label and BRL amount", () => {
    expect(topupDescription("Sorte Alta", 100000)).toBe(
      "Sorte Alta - Créditos BetLeads R$ 1.000,00",
    );
  });

  it("truncates a long house name so the description stays at 140 chars", () => {
    const longName = "A".repeat(200);
    const description = topupDescription(longName, 100000);
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description.endsWith(" - Créditos BetLeads R$ 1.000,00")).toBe(true);
  });

  it("cuts a long house name at a code-point boundary, never splitting an emoji's surrogate pair", () => {
    // Suffix for this amount is 32 chars, so the name is cut at 108 code
    // points. A leading single-unit char followed only by 2-unit emoji
    // forces a naive UTF-16 `string.slice(0, 108)` to land mid-surrogate
    // (1 + 107 emoji-units is an odd number of UTF-16 units into the run),
    // which this code-point-based cut must avoid.
    const longName = "A" + "\u{1F600}".repeat(110); // "A" + 110 grinning-face emoji
    const description = topupDescription(longName, 100000);

    expect(description.endsWith(" - Créditos BetLeads R$ 1.000,00")).toBe(true);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(description)).toBe(false);
  });

  it("falls back to 'Casa' for an empty house name", () => {
    expect(topupDescription("", 100000)).toBe("Casa - Créditos BetLeads R$ 1.000,00");
  });

  it("falls back to 'Casa' for a house name that is only whitespace after the cut", () => {
    expect(topupDescription("   ", 100000)).toBe("Casa - Créditos BetLeads R$ 1.000,00");
  });
});

describe("topupView (buy-credits dialog screen)", () => {
  const base = { credited: false, needsReview: false, serverStatus: "ACTIVE", localExpired: false };

  it("shows the Pix while ACTIVE and not expired", () => {
    expect(topupView(base)).toBe("pay");
  });

  it("credited wins over everything", () => {
    expect(topupView({ ...base, credited: true, needsReview: true, serverStatus: "PAID" })).toBe(
      "credited",
    );
  });

  it("needs review (stop polling, talk to support) before PAID or expired", () => {
    expect(topupView({ ...base, needsReview: true, serverStatus: "PAID" })).toBe("review");
    expect(topupView({ ...base, needsReview: true, localExpired: true })).toBe("review");
  });

  it("PAID not credited shows 'confirmando' even after the local countdown hit zero", () => {
    expect(topupView({ ...base, serverStatus: "PAID" })).toBe("paid_confirming");
    expect(topupView({ ...base, serverStatus: "PAID", localExpired: true })).toBe(
      "paid_confirming",
    );
  });

  it("expired locally or by a final Upper status", () => {
    expect(topupView({ ...base, localExpired: true })).toBe("expired");
    for (const status of ["EXPIRED", "CANCELLED", "FAILED"]) {
      expect(topupView({ ...base, serverStatus: status })).toBe("expired");
    }
  });
});

describe("shouldPollTopupStatus", () => {
  it("polls before the first answer and while PENDING/ACTIVE/PAID-not-credited", () => {
    expect(shouldPollTopupStatus(undefined)).toBe(true);
    expect(shouldPollTopupStatus({ status: "ACTIVE", credited: false })).toBe(true);
    expect(shouldPollTopupStatus({ status: "PAID", credited: false, needsReview: false })).toBe(
      true,
    );
  });

  it("stops when credited, flagged for review, or on a final unpaid status", () => {
    expect(shouldPollTopupStatus({ status: "PAID", credited: true })).toBe(false);
    expect(shouldPollTopupStatus({ status: "PAID", credited: false, needsReview: true })).toBe(
      false,
    );
    expect(shouldPollTopupStatus({ status: "EXPIRED", credited: false })).toBe(false);
  });
});
