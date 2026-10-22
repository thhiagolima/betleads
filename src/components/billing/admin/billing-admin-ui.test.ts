import { describe, expect, it } from "vitest";

import {
  adminBillingDashboardCards,
  adminTenantSituationLabel,
  canSubmitReason,
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
