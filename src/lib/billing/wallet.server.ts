// PG1 Task 5 — thin wrapper over wallet_reserve/wallet_refund (Task 3) used
// by every usage-billed send (SMS now; voice/email later). Service_role
// only: callers pass supabaseAdmin (never the browser-scoped client).

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
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
  | { ok: true; idempotent: boolean; exempt: boolean; amount: number }
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
  };
  return {
    ok: true,
    idempotent: result.idempotent === true,
    exempt: result.exempt === true,
    amount: Number(result.amount ?? 0),
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
