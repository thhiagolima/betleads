// Conta própria de provedor (Task 6): the wallet wrapper forwards the account
// that will send to the reservation RPC; SQL decides ownership.
import { describe, expect, it, vi } from "vitest";
import { reserveForDelivery, reserveUsage } from "./wallet.server";

function clientReturning(data: Record<string, unknown>) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data, error: null }));
  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      }),
    }),
  };
  return { client, rpc };
}

const base = {
  tenantId: "t1",
  item: "sms" as const,
  units: 1,
  referenceType: "sms_send",
  referenceId: "ref-1",
  idempotencyKey: "sms-reserve:ref-1",
};

describe("reserveUsage — provider account", () => {
  it("reserveUsage repassa _provider_account_id", async () => {
    const { client, rpc } = clientReturning({
      ok: true,
      amount: 0,
      balance: 10,
      own_account: true,
    });
    const result = await reserveUsage(client, { ...base, providerAccountId: "acc" });
    expect(rpc).toHaveBeenCalledWith(
      "wallet_reserve",
      expect.objectContaining({ _provider_account_id: "acc" }),
    );
    expect(result).toMatchObject({ ok: true, ownAccount: true, amount: 0 });
  });

  it("expert reservation also forwards _provider_account_id", async () => {
    const { client, rpc } = clientReturning({
      ok: true,
      amount: 0,
      balance: 10,
      own_account: true,
    });
    await reserveUsage(client, { ...base, expertId: "e1", providerAccountId: "acc" });
    expect(rpc).toHaveBeenCalledWith(
      "expert_wallet_reserve",
      expect.objectContaining({ _expert: "e1", _provider_account_id: "acc" }),
    );
  });

  it("without an account the RPC args stay as before and ownAccount is false", async () => {
    const { client, rpc } = clientReturning({ ok: true, amount: -0.12, balance: 10 });
    const result = await reserveUsage(client, base);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("_provider_account_id");
    expect(result).toMatchObject({ ok: true, ownAccount: false });
  });

  it("reserveForDelivery forwards the account to every generation's reservation", async () => {
    const { client, rpc } = clientReturning({
      ok: true,
      idempotent: false,
      amount: 0,
      balance: 10,
    });
    await reserveForDelivery(client, {
      tenantId: "t1",
      item: "voice_30s",
      prefix: "voice",
      deliveryKey: "k1",
      units: 2,
      referenceType: "voice_call",
      providerAccountId: "acc",
    });
    await reserveForDelivery(client, {
      tenantId: "t1",
      item: "email",
      prefix: "email",
      deliveryKey: null,
      units: 1,
      referenceType: "email_send",
      providerAccountId: "acc",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const [, args] of rpc.mock.calls)
      expect(args).toMatchObject({ _provider_account_id: "acc" });
  });
});
