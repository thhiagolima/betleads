import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/tenant-access.server", () => ({
  listDemoTenantIds: vi.fn(async () => [] as string[]),
}));

// Lets one test force a specific selectAllPages label to report `truncated: true` (fix round
// 1, item 2) without actually materializing 100,000+ rows; every other label passes straight
// through to the real implementation, so the >1000-row paging test below still exercises the
// real keyset paging.
const paginationMock = vi.hoisted(() => ({ truncateLabel: null as string | null }));
vi.mock("@/lib/pagination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pagination")>();
  return {
    ...actual,
    selectAllPages: (
      label: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches selectAllPages' own loose `build` type.
      build: () => any,
      keyColumn?: string,
    ) => {
      if (label === paginationMock.truncateLabel) {
        return Promise.resolve({ data: [], error: null, truncated: true });
      }
      return actual.selectAllPages(label, build, keyColumn);
    },
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import { adminGeneralFinanceFor } from "./general-finance.server";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";
const DEMO_TENANT = "00000000-0000-4000-8000-0000000000cc";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000dd";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000ee";

function ctxFor(userId: string) {
  return { userId };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin
    .rows("billing_plans")
    .push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
  paginationMock.truncateLabel = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adminGeneralFinanceFor", () => {
  it("refuses a non-super-admin before any other read", async () => {
    const fromSpy = vi.spyOn(fake.admin.client, "from");
    await expect(adminGeneralFinanceFor(ctxFor(PLAIN_USER), { month: "2026-11" })).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid month with the pt-BR message, before the super admin check", async () => {
    await expect(adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-13" })).rejects.toThrow(
      "Mês inválido (use AAAA-MM).",
    );
    await expect(adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "nov" })).rejects.toThrow(
      "Mês inválido (use AAAA-MM).",
    );
  });

  it("excludes demo tenants", async () => {
    const { listDemoTenantIds } = await import("@/lib/tenant-access.server");
    (listDemoTenantIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([DEMO_TENANT]);
    fake.admin
      .rows("tenants")
      .push(
        { id: TENANT, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico" },
        { id: DEMO_TENANT, nome: "Casa Demo", slug: "demo", plano: "crm_unico" },
      );
    fake.admin
      .rows("tenant_billing")
      .push(
        { tenant_id: TENANT, access_state: "ok" },
        { tenant_id: DEMO_TENANT, access_state: "ok" },
      );

    const result = await adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-11" });
    expect(result.houses.map((h) => h.tenantId)).toEqual([TENANT]);
    expect(result.houses.some((h) => h.name === "Casa Demo")).toBe(false);
  });

  it("puts an overdue house first in both houses and states.debtors", async () => {
    fake.admin
      .rows("tenants")
      .push(
        { id: TENANT, nome: "Casa Em Dia", slug: "casa-em-dia", plano: "crm_unico" },
        { id: OTHER_TENANT, nome: "Casa Atrasada", slug: "casa-atrasada", plano: "crm_unico" },
      );
    fake.admin
      .rows("tenant_billing")
      .push(
        { tenant_id: TENANT, access_state: "ok" },
        { tenant_id: OTHER_TENANT, access_state: "overdue" },
      );
    fake.admin.rows("billing_invoices").push({
      id: "inv-1",
      tenant_id: OTHER_TENANT,
      status: "open",
      amount_cents: 400000,
      due_date: "2026-10-01",
    });

    const result = await adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-11" });
    expect(result.states.debtors[0].tenantId).toBe(OTHER_TENANT);
    expect(result.houses[0].tenantId).toBe(OTHER_TENANT);
    expect(result.houses[0].bucket).toBe("overdue");
    expect(result.houses[0].openInvoiceCents).toBe(400000);
    expect(result.houses[0].daysOverdue).toBeGreaterThan(0);
  });

  it("includes month totals and generatedAt", async () => {
    fake.admin
      .rows("tenants")
      .push({ id: TENANT, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico" });
    fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "ok" });
    fake.admin.rows("billing_invoices").push({
      id: "inv-1",
      tenant_id: TENANT,
      status: "paid",
      paid_amount_cents: 400000,
      paid_at: "2026-11-10T12:00:00Z",
    });

    const result = await adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-11" });
    expect(result.month).toBe("2026-11");
    expect(typeof result.generatedAt).toBe("string");
    expect(result.totals.mensalidadeReais).toBe(4000);
    expect(result.houses[0].mensalidadeReais).toBe(4000);
    expect(result.houses[0].bucket).toBe("ok");
  });

  it("sorts the non-debtor houses by margemPct ascending, nulls last", async () => {
    const LOW_MARGIN = "00000000-0000-4000-8000-0000000000f1";
    const HIGH_MARGIN = "00000000-0000-4000-8000-0000000000f2";
    const NO_REVENUE = "00000000-0000-4000-8000-0000000000f3";
    fake.admin
      .rows("tenants")
      .push(
        { id: LOW_MARGIN, nome: "Casa Margem Baixa", slug: "margem-baixa", plano: "crm_unico" },
        { id: HIGH_MARGIN, nome: "Casa Margem Alta", slug: "margem-alta", plano: "crm_unico" },
        { id: NO_REVENUE, nome: "Casa Sem Receita", slug: "sem-receita", plano: "crm_unico" },
      );
    fake.admin
      .rows("tenant_billing")
      .push(
        { tenant_id: LOW_MARGIN, access_state: "ok" },
        { tenant_id: HIGH_MARGIN, access_state: "ok" },
        { tenant_id: NO_REVENUE, access_state: "ok" },
      );
    fake.admin.rows("billing_invoices").push(
      {
        id: "inv-low",
        tenant_id: LOW_MARGIN,
        status: "paid",
        paid_amount_cents: 400000,
        paid_at: "2026-11-10T12:00:00Z",
      },
      {
        id: "inv-high",
        tenant_id: HIGH_MARGIN,
        status: "paid",
        paid_amount_cents: 400000,
        paid_at: "2026-11-10T12:00:00Z",
      },
    );
    fake.admin.rows("payment_charges").push({
      id: "fee-low",
      tenant_id: LOW_MARGIN,
      status: "PAID",
      fee_cents: 300000,
      paid_at: "2026-11-11T12:00:00Z",
    });

    const result = await adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-11" });
    expect(result.houses.map((h) => h.tenantId)).toEqual([LOW_MARGIN, HIGH_MARGIN, NO_REVENUE]);
  });

  // Fix round 1, item 1: the paid-invoices read must select `id` (selectAllPages keysets on
  // it) — with 1001 rows, the house's earliest paid_at only shows up once the second page is
  // actually fetched.
  it("finds the earliest paid_at from the second page of a >1000-row paid-invoices read", async () => {
    fake.admin
      .rows("tenants")
      .push({ id: TENANT, nome: "Casa Grande", slug: "casa-grande", plano: "crm_unico" });
    fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "ok" });
    const invoices = fake.admin.rows("billing_invoices");
    for (let i = 0; i < 1000; i += 1) {
      invoices.push({
        id: `inv-${String(i).padStart(5, "0")}`,
        tenant_id: TENANT,
        status: "paid",
        paid_amount_cents: 100,
        paid_at: "2026-01-15T12:00:00Z",
      });
    }
    // Sorts after the first 1000 rows by id, so selectAllPages only reaches it on page 2 — and
    // it carries the earliest paid_at, proving the second page was actually read.
    invoices.push({
      id: "inv-01000",
      tenant_id: TENANT,
      status: "paid",
      paid_amount_cents: 400000,
      paid_at: "2026-01-01T12:00:00Z",
    });

    const result = await adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-01" });
    expect(result.states.movements.newPaying).toContain("Casa Grande");
  });

  // Fix round 1, item 2 (controller ruling): a truncated paged read must fail loudly instead of
  // silently computing buckets/debtors/firstPaidAt from a partial set.
  it("throws a clear pt-BR error when a paged read is truncated, instead of computing from a partial set", async () => {
    paginationMock.truncateLabel = "general_finance_open_invoices";
    fake.admin
      .rows("tenants")
      .push({ id: TENANT, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico" });
    fake.admin.rows("tenant_billing").push({ tenant_id: TENANT, access_state: "ok" });

    await expect(adminGeneralFinanceFor(ctxFor(SUPER_ADMIN), { month: "2026-11" })).rejects.toThrow(
      "Histórico de faturas grande demais para calcular o Financeiro geral.",
    );
  });
});
