import { describe, expect, it } from "vitest";

import { LOW_BALANCE_THRESHOLD, walletBalanceNotice } from "./wallet-notice";

describe("walletBalanceNotice", () => {
  it("never warns an exempt house, even at zero", () => {
    expect(
      walletBalanceNotice({ balance: 0, exempt: true, smsUnitPrice: 0.08, canBuy: false }),
    ).toBeNull();
  });

  it("empty at zero balance and below the price of one SMS segment", () => {
    expect(
      walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08, canBuy: false })?.kind,
    ).toBe("empty");
    expect(
      walletBalanceNotice({ balance: 0.05, exempt: false, smsUnitPrice: 0.08, canBuy: false })?.kind,
    ).toBe("empty");
    expect(
      walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: null, canBuy: false })?.kind,
    ).toBe("empty");
  });

  it("low from one segment up to the threshold, nothing at or above it", () => {
    expect(
      walletBalanceNotice({ balance: 0.08, exempt: false, smsUnitPrice: 0.08, canBuy: false })?.kind,
    ).toBe("low");
    expect(
      walletBalanceNotice({
        balance: LOW_BALANCE_THRESHOLD - 0.01,
        exempt: false,
        smsUnitPrice: 0.08,
        canBuy: false,
      })?.kind,
    ).toBe("low");
    expect(
      walletBalanceNotice({
        balance: LOW_BALANCE_THRESHOLD,
        exempt: false,
        smsUnitPrice: 0.08,
        canBuy: false,
      }),
    ).toBeNull();
  });

  it("without canBuy, keeps the current support-only text", () => {
    const notice = walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08, canBuy: false });
    expect(notice?.text).toBe(
      "Os envios de SMS estão bloqueados até entrar saldo. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    );
    const low = walletBalanceNotice({ balance: 50, exempt: false, smsUnitPrice: 0.08, canBuy: false });
    expect(low?.text).toBe(
      "Quando o saldo acabar, os envios de SMS param. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    );
  });

  it("with canBuy, the text ends pointing to the Pix purchase on this page", () => {
    const empty = walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08, canBuy: true });
    expect(empty?.text).toBe(
      "Os envios de SMS estão bloqueados até entrar saldo. Compre créditos por Pix nesta página.",
    );
    const low = walletBalanceNotice({ balance: 50, exempt: false, smsUnitPrice: 0.08, canBuy: true });
    expect(low?.text).toBe(
      "Quando o saldo acabar, os envios de SMS param. Compre créditos por Pix nesta página.",
    );
  });
});
