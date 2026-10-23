// PG6-03 fix wave: superadmin "Resolver revisão" for Pix charges flagged
// needs_review (amount mismatch, invoice already closed or missing).
//
// Resolving only records what the super admin did outside the automatic
// flow: 'creditado_manual' (money already credited via Ajustar saldo or a
// manual settle) or 'devolvido' (refunded outside the system). It never sets
// credited_at, never credits and never deletes. The SQL function
// billing_resolve_charge_review (service_role, migration 20261024100500)
// writes the resolution and a tenant_audit_logs row in one transaction; the
// super admin is checked here first (is_super_admin(_user_id)), and the actor
// is passed explicitly.
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbUuid } from "@/lib/zod-helpers";

import { assertSuperAdmin } from "./billing-health.server";
import { REVIEW_OUTCOME_LABELS, REVIEW_OUTCOMES, REVIEW_REASON_MIN_LENGTH } from "./charge-review";

export { REVIEW_OUTCOME_LABELS };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = any;

export type ReviewChargeItem = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  kind: string;
  externalId: string;
  status: string;
  amountCents: number;
  paidAmountCents: number | null;
  paidAt: string | null;
};

const LIST_LIMIT = 50;

export async function adminListReviewChargesFor(ctx: {
  userId: string;
}): Promise<ReviewChargeItem[]> {
  await assertSuperAdmin(ctx.userId);
  const db = supabaseAdmin as LooseDb;
  // Explicit columns: never fee_cents (supplier cost) nor the raw provider payload.
  const { data, error } = await db
    .from("payment_charges")
    .select(
      "id, tenant_id, kind, external_id, status, amount_cents, paid_amount_cents, paid_at, created_at",
    )
    .eq("needs_review", true)
    .is("credited_at", null)
    .is("review_resolved_at", null)
    .order("created_at", { ascending: true })
    .limit(LIST_LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const tenantIds = [...new Set(rows.map((r) => String(r.tenant_id)))];
  const names = new Map<string, string | null>();
  if (tenantIds.length > 0) {
    const { data: tenants, error: tenantsError } = await db
      .from("tenants")
      .select("id, nome")
      .in("id", tenantIds);
    if (tenantsError) throw new Error(tenantsError.message);
    for (const t of (tenants ?? []) as Array<{ id: string; nome: string | null }>) {
      names.set(t.id, t.nome ?? null);
    }
  }
  return rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    tenantName: names.get(String(r.tenant_id)) ?? null,
    kind: String(r.kind),
    externalId: String(r.external_id),
    status: String(r.status),
    amountCents: Number(r.amount_cents),
    paidAmountCents: r.paid_amount_cents == null ? null : Number(r.paid_amount_cents),
    paidAt: (r.paid_at as string | null) ?? null,
  }));
}

export const resolveChargeReviewInput = z.object({
  chargeId: dbUuid(),
  outcome: z.enum(REVIEW_OUTCOMES),
  reason: z
    .string()
    .trim()
    .min(REVIEW_REASON_MIN_LENGTH, "O motivo deve ter ao menos 5 caracteres."),
});

const RESOLVE_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Apenas o super admin pode realizar esta ação.",
  invalid_outcome: "Resultado inválido.",
  reason_required: "O motivo deve ter ao menos 5 caracteres.",
  charge_not_found: "Cobrança não encontrada.",
  charge_not_in_review: "Esta cobrança não está aguardando revisão.",
  review_already_resolved: "Esta revisão já foi resolvida.",
};

export async function adminResolveChargeReviewFor(
  ctx: { userId: string },
  data: unknown,
): Promise<{ ok: true }> {
  const input = resolveChargeReviewInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const { error } = await (supabaseAdmin as LooseDb).rpc("billing_resolve_charge_review", {
    _charge_id: input.chargeId,
    _outcome: input.outcome,
    _reason: input.reason,
    _actor: ctx.userId,
  });
  if (error) {
    const code = String(error.message ?? "").trim();
    throw new Error(RESOLVE_ERROR_MESSAGES[code] ?? "Não foi possível resolver a revisão agora.");
  }
  return { ok: true };
}
