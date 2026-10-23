import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
vi.mock("@/lib/observability/job-monitor.server", () => ({ pingHeartbeat: vi.fn() }));
vi.mock("@/lib/observability/sentry.server", () => ({
  isServerSentryActive: () => false,
  captureServerMessage: vi.fn(),
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  adminListReviewChargesFor,
  adminResolveChargeReviewFor,
  REVIEW_OUTCOME_LABELS,
} from "./billing-review.server";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000dd";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000ee";
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const CHARGE = "00000000-0000-4000-8000-0000000000c1";

async function seed() {
  await fake.admin.client.from("tenants").insert({ id: TENANT, nome: "Casa A", slug: "casa-a" });
  await fake.admin.client.from("payment_charges").insert([
    {
      id: CHARGE,
      tenant_id: TENANT,
      kind: "credit_topup",
      external_id: "bl-top-1",
      status: "PAID",
      amount_cents: 10000,
      paid_amount_cents: 9000,
      paid_at: "2026-10-23T10:00:00Z",
      needs_review: true,
      credited_at: null,
      review_resolved_at: null,
      fee_cents: 99,
      last_provider_payload: { secret: "x" },
    },
    {
      id: "resolved",
      tenant_id: TENANT,
      kind: "credit_topup",
      external_id: "bl-top-2",
      status: "PAID",
      amount_cents: 10000,
      paid_amount_cents: 9000,
      needs_review: true,
      credited_at: null,
      review_resolved_at: "2026-10-23T11:00:00Z",
    },
    {
      id: "fine",
      tenant_id: TENANT,
      kind: "credit_topup",
      external_id: "bl-top-3",
      status: "PAID",
      amount_cents: 10000,
      paid_amount_cents: 10000,
      needs_review: false,
      credited_at: "2026-10-23T11:00:00Z",
      review_resolved_at: null,
    },
  ]);
}

beforeEach(async () => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  await seed();
});

describe("adminListReviewChargesFor", () => {
  it("requires the super admin", async () => {
    await expect(adminListReviewChargesFor({ userId: PLAIN_USER })).rejects.toThrow(/super admin/);
  });

  it("lists only open reviews, with the house name and no supplier cost or payload", async () => {
    const items = await adminListReviewChargesFor({ userId: SUPER_ADMIN });
    expect(items).toEqual([
      {
        id: CHARGE,
        tenantId: TENANT,
        tenantName: "Casa A",
        kind: "credit_topup",
        externalId: "bl-top-1",
        status: "PAID",
        amountCents: 10000,
        paidAmountCents: 9000,
        paidAt: "2026-10-23T10:00:00Z",
      },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/fee_cents|feeCents|secret/);
  });
});

describe("adminResolveChargeReviewFor", () => {
  it("requires the super admin and never calls the RPC otherwise", async () => {
    const rpc = vi.fn(() => ({ data: { ok: true }, error: null }));
    fake.admin.onRpc("billing_resolve_charge_review", rpc);
    await expect(
      adminResolveChargeReviewFor(
        { userId: PLAIN_USER },
        { chargeId: CHARGE, outcome: "devolvido", reason: "Devolvido ao cliente" },
      ),
    ).rejects.toThrow(/super admin/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validates outcome and a reason of 5+ characters", async () => {
    await expect(
      adminResolveChargeReviewFor(
        { userId: SUPER_ADMIN },
        { chargeId: CHARGE, outcome: "outro", reason: "Devolvido ao cliente" },
      ),
    ).rejects.toThrow();
    await expect(
      adminResolveChargeReviewFor(
        { userId: SUPER_ADMIN },
        { chargeId: CHARGE, outcome: "devolvido", reason: "   ab " },
      ),
    ).rejects.toThrow(/motivo/i);
  });

  it("calls the RPC with the actor and the trimmed reason", async () => {
    let args: Record<string, unknown> | null = null;
    fake.admin.onRpc("billing_resolve_charge_review", (a) => {
      args = a;
      return { data: { ok: true, charge_id: CHARGE, outcome: "creditado_manual" }, error: null };
    });
    const result = await adminResolveChargeReviewFor(
      { userId: SUPER_ADMIN },
      { chargeId: CHARGE, outcome: "creditado_manual", reason: "  Ajustar saldo feito  " },
    );
    expect(result).toEqual({ ok: true });
    expect(args).toEqual({
      _charge_id: CHARGE,
      _outcome: "creditado_manual",
      _reason: "Ajustar saldo feito",
      _actor: SUPER_ADMIN,
    });
  });

  it("translates SQL error codes to pt-BR", async () => {
    fake.admin.onRpc("billing_resolve_charge_review", () => ({
      data: null,
      error: { message: "review_already_resolved" },
    }));
    await expect(
      adminResolveChargeReviewFor(
        { userId: SUPER_ADMIN },
        { chargeId: CHARGE, outcome: "devolvido", reason: "Devolvido ao cliente" },
      ),
    ).rejects.toThrow("Esta revisão já foi resolvida.");
  });

  it("labels both outcomes in pt-BR", () => {
    expect(REVIEW_OUTCOME_LABELS).toEqual({
      creditado_manual: expect.stringMatching(/Ajustar saldo|baixa manual/),
      devolvido: expect.stringMatching(/[Dd]evolvido/),
    });
  });
});
