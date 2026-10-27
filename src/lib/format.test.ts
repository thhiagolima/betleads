import { describe, expect, it } from "vitest";

import { billingItemLabel, brl, brlUnitPrice, walletEntryTypeLabel } from "./format";

// Node's ICU formats "R$" and the amount with a non-breaking space (U+00A0);
// normalize to a plain space so assertions here don't depend on that detail.
const NBSP = String.fromCharCode(160);
function plain(s: string) {
  return s.split(NBSP).join(" ");
}

describe("brl", () => {
  it("always shows exactly 2 decimals", () => {
    expect(plain(brl(10137.9))).toBe("R$ 10.137,90");
    expect(plain(brl(0))).toBe("R$ 0,00");
  });
});

describe("brlUnitPrice", () => {
  it("shows up to 3 decimals, never more", () => {
    expect(plain(brlUnitPrice(0.08))).toBe("R$ 0,08");
    expect(plain(brlUnitPrice(0.002))).toBe("R$ 0,002");
    // 4th decimal rounds away — fix round 1 lowered the cap from 4 to 3.
    expect(plain(brlUnitPrice(0.0021))).toBe("R$ 0,002");
  });

  it("never shows fewer than 2 decimals", () => {
    expect(plain(brlUnitPrice(0.1))).toBe("R$ 0,10");
  });
});

describe("walletEntryTypeLabel", () => {
  it("maps every known entry_type to its pt-BR label", () => {
    expect(walletEntryTypeLabel("purchase")).toBe("Compra");
    expect(walletEntryTypeLabel("manual_adjustment")).toBe("Ajuste");
    expect(walletEntryTypeLabel("usage_reservation")).toBe("Consumo");
    expect(walletEntryTypeLabel("usage_refund")).toBe("Estorno");
    expect(walletEntryTypeLabel("migration")).toBe("Conversão de créditos");
  });

  it("falls back to the raw value for an unknown entry_type", () => {
    expect(walletEntryTypeLabel("something_new")).toBe("something_new");
  });
});

describe("billingItemLabel", () => {
  it("maps every known item to its pt-BR label", () => {
    expect(billingItemLabel("sms")).toBe("SMS");
    expect(billingItemLabel("voice_30s")).toBe("Voz");
    expect(billingItemLabel("email")).toBe("E-mail");
  });

  it("returns '-' for null/undefined", () => {
    expect(billingItemLabel(null)).toBe("-");
    expect(billingItemLabel(undefined)).toBe("-");
  });
});
