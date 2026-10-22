import { describe, expect, it } from "vitest";

import { LOW_BALANCE_THRESHOLD, walletBalanceNotice } from "./wallet-notice";

describe("walletBalanceNotice", () => {
  it("never warns an exempt house, even at zero", () => {
    expect(walletBalanceNotice({ balance: 0, exempt: true, smsUnitPrice: 0.08 })).toBeNull();
  });

  it("empty at zero balance and below the price of one SMS segment", () => {
    expect(walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08 })?.kind).toBe("empty");
    expect(walletBalanceNotice({ balance: 0.05, exempt: false, smsUnitPrice: 0.08 })?.kind).toBe("empty");
    expect(walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: null })?.kind).toBe("empty");
  });

  it("low from one segment up to the threshold, nothing at or above it", () => {
    expect(walletBalanceNotice({ balance: 0.08, exempt: false, smsUnitPrice: 0.08 })?.kind).toBe("low");
    expect(walletBalanceNotice({ balance: LOW_BALANCE_THRESHOLD - 0.01, exempt: false, smsUnitPrice: 0.08 })?.kind).toBe("low");
    expect(walletBalanceNotice({ balance: LOW_BALANCE_THRESHOLD, exempt: false, smsUnitPrice: 0.08 })).toBeNull();
  });
});
