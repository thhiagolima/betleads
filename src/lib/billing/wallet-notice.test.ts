import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOW_BALANCE_THRESHOLD,
  parseThresholdInput,
  walletBalanceNotice,
  walletNoticeInputFromPortal,
} from "./wallet-notice";

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
        balance: DEFAULT_LOW_BALANCE_THRESHOLD - 0.01,
        exempt: false,
        smsUnitPrice: 0.08,
        canBuy: false,
      })?.kind,
    ).toBe("low");
    expect(
      walletBalanceNotice({
        balance: DEFAULT_LOW_BALANCE_THRESHOLD,
        exempt: false,
        smsUnitPrice: 0.08,
        canBuy: false,
      }),
    ).toBeNull();
  });

  it("without canBuy, keeps the current support-only text", () => {
    const notice = walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08, canBuy: false });
    expect(notice?.text).toBe(
      "SMS e voz ficam bloqueados até entrar saldo; e-mail segue só dentro da franquia mensal. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    );
    const low = walletBalanceNotice({ balance: 50, exempt: false, smsUnitPrice: 0.08, canBuy: false });
    expect(low?.text).toBe(
      "Quando o saldo acabar, SMS e voz ficam bloqueados; e-mail segue só dentro da franquia mensal. A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo.",
    );
  });

  it("with canBuy, the text ends pointing (page-neutral) to the Pix purchase in Saldo e consumo", () => {
    const empty = walletBalanceNotice({ balance: 0, exempt: false, smsUnitPrice: 0.08, canBuy: true });
    expect(empty?.text).toBe(
      "SMS e voz ficam bloqueados até entrar saldo; e-mail segue só dentro da franquia mensal. Compre créditos por Pix em Saldo e consumo.",
    );
    const low = walletBalanceNotice({ balance: 50, exempt: false, smsUnitPrice: 0.08, canBuy: true });
    expect(low?.text).toBe(
      "Quando o saldo acabar, SMS e voz ficam bloqueados; e-mail segue só dentro da franquia mensal. Compre créditos por Pix em Saldo e consumo.",
    );
  });

  it("uses the house's own threshold: R$ 199,99 warns and R$ 200,00 does not at 200", () => {
    const base = { exempt: false, smsUnitPrice: 0.08, canBuy: false };
    expect(walletBalanceNotice({ ...base, balance: 199.99, threshold: 200 })?.kind).toBe("low");
    expect(walletBalanceNotice({ ...base, balance: 200, threshold: 200 })).toBeNull();
    expect(walletBalanceNotice({ ...base, balance: 450, threshold: 500 })?.kind).toBe("low");
    expect(walletBalanceNotice({ ...base, balance: 150, threshold: 100 })).toBeNull();
  });

  it("a threshold of 0 turns the low warning off but never the empty one", () => {
    const base = { exempt: false, smsUnitPrice: 0.08, canBuy: false, threshold: 0 };
    expect(walletBalanceNotice({ ...base, balance: 5 })).toBeNull();
    expect(walletBalanceNotice({ ...base, balance: 0 })?.kind).toBe("empty");
  });

  it("falls back to the default when the threshold is missing or invalid", () => {
    const base = { exempt: false, smsUnitPrice: 0.08, canBuy: false };
    expect(walletBalanceNotice({ ...base, balance: 199.99, threshold: null })?.kind).toBe("low");
    expect(walletBalanceNotice({ ...base, balance: 199.99, threshold: Number.NaN })?.kind).toBe(
      "low",
    );
    expect(walletBalanceNotice({ ...base, balance: 200, threshold: undefined })).toBeNull();
  });
});

describe("walletNoticeInputFromPortal", () => {
  it("reads balance, exemption, SMS price, threshold and canBuy from the wallet portal", () => {
    expect(
      walletNoticeInputFromPortal({
        canBuy: true,
        summary: {
          balance: "150.5",
          exempt: false,
          low_balance_threshold: "300",
          prices: { sms: { unit_price: 0.08 } },
        },
      }),
    ).toEqual({ balance: 150.5, exempt: false, smsUnitPrice: 0.08, threshold: 300, canBuy: true });
  });

  it("tolerates a missing portal or summary fields", () => {
    expect(walletNoticeInputFromPortal(undefined)).toEqual({
      balance: 0,
      exempt: false,
      smsUnitPrice: null,
      threshold: null,
      canBuy: false,
    });
  });
});

describe("parseThresholdInput", () => {
  it("reads pt-BR amounts", () => {
    expect(parseThresholdInput("200")).toBe(200);
    expect(parseThresholdInput("199,99")).toBe(199.99);
    expect(parseThresholdInput("R$ 1.000,50")).toBe(1000.5);
    expect(parseThresholdInput(" 0 ")).toBe(0);
    expect(parseThresholdInput("100000")).toBe(100000);
  });

  it("refuses empty, negative, out of range, more than 2 decimals and garbage", () => {
    expect(parseThresholdInput("")).toBeNull();
    expect(parseThresholdInput("-1")).toBeNull();
    expect(parseThresholdInput("100000,01")).toBeNull();
    expect(parseThresholdInput("10,555")).toBeNull();
    expect(parseThresholdInput("abc")).toBeNull();
  });
});
