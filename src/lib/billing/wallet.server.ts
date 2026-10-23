// PG1 Task 5 — thin wrapper over wallet_reserve/wallet_refund (Task 3) used
// by every usage-billed send (SMS now; voice/email later). Service_role
// only: callers pass supabaseAdmin (never the browser-scoped client).

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        eq: (column: string, value: unknown) => { limit: (n: number) => Promise<DbResult<unknown[]>> };
      };
    };
  };
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

export type ReserveUsageArgs = {
  tenantId: string;
  item: "sms" | "voice_30s" | "email";
  units: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
};

export type ReserveUsageResult =
  | { ok: true; idempotent: boolean; exempt: boolean; amount: number; balance: number }
  | { ok: false; error: "Saldo insuficiente" };

export type RefundUsageArgs = {
  tenantId: string;
  referenceId: string;
  idempotencyKey: string;
  reason: string;
};

/**
 * Reserves `units` of `item` from the tenant's wallet. Only the
 * `insufficient_balance` exception is mapped to a user-facing result; any
 * other error (transient DB failure, `invalid_item`, `invalid_units`,
 * `price_not_found`, `forbidden`, ...) is thrown so it never looks like "no
 * balance". A concurrent duplicate reservation comes back as
 * `idempotent: true` from the RPC itself, never as an error.
 */
export async function reserveUsage(
  client: unknown,
  args: ReserveUsageArgs,
): Promise<ReserveUsageResult> {
  const { data, error } = await looseDb(client).rpc("wallet_reserve", {
    _tenant: args.tenantId,
    _item: args.item,
    _units: args.units,
    _reference_type: args.referenceType,
    _reference_id: args.referenceId,
    _idempotency_key: args.idempotencyKey,
  });
  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("insufficient_balance")) {
      return { ok: false, error: "Saldo insuficiente" };
    }
    throw new Error(message);
  }
  const result = (data ?? {}) as {
    idempotent?: boolean;
    exempt?: boolean;
    amount?: number;
    balance?: number;
  };
  return {
    ok: true,
    idempotent: result.idempotent === true,
    exempt: result.exempt === true,
    amount: Number(result.amount ?? 0),
    balance: Number(result.balance ?? 0),
  };
}

/**
 * Refunds a previous reservation. Never throws: `reservation_not_found` and
 * `already_refunded` (the RPC returns these as `ok: false`, not an
 * exception) are logged at warn level; any other failure (including a
 * thrown error from the RPC call itself) is logged at error level.
 */
export async function refundUsage(client: unknown, args: RefundUsageArgs): Promise<void> {
  try {
    const { data, error } = await looseDb(client).rpc("wallet_refund", {
      _tenant: args.tenantId,
      _reference_id: args.referenceId,
      _idempotency_key: args.idempotencyKey,
      _reason: args.reason,
    });
    if (error) {
      console.error("[wallet] falha ao estornar uso", {
        tenantId: args.tenantId,
        referenceId: args.referenceId,
        error: error.message,
      });
      return;
    }
    const result = (data ?? {}) as { ok?: boolean; reason?: string };
    if (result.ok === false) {
      if (result.reason === "reservation_not_found" || result.reason === "already_refunded") {
        console.warn("[wallet] estorno ignorado", {
          tenantId: args.tenantId,
          referenceId: args.referenceId,
          reason: result.reason,
        });
      } else {
        console.error("[wallet] estorno recusado", {
          tenantId: args.tenantId,
          referenceId: args.referenceId,
          reason: result.reason,
        });
      }
    }
  } catch (err) {
    console.error("[wallet] erro inesperado ao estornar uso", {
      tenantId: args.tenantId,
      referenceId: args.referenceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- PG3 Task 2: generic per-delivery reservation -------------------------
//
// Lifted from SMS's `reserveSmsCreditForDelivery`/`refundSmsCredit`
// (sms.functions.ts:612-690, PG1), which this now replaces: sms.functions.ts
// keeps the same exported names and byte-identical keys, delegating here.
// Voice (Task 4, item "voice_30s", prefix "voice") and e-mail (Task 6, item
// "email", prefix "email") reuse this unchanged.
//
// Key format decision (documented per the task brief): the reserve/refund
// idempotency keys are always `<prefix>-reserve:<ref>` / `<prefix>-refund:<ref>`
// — this already matches SMS's existing `sms-reserve:<ref>` / `sms-refund:<ref>`
// verbatim, since `prefix` is "sms" there. The one place SMS stays a special
// case is the *reference* itself: every other channel's reference is
// `<prefix>:<key>[:gen]`, but SMS's production ledger already has rows keyed
// `delivery:<key>[:gen]` (not `sms:<key>`), so `deliveryReferencePrefix` below
// hardcodes that one exception to keep old rows and new rows reconcilable.

/** Max refunded attempts of one delivery that still get a deterministic billing reference. */
export const DELIVERY_BILLING_MAX_GENERATIONS = 20;

function deliveryReferencePrefix(prefix: string): string {
  return prefix === "sms" ? "delivery" : prefix;
}

/**
 * Billing reference for one logical delivery. Generation 0 is the first charge;
 * a retry only moves to the next generation after the previous charge was
 * refunded, so "provider accepted -> commit failed -> retry" never charges twice
 * and a retry after a refunded rejection is still charged once.
 */
export function deliveryBillingReference(prefix: string, deliveryKey: string, generation: number): string {
  const refPrefix = deliveryReferencePrefix(prefix);
  return generation === 0 ? `${refPrefix}:${deliveryKey}` : `${refPrefix}:${deliveryKey}:${generation}`;
}

async function wasRefunded(client: unknown, tenantId: string, prefix: string, referenceId: string): Promise<boolean> {
  const { data, error } = await looseDb(client)
    .from("wallet_ledger")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", `${prefix}-refund:${referenceId}`)
    .limit(1);
  if (error) throw new Error((error as DbError).message);
  return Array.isArray(data) && data.length > 0;
}

export type ReserveForDeliveryArgs = {
  tenantId: string;
  item: ReserveUsageArgs["item"];
  /** Key-naming namespace: "sms", "voice", "email", ... (see the header comment above). */
  prefix: string;
  /** Null/undefined: every call is a brand-new charge (campaigns, manual sends). */
  deliveryKey: string | null | undefined;
  units: number;
  referenceType: string;
};

export type ReserveForDeliveryResult =
  | { ok: true; referenceId: string; amount: number; balance: number }
  // `referenceId` is included even on failure (not in the brief's literal
  // shape) because existing SMS callers log it alongside the failure; see
  // the task report for this decision.
  | { ok: false; referenceId: string; reason: string; balance?: number };

async function reserveOnce(
  client: unknown,
  args: { tenantId: string; item: ReserveUsageArgs["item"]; prefix: string; referenceId: string; units: number; referenceType: string },
): Promise<ReserveForDeliveryResult & { idempotent?: boolean }> {
  const reservation = await reserveUsage(client, {
    tenantId: args.tenantId,
    item: args.item,
    units: args.units,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    idempotencyKey: `${args.prefix}-reserve:${args.referenceId}`,
  });
  if (!reservation.ok) {
    return { ok: false, referenceId: args.referenceId, reason: reservation.error };
  }
  return {
    ok: true,
    referenceId: args.referenceId,
    amount: reservation.amount,
    balance: reservation.balance,
    idempotent: reservation.idempotent,
  };
}

/**
 * Reserves the credit for one delivery (SMS send, voice call, e-mail) of an
 * item billed per unit. Without a delivery key every call is a new charge
 * (campaigns, manual sends). With one, the reference is derived from it: an
 * existing, non-refunded reservation is reused instead of charging again; a
 * reservation that was refunded moves to the next generation, so a retry
 * after a refund is charged exactly once.
 */
export async function reserveForDelivery(
  client: unknown,
  args: ReserveForDeliveryArgs,
): Promise<ReserveForDeliveryResult> {
  const { tenantId, item, prefix, deliveryKey, units, referenceType } = args;
  if (!deliveryKey) {
    const referenceId = crypto.randomUUID();
    const { idempotent, ...result } = await reserveOnce(client, {
      tenantId,
      item,
      prefix,
      referenceId,
      units,
      referenceType,
    });
    return result;
  }
  for (let generation = 0; generation < DELIVERY_BILLING_MAX_GENERATIONS; generation++) {
    const referenceId = deliveryBillingReference(prefix, deliveryKey, generation);
    const { idempotent, ...result } = await reserveOnce(client, {
      tenantId,
      item,
      prefix,
      referenceId,
      units,
      referenceType,
    });
    if (!result.ok) return result;
    if (!idempotent) return result;
    if (!(await wasRefunded(client, tenantId, prefix, referenceId))) return result;
  }
  console.warn("Delivery exceeded deterministic billing generations", { prefix, deliveryKey });
  return reserveForDelivery(client, { ...args, deliveryKey: null });
}

export type RefundForDeliveryArgs = {
  tenantId: string;
  referenceId: string;
  prefix: string;
  reason: string;
};

/** Refunds a previous `reserveForDelivery` reservation. Never throws (see `refundUsage`). */
export async function refundForDelivery(client: unknown, args: RefundForDeliveryArgs): Promise<void> {
  await refundUsage(client, {
    tenantId: args.tenantId,
    referenceId: args.referenceId,
    idempotencyKey: `${args.prefix}-refund:${args.referenceId}`,
    reason: args.reason,
  });
}
