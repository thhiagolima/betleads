// PG3 Task 2 — unit tests for the generic per-delivery reservation lifted
// from SMS's reserveSmsCreditForDelivery (sms.functions.ts, PG1). These
// exercise reserveForDelivery/refundForDelivery directly against an
// in-memory wallet_ledger stand-in, independent of SMS.

import { describe, expect, it } from "vitest";
import { reserveForDelivery, refundForDelivery } from "./wallet.server";

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for wallet_reserve/wallet_refund + wallet_ledger. */
function makeClient() {
  const ledger: Row[] = [];
  const UNIT_PRICE = 0.1;
  const BALANCE_START = 1000;

  function balance() {
    return (
      BALANCE_START +
      ledger.reduce((sum, row) => sum + Number(row.amount), 0)
    );
  }

  async function rpc(fn: string, args: Row) {
    if (fn === "wallet_reserve") {
      const existing = ledger.find(
        (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
      );
      if (existing) {
        return {
          data: { ok: true, idempotent: true, amount: existing.amount, balance: balance(), exempt: false },
          error: null,
        };
      }
      const units = Number(args._units ?? 1);
      if (units <= 0) return { data: null, error: { message: "invalid_units" } };
      const amount = -(units * UNIT_PRICE);
      if (balance() + amount < 0) return { data: null, error: { message: "insufficient_balance" } };
      ledger.push({
        tenant_id: args._tenant,
        idempotency_key: args._idempotency_key,
        reference_id: args._reference_id,
        units,
        amount,
        entry_type: "usage_reservation",
      });
      return {
        data: { ok: true, idempotent: false, amount, balance: balance(), exempt: false },
        error: null,
      };
    }
    if (fn === "wallet_refund") {
      const existing = ledger.find(
        (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
      );
      if (existing) return { data: { ok: true, idempotent: true }, error: null };
      const reservation = ledger.find(
        (row) =>
          row.tenant_id === args._tenant &&
          row.reference_id === args._reference_id &&
          row.entry_type === "usage_reservation",
      );
      if (!reservation) return { data: { ok: false, reason: "reservation_not_found" }, error: null };
      const alreadyRefunded = ledger.some(
        (row) => row.entry_type === "usage_refund" && row.reference_id === args._reference_id,
      );
      if (alreadyRefunded) return { data: { ok: false, reason: "already_refunded" }, error: null };
      ledger.push({
        tenant_id: args._tenant,
        idempotency_key: args._idempotency_key,
        reference_id: args._reference_id,
        entry_type: "usage_refund",
        amount: -Number(reservation.amount),
      });
      return { data: { ok: true, idempotent: false }, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  }

  function from(table: string) {
    if (table !== "wallet_ledger") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: async () => ({
        data: ledger.filter((row) => filters.every((f) => f(row))),
        error: null,
      }),
    };
    return builder;
  }

  return { rpc, from, ledger };
}

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("reserveForDelivery", () => {
  it("generations after a refund: a retry under the same delivery key is charged again under generation 1", async () => {
    const client = makeClient();

    const first = await reserveForDelivery(client, {
      tenantId: TENANT,
      item: "sms",
      prefix: "sms",
      deliveryKey: "KEY-1",
      units: 1,
      referenceType: "sms_send",
    });
    expect(first).toMatchObject({ ok: true, referenceId: "delivery:KEY-1" });

    await refundForDelivery(client, {
      tenantId: TENANT,
      referenceId: "delivery:KEY-1",
      prefix: "sms",
      reason: "provider rejected",
    });

    const retry = await reserveForDelivery(client, {
      tenantId: TENANT,
      item: "sms",
      prefix: "sms",
      deliveryKey: "KEY-1",
      units: 1,
      referenceType: "sms_send",
    });
    expect(retry).toMatchObject({ ok: true, referenceId: "delivery:KEY-1:1" });

    // Reusing the key again (no refund in between) is idempotent, not a third charge.
    const again = await reserveForDelivery(client, {
      tenantId: TENANT,
      item: "sms",
      prefix: "sms",
      deliveryKey: "KEY-1",
      units: 1,
      referenceType: "sms_send",
    });
    expect(again).toMatchObject({ ok: true, referenceId: "delivery:KEY-1:1" });
  });

  it("a non-SMS prefix (voice) uses <prefix>:<key> references and <prefix>-reserve/<prefix>-refund keys", async () => {
    const client = makeClient();

    const reserved = await reserveForDelivery(client, {
      tenantId: TENANT,
      item: "voice_30s",
      prefix: "voice",
      deliveryKey: "CALL-1",
      units: 2,
      referenceType: "voice_call",
    });
    expect(reserved).toMatchObject({ ok: true, referenceId: "voice:CALL-1" });
    expect(client.ledger).toEqual([
      expect.objectContaining({
        idempotency_key: "voice-reserve:voice:CALL-1",
        reference_id: "voice:CALL-1",
        entry_type: "usage_reservation",
      }),
    ]);

    await refundForDelivery(client, {
      tenantId: TENANT,
      referenceId: "voice:CALL-1",
      prefix: "voice",
      reason: "call timed out",
    });
    expect(client.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotency_key: "voice-refund:voice:CALL-1",
          reference_id: "voice:CALL-1",
          entry_type: "usage_refund",
        }),
      ]),
    );
  });

  it("the insufficient-balance result shape: ok:false with referenceId and reason, no amount/balance", async () => {
    const client = makeClient();

    const result = await reserveForDelivery(client, {
      tenantId: TENANT,
      item: "email",
      prefix: "email",
      deliveryKey: "EMAIL-1",
      units: 1_000_000, // far beyond the 1000 BRL stub balance at 0.10/unit
      referenceType: "email_send",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.referenceId).toBe("email:EMAIL-1");
    expect(result.reason).toBe("Saldo insuficiente");
    expect("amount" in result).toBe(false);
    expect(client.ledger).toHaveLength(0);
  });
});
