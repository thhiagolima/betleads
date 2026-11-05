import { describe, expect, it } from "vitest";

import {
  BUCKET_LABELS,
  summarizeBillingStates,
  type BillingStateInput,
} from "./billing-state-summary";

function row(overrides: Partial<BillingStateInput> = {}): BillingStateInput {
  return {
    tenantId: "t1",
    name: "Casa 1",
    accessState: "ok",
    openInvoice: null,
    firstPaidAt: null,
    paidInMonth: false,
    ...overrides,
  };
}

describe("summarizeBillingStates", () => {
  it("maps each access_state to its bucket", () => {
    const rows: BillingStateInput[] = [
      row({ tenantId: "a", accessState: "ok" }),
      row({ tenantId: "b", accessState: "due_soon" }),
      row({ tenantId: "c", accessState: "overdue" }),
      row({ tenantId: "d", accessState: "locked_unpaid" }),
      row({ tenantId: "e", accessState: "locked_manual" }),
      row({ tenantId: "f", accessState: "awaiting_first_payment" }),
      row({ tenantId: "g", accessState: "exempt" }),
      row({ tenantId: "h", accessState: "frozen" }),
      row({ tenantId: "i", accessState: "something_unknown" }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    const byId = new Map(result.rows.map((r) => [r.tenantId, r.bucket]));
    expect(byId.get("a")).toBe("ok");
    expect(byId.get("b")).toBe("due_soon");
    expect(byId.get("c")).toBe("overdue");
    expect(byId.get("d")).toBe("locked");
    expect(byId.get("e")).toBe("locked");
    expect(byId.get("f")).toBe("awaiting_first_payment");
    expect(byId.get("g")).toBe("exempt");
    expect(byId.get("h")).toBe("frozen");
    expect(byId.get("i")).toBe("ok");
  });

  it("exposes BUCKET_LABELS in pt-BR for every bucket", () => {
    expect(BUCKET_LABELS).toEqual({
      ok: "Em dia",
      due_soon: "Vence em 5 dias",
      overdue: "Vencida",
      locked: "Bloqueada",
      awaiting_first_payment: "Aguardando 1º pagamento",
      exempt: "Isenta",
      frozen: "Congelada",
    });
  });

  it("computes daysOverdue from the open invoice's due date to today, and lists the house as a debtor", () => {
    const rows: BillingStateInput[] = [
      row({
        tenantId: "a",
        accessState: "overdue",
        openInvoice: { amountCents: 400000, dueDate: "2026-10-26" },
      }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.rows[0].daysOverdue).toBe(10);
    expect(result.debtors).toEqual([
      { tenantId: "a", name: "Casa 1", amountCents: 400000, daysOverdue: 10, bucket: "overdue" },
    ]);
  });

  it("daysOverdue is null when the due date is today or in the future, or there is no open invoice", () => {
    const rows: BillingStateInput[] = [
      row({
        tenantId: "a",
        accessState: "overdue",
        openInvoice: { amountCents: 100, dueDate: "2026-11-05" },
      }),
      row({
        tenantId: "b",
        accessState: "overdue",
        openInvoice: { amountCents: 100, dueDate: "2026-11-06" },
      }),
      row({ tenantId: "c", accessState: "ok", openInvoice: null }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.rows[0].daysOverdue).toBeNull();
    expect(result.rows[1].daysOverdue).toBeNull();
    expect(result.rows[2].daysOverdue).toBeNull();
  });

  it("orders debtors by amount desc, then daysOverdue desc", () => {
    const rows: BillingStateInput[] = [
      row({
        tenantId: "small-old",
        name: "Casa Pequena Antiga",
        accessState: "overdue",
        openInvoice: { amountCents: 10000, dueDate: "2026-10-01" },
      }),
      row({
        tenantId: "big-new",
        name: "Casa Grande Nova",
        accessState: "locked_unpaid",
        openInvoice: { amountCents: 50000, dueDate: "2026-11-01" },
      }),
      row({
        tenantId: "big-old",
        name: "Casa Grande Antiga",
        accessState: "awaiting_first_payment",
        openInvoice: { amountCents: 50000, dueDate: "2026-10-01" },
      }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.debtors.map((d) => d.tenantId)).toEqual(["big-old", "big-new", "small-old"]);
  });

  it("owedCents sums only open invoices in overdue/locked/awaiting_first_payment, excluding due_soon and ok", () => {
    const rows: BillingStateInput[] = [
      row({
        tenantId: "ok1",
        accessState: "ok",
        openInvoice: { amountCents: 999999, dueDate: "2026-10-01" },
      }),
      row({
        tenantId: "due1",
        accessState: "due_soon",
        openInvoice: { amountCents: 888888, dueDate: "2026-11-10" },
      }),
      row({
        tenantId: "over1",
        accessState: "overdue",
        openInvoice: { amountCents: 10000, dueDate: "2026-10-20" },
      }),
      row({
        tenantId: "lock1",
        accessState: "locked_manual",
        openInvoice: { amountCents: 20000, dueDate: "2026-10-01" },
      }),
      row({
        tenantId: "await1",
        accessState: "awaiting_first_payment",
        openInvoice: { amountCents: 30000, dueDate: "2026-10-01" },
      }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.owedCents).toBe(60000);
  });

  it("counts newPaying tenants whose firstPaidAt falls inside the selected month (Brasília day)", () => {
    const rows: BillingStateInput[] = [
      row({
        tenantId: "a",
        name: "Pagou em Nov",
        accessState: "ok",
        firstPaidAt: "2026-11-03T02:30:00.000Z",
      }),
      row({
        tenantId: "b",
        name: "Pagou em Out",
        accessState: "ok",
        firstPaidAt: "2026-10-31T23:00:00.000Z",
      }),
      row({
        tenantId: "c",
        name: "Nunca pagou",
        accessState: "awaiting_first_payment",
        firstPaidAt: null,
      }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.movements.newPaying).toEqual(["Pagou em Nov"]);
  });

  it("firstPaidAt right after midnight UTC still counts as the previous Brasília day", () => {
    // 2026-11-01T02:30:00Z is 2026-10-31 23:30 BRT -> October, not November.
    const rows: BillingStateInput[] = [
      row({
        tenantId: "a",
        name: "Virada",
        accessState: "ok",
        firstPaidAt: "2026-11-01T02:30:00.000Z",
      }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.movements.newPaying).toEqual([]);
    const october = summarizeBillingStates(rows, "2026-11-05", "2026-10");
    expect(october.movements.newPaying).toEqual(["Virada"]);
  });

  it("counts lost tenants: bucket locked or frozen and not paid in month", () => {
    const rows: BillingStateInput[] = [
      row({ tenantId: "a", name: "Trancada", accessState: "locked_unpaid", paidInMonth: false }),
      row({
        tenantId: "b",
        name: "Trancada mas pagou",
        accessState: "locked_manual",
        paidInMonth: true,
      }),
      row({ tenantId: "c", name: "Congelada", accessState: "frozen", paidInMonth: false }),
      row({ tenantId: "d", name: "Em dia", accessState: "ok", paidInMonth: false }),
    ];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.movements.lost.sort()).toEqual(["Congelada", "Trancada"]);
  });

  it("counts include every bucket, even at zero", () => {
    const rows: BillingStateInput[] = [row({ tenantId: "a", accessState: "ok" })];
    const result = summarizeBillingStates(rows, "2026-11-05", "2026-11");
    expect(result.counts).toEqual({
      ok: 1,
      due_soon: 0,
      overdue: 0,
      locked: 0,
      awaiting_first_payment: 0,
      exempt: 0,
      frozen: 0,
    });
  });
});
