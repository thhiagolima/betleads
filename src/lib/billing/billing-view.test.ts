import { describe, expect, it } from "vitest";

import {
  billingView,
  invoicePaidSuccessText,
  isEffectiveLock,
  planStatusBadge,
} from "./billing-view";

const invoice4000 = { amountCents: 400000, dueDate: "2026-11-05" };

describe("planStatusBadge", () => {
  it('ok: "Em dia até" the day before next_due_date', () => {
    expect(
      planStatusBadge({
        state: "ok",
        today: "2026-11-01",
        invoice: null,
        nextDueDate: "2026-12-05",
        enforcement: true,
      }),
    ).toBe("Em dia até 04/12");
  });

  it('due_soon: "Vence em DD/MM · daqui a N dias"', () => {
    expect(
      planStatusBadge({
        state: "due_soon",
        today: "2026-11-02",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Vence em 05/11 · daqui a 3 dias");
  });

  it('overdue: "Vencida em DD/MM"', () => {
    expect(
      planStatusBadge({
        state: "overdue",
        today: "2026-11-06",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Vencida em 05/11");
  });

  it.each(["locked_unpaid", "locked_manual"])('%s with enforcement on: "Bloqueada"', (state) => {
    expect(
      planStatusBadge({
        state: state as "locked_unpaid" | "locked_manual",
        today: "2026-11-10",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Bloqueada");
  });

  it('locked_unpaid with enforcement off: "Vencida em DD/MM" (never actually blocks)', () => {
    expect(
      planStatusBadge({
        state: "locked_unpaid",
        today: "2026-11-10",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: false,
      }),
    ).toBe("Vencida em 05/11");
  });

  it('locked_manual with enforcement off still: "Bloqueada" (manual lock always blocks)', () => {
    expect(
      planStatusBadge({
        state: "locked_manual",
        today: "2026-11-10",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: false,
      }),
    ).toBe("Bloqueada");
  });

  it('exempt: "Plano interno — isento"', () => {
    expect(
      planStatusBadge({
        state: "exempt",
        today: "2026-11-10",
        invoice: null,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Plano interno — isento");
  });

  it('frozen: "Plano pausado"', () => {
    expect(
      planStatusBadge({
        state: "frozen",
        today: "2026-11-10",
        invoice: null,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Plano pausado");
  });

  it('awaiting_first_payment: "Aguardando primeiro pagamento"', () => {
    expect(
      planStatusBadge({
        state: "awaiting_first_payment",
        today: "2026-11-10",
        invoice: invoice4000,
        nextDueDate: null,
        enforcement: true,
      }),
    ).toBe("Aguardando primeiro pagamento");
  });
});

describe("invoicePaidSuccessText", () => {
  it('"Mensalidade paga — acesso liberado até" the day before the new next_due_date', () => {
    expect(invoicePaidSuccessText("2026-12-05")).toBe(
      "Mensalidade paga — acesso liberado até 04/12",
    );
  });
});

describe("billingView — due_soon", () => {
  it("shows the yellow banner with the exact pt-BR text and showPay for the payer", () => {
    const result = billingView({
      state: "due_soon",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.banner).toEqual({
      tone: "yellow",
      text: "Sua mensalidade de R$ 4.000,00 vence em 05/11 (daqui a 3 dias). Pague por Pix para manter tudo funcionando.",
      showPay: true,
      memberHint: null,
    });
    expect(result.lock).toBeNull();
    expect(result.canBuyCredits).toBe(true);
  });

  it("uses the singular 'daqui a 1 dia' when N = 1", () => {
    const result = billingView({
      state: "due_soon",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-04",
    });
    expect(result.banner?.text).toBe(
      "Sua mensalidade de R$ 4.000,00 vence em 05/11 (daqui a 1 dia). Pague por Pix para manter tudo funcionando.",
    );
  });

  it("clamps N to 1 — never 0 or negative — when today has reached dueDate", () => {
    const result = billingView({
      state: "due_soon",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-05", // today === dueDate; a correct state machine
      // would not emit due_soon here, but this module must never print
      // "daqui a 0 dias" even so — the invariant is owned elsewhere.
    });
    expect(result.banner?.text).toBe(
      "Sua mensalidade de R$ 4.000,00 vence em 05/11 (daqui a 1 dia). Pague por Pix para manter tudo funcionando.",
    );
  });
});

describe("billingView — overdue", () => {
  it("shows the red banner with the lock deadline when enforcement is on", () => {
    const result = billingView({
      state: "overdue",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-06",
    });
    expect(result.banner).toEqual({
      tone: "red",
      text: "Sua mensalidade venceu em 05/11. Se não for paga até 08/11, o acesso ao CRM será bloqueado.",
      showPay: true,
      memberHint: null,
    });
    expect(result.lock).toBeNull();
  });

  it("shows the plain 'regularizar' red banner when enforcement is off", () => {
    const result = billingView({
      state: "overdue",
      role: "payer",
      enforcement: false,
      invoice: invoice4000,
      today: "2026-11-06",
    });
    expect(result.banner).toEqual({
      tone: "red",
      text: "Sua mensalidade venceu em 05/11. Pague para regularizar.",
      showPay: true,
      memberHint: null,
    });
    expect(result.lock).toBeNull();
  });
});

describe("billingView — locked_unpaid", () => {
  it("locks the house and hides the banner when enforcement is on", () => {
    const result = billingView({
      state: "locked_unpaid",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-10",
    });
    expect(result.banner).toBeNull();
    expect(result.lock).toEqual({
      title: "Acesso suspenso por falta de pagamento",
      text: "A mensalidade de R$ 4.000,00 venceu em 05/11. Pague por Pix e o acesso volta na hora.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(false);
  });

  it("does not lock and shows the regularizar red banner when enforcement is off", () => {
    const result = billingView({
      state: "locked_unpaid",
      role: "payer",
      enforcement: false,
      invoice: invoice4000,
      today: "2026-11-10",
    });
    expect(result.lock).toBeNull();
    expect(result.banner).toEqual({
      tone: "red",
      text: "Sua mensalidade venceu em 05/11. Pague para regularizar.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(true);
  });

  it("never locks the superadmin, who sees the red banner instead", () => {
    const result = billingView({
      state: "locked_unpaid",
      role: "super_admin",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-10",
    });
    expect(result.lock).toBeNull();
    expect(result.banner).not.toBeNull();
    expect(result.banner?.tone).toBe("red");
    expect(result.canBuyCredits).toBe(true);
  });

  it("hides the pay button and sets memberHint for a member", () => {
    const result = billingView({
      state: "locked_unpaid",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-10",
    });
    expect(result.lock?.showPay).toBe(false);
    expect(result.lock?.memberHint).toBe(
      "Peça ao administrador da casa para pagar a mensalidade.",
    );
    expect(result.canBuyCredits).toBe(false);
  });
});

describe("billingView — locked_manual", () => {
  it("locks with the support message and hides the pay button by default", () => {
    const result = billingView({
      state: "locked_manual",
      role: "payer",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.banner).toBeNull();
    expect(result.lock).toEqual({
      title: "Acesso suspenso",
      text: "Fale com o suporte.",
      showPay: false,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(false);
  });

  it("shows the pay button for the payer when there is also an overdue invoice", () => {
    const result = billingView({
      state: "locked_manual",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-05",
    });
    expect(result.lock?.showPay).toBe(true);
  });

  it("keeps the pay button hidden for a member even with an overdue invoice", () => {
    const result = billingView({
      state: "locked_manual",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-05",
    });
    expect(result.lock?.showPay).toBe(false);
    expect(result.lock?.memberHint).toBe(
      "Peça ao administrador da casa para pagar a mensalidade.",
    );
  });

  it("gives a member no pay hint when there is nothing to pay (manual lock, no open invoice)", () => {
    const result = billingView({
      state: "locked_manual",
      role: "member",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.lock?.showPay).toBe(false);
    expect(result.lock?.memberHint).toBeNull();
  });

  it("gives a member no pay hint while the open invoice is not yet due (no pay button either)", () => {
    const result = billingView({
      state: "locked_manual",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.lock?.memberHint).toBeNull();
  });

  it("never locks the superadmin, who sees the exact house copy in a red banner", () => {
    const result = billingView({
      state: "locked_manual",
      role: "super_admin",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.lock).toBeNull();
    expect(result.banner).toEqual({
      tone: "red",
      text: "Acesso suspenso. Fale com o suporte.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(true);
  });
});

describe("billingView — frozen", () => {
  it("locks with the plan-paused support message", () => {
    const result = billingView({
      state: "frozen",
      role: "payer",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.lock).toEqual({
      title: "Plano pausado",
      text: "Fale com o suporte.",
      showPay: false,
      memberHint: null,
    });
    expect(result.banner).toBeNull();
    expect(result.canBuyCredits).toBe(false);
  });

  it("gives a member no pay hint: a paused plan has nothing to pay", () => {
    const result = billingView({
      state: "frozen",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-10",
    });
    expect(result.lock).toEqual({
      title: "Plano pausado",
      text: "Fale com o suporte.",
      showPay: false,
      memberHint: null,
    });
  });

  it("never locks the superadmin, who sees the exact house copy in a red banner", () => {
    const result = billingView({
      state: "frozen",
      role: "super_admin",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.lock).toBeNull();
    expect(result.banner).toEqual({
      tone: "red",
      text: "Plano pausado. Fale com o suporte.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(true);
  });
});

describe("billingView — awaiting_first_payment", () => {
  it("shows the activation lock when enforcement is on", () => {
    const result = billingView({
      state: "awaiting_first_payment",
      role: "payer",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.lock).toEqual({
      title: "Ative sua conta",
      text: "Pague a primeira mensalidade de R$ 4.000,00 por Pix para começar a usar o CRM.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(false);
  });

  it("does not lock when enforcement is off", () => {
    const result = billingView({
      state: "awaiting_first_payment",
      role: "payer",
      enforcement: false,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.lock).toBeNull();
    expect(result.canBuyCredits).toBe(true);
  });

  it("never locks the superadmin, who sees the exact house copy (title + text) in a red banner", () => {
    const result = billingView({
      state: "awaiting_first_payment",
      role: "super_admin",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.lock).toBeNull();
    expect(result.banner).toEqual({
      tone: "red",
      text: "Ative sua conta. Pague a primeira mensalidade de R$ 4.000,00 por Pix para começar a usar o CRM.",
      showPay: true,
      memberHint: null,
    });
    expect(result.canBuyCredits).toBe(true);
  });
});

describe("billingView — member hint across warning states", () => {
  it("hides the pay button and sets memberHint for a member seeing the due_soon banner", () => {
    const result = billingView({
      state: "due_soon",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-02",
    });
    expect(result.banner?.showPay).toBe(false);
    expect(result.banner?.memberHint).toBe(
      "Peça ao administrador da casa para pagar a mensalidade.",
    );
  });

  it("hides the pay button and sets memberHint for a member seeing the overdue banner", () => {
    const result = billingView({
      state: "overdue",
      role: "member",
      enforcement: true,
      invoice: invoice4000,
      today: "2026-11-06",
    });
    expect(result.banner?.showPay).toBe(false);
    expect(result.banner?.memberHint).toBe(
      "Peça ao administrador da casa para pagar a mensalidade.",
    );
  });
});

describe("billingView — exempt and ok", () => {
  it("shows nothing for an exempt house", () => {
    const result = billingView({
      state: "exempt",
      role: "payer",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.banner).toBeNull();
    expect(result.lock).toBeNull();
    expect(result.canBuyCredits).toBe(true);
  });

  it("shows nothing for a house that is ok", () => {
    const result = billingView({
      state: "ok",
      role: "payer",
      enforcement: true,
      invoice: null,
      today: "2026-11-02",
    });
    expect(result.banner).toBeNull();
    expect(result.lock).toBeNull();
    expect(result.canBuyCredits).toBe(true);
  });
});

describe("isEffectiveLock", () => {
  it("always locks for frozen and locked_manual regardless of enforcement", () => {
    expect(isEffectiveLock("frozen", false)).toBe(true);
    expect(isEffectiveLock("frozen", true)).toBe(true);
    expect(isEffectiveLock("locked_manual", false)).toBe(true);
    expect(isEffectiveLock("locked_manual", true)).toBe(true);
  });

  it("locks locked_unpaid and awaiting_first_payment only with enforcement on", () => {
    expect(isEffectiveLock("locked_unpaid", true)).toBe(true);
    expect(isEffectiveLock("locked_unpaid", false)).toBe(false);
    expect(isEffectiveLock("awaiting_first_payment", true)).toBe(true);
    expect(isEffectiveLock("awaiting_first_payment", false)).toBe(false);
  });

  it("never locks for exempt, ok, due_soon or overdue", () => {
    expect(isEffectiveLock("exempt", true)).toBe(false);
    expect(isEffectiveLock("ok", true)).toBe(false);
    expect(isEffectiveLock("due_soon", true)).toBe(false);
    expect(isEffectiveLock("overdue", true)).toBe(false);
  });
});
