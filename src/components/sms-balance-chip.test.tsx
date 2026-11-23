import { describe, expect, it } from "vitest";

import type { BalanceStatus } from "@/lib/sms-balance";

import { balanceChip } from "./sms-balance-chip";

const base: BalanceStatus = {
  level: "ok",
  balance: 99993,
  balanceAt: "2026-11-23T23:15:00Z",
  threshold: 20000,
  emptySince: null,
  lastCheckAt: "2026-11-23T23:15:00Z",
  lastError: null,
  unreadable: false,
  lastReadAt: "2026-11-23T23:15:00Z",
};

describe("saldo no header", () => {
  it("mostra o número com milhar e explica de onde vem", () => {
    const chip = balanceChip(base);
    expect(chip.text).toBe("99.993");
    expect(chip.tone).toBe("ok");
    expect(chip.title).toContain("avisa com 20.000 SMS ou menos");
  });

  it("muda de cor abaixo do limite e zerado", () => {
    expect(balanceChip({ ...base, level: "low", balance: 15000 }).tone).toBe("low");
    expect(balanceChip({ ...base, level: "empty", balance: -27 }).text).toBe("-27");
    expect(balanceChip({ ...base, level: "empty", balance: -27 }).tone).toBe("empty");
  });

  it("sem leitura recente não mostra número velho", () => {
    const chip = balanceChip({ ...base, level: "unknown", balance: null, unreadable: true });
    expect(chip.text).toBe("sem leitura");
    expect(chip.tone).toBe("unknown");
  });
});
