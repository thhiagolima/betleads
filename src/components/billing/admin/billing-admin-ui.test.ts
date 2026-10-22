import { describe, expect, it } from "vitest";

import {
  adminBillingDashboardCards,
  adminTenantSituationLabel,
  canSubmitReason,
  validateCalendarDate,
  validateDiscountDateRange,
  validateFixedDiscountAmount,
  validateManualSettleAmount,
  validatePercentDiscount,
  validatePixFeeFixedCents,
  validatePixFeePercent,
} from "./billing-admin-ui";
import type { AdminBillingDashboard } from "@/lib/billing/billing-admin.functions";

// Task 9, brief step 1 — the three required tests:
// "o diálogo não envia com motivo vazio"; "o painel mostra os valores formatados em R$";
// "a lista indica a situação de cada casa".

describe("canSubmitReason", () => {
  it("refuses an empty reason", () => {
    expect(canSubmitReason("")).toBe(false);
  });

  it("refuses a reason under 5 characters, even after trimming", () => {
    expect(canSubmitReason("   ok   ")).toBe(false);
  });

  it("accepts a reason of 5+ trimmed characters", () => {
    expect(canSubmitReason("negociação comercial")).toBe(true);
  });
});

describe("adminBillingDashboardCards", () => {
  it("shows the 8 panel numbers formatted in R$ (money fields) or plain counts", () => {
    const dashboard: AdminBillingDashboard = {
      mrrCents: 360_000_00,
      receivedThisMonthCents: 400_000_00,
      dueNext5DaysCents: 40_000_00,
      overdueInvoices: 3,
      lockedUnpaid: 2,
      lockedManual: 1,
      frozen: 1,
      needsReview: 4,
    };
    const cards = adminBillingDashboardCards(dashboard);
    expect(cards).toHaveLength(8);
    const byKey = Object.fromEntries(cards.map((c) => [c.key, c.value]));
    expect(byKey.mrr).toBe("R$ 360.000,00");
    expect(byKey.receivedThisMonth).toBe("R$ 400.000,00");
    expect(byKey.dueNext5Days).toBe("R$ 40.000,00");
    expect(byKey.overdueInvoices).toBe("3");
    expect(byKey.lockedUnpaid).toBe("2");
    expect(byKey.lockedManual).toBe("1");
    expect(byKey.frozen).toBe("1");
    expect(byKey.needsReview).toBe("4");
  });
});

describe("adminTenantSituationLabel", () => {
  it("indicates the situation of each house per access_state", () => {
    expect(adminTenantSituationLabel("exempt")).toBe("Isenta");
    expect(adminTenantSituationLabel("ok")).toBe("Em dia");
    expect(adminTenantSituationLabel("due_soon")).toBe("A vencer");
    expect(adminTenantSituationLabel("overdue")).toBe("Vencida");
    expect(adminTenantSituationLabel("locked_unpaid")).toBe("Bloqueada (falta de pagamento)");
    expect(adminTenantSituationLabel("locked_manual")).toBe("Bloqueada (manual)");
    expect(adminTenantSituationLabel("frozen")).toBe("Congelada");
    expect(adminTenantSituationLabel("awaiting_first_payment")).toBe("Aguardando primeiro pagamento");
  });

  it("falls back to the raw state for an unknown value", () => {
    expect(adminTenantSituationLabel("something_new")).toBe("something_new");
  });
});

// Fix round 1 (m2-m4): pure client-side validators for each action's own extra fields, with
// pt-BR error messages.

describe("validateManualSettleAmount", () => {
  it("accepts an empty value (falls back to the invoice's own amount)", () => {
    expect(validateManualSettleAmount("").valid).toBe(true);
  });

  it("accepts a finite value greater than zero", () => {
    expect(validateManualSettleAmount("4000").valid).toBe(true);
  });

  it("refuses zero, negative or non-numeric values", () => {
    expect(validateManualSettleAmount("0").valid).toBe(false);
    expect(validateManualSettleAmount("-5").valid).toBe(false);
    expect(validateManualSettleAmount("abc").valid).toBe(false);
  });
});

describe("validatePercentDiscount", () => {
  it("accepts a value strictly between 0 and 100", () => {
    expect(validatePercentDiscount("10").valid).toBe(true);
    expect(validatePercentDiscount("100").valid).toBe(true);
  });

  it("refuses 0, negative, over 100, empty or non-numeric", () => {
    expect(validatePercentDiscount("0").valid).toBe(false);
    expect(validatePercentDiscount("-1").valid).toBe(false);
    expect(validatePercentDiscount("101").valid).toBe(false);
    expect(validatePercentDiscount("").valid).toBe(false);
    expect(validatePercentDiscount("abc").valid).toBe(false);
  });
});

describe("validateFixedDiscountAmount", () => {
  it("accepts a finite value greater than zero", () => {
    expect(validateFixedDiscountAmount("500").valid).toBe(true);
  });

  it("refuses zero, negative, empty or non-numeric", () => {
    expect(validateFixedDiscountAmount("0").valid).toBe(false);
    expect(validateFixedDiscountAmount("-1").valid).toBe(false);
    expect(validateFixedDiscountAmount("").valid).toBe(false);
  });
});

describe("validateDiscountDateRange", () => {
  it("accepts an end date on/after the start date", () => {
    expect(validateDiscountDateRange("2026-01-01", "2026-01-01").valid).toBe(true);
    expect(validateDiscountDateRange("2026-01-01", "2026-02-01").valid).toBe(true);
  });

  it("refuses an end date before the start date", () => {
    expect(validateDiscountDateRange("2026-02-01", "2026-01-01").valid).toBe(false);
  });

  it("is valid when either date is empty (both optional)", () => {
    expect(validateDiscountDateRange("", "").valid).toBe(true);
    expect(validateDiscountDateRange("2026-01-01", "").valid).toBe(true);
    expect(validateDiscountDateRange("", "2026-01-01").valid).toBe(true);
  });
});

describe("validateCalendarDate", () => {
  it("accepts a real calendar date", () => {
    expect(validateCalendarDate("2026-11-05").valid).toBe(true);
    expect(validateCalendarDate("2028-02-29").valid).toBe(true); // leap year
  });

  it("refuses a date that doesn't exist on the calendar", () => {
    expect(validateCalendarDate("2026-02-30").valid).toBe(false);
    expect(validateCalendarDate("2026-13-01").valid).toBe(false);
    expect(validateCalendarDate("2026-02-29").valid).toBe(false); // not a leap year
  });

  it("refuses an empty or malformed value", () => {
    expect(validateCalendarDate("").valid).toBe(false);
    expect(validateCalendarDate("05/11/2026").valid).toBe(false);
  });
});

describe("validatePixFeePercent", () => {
  it("accepts 0 to 10", () => {
    expect(validatePixFeePercent("0").valid).toBe(true);
    expect(validatePixFeePercent("10").valid).toBe(true);
    expect(validatePixFeePercent("1.5").valid).toBe(true);
  });

  it("refuses under 0, over 10, empty or non-numeric", () => {
    expect(validatePixFeePercent("-1").valid).toBe(false);
    expect(validatePixFeePercent("10.01").valid).toBe(false);
    expect(validatePixFeePercent("").valid).toBe(false);
  });
});

describe("validatePixFeeFixedCents", () => {
  it("accepts an integer between 0 and 1000", () => {
    expect(validatePixFeeFixedCents("0").valid).toBe(true);
    expect(validatePixFeeFixedCents("1000").valid).toBe(true);
  });

  it("refuses under 0, over 1000, non-integer, empty or non-numeric", () => {
    expect(validatePixFeeFixedCents("-1").valid).toBe(false);
    expect(validatePixFeeFixedCents("1001").valid).toBe(false);
    expect(validatePixFeeFixedCents("1.5").valid).toBe(false);
    expect(validatePixFeeFixedCents("").valid).toBe(false);
  });
});
