// Incident 15/10/2026: Short Brasil 101 (auth) / 505 (no balance) and HTTP
// 401/402/403 refuse the ACCOUNT, not the lead.
import { describe, expect, it } from "vitest";

import {
  CREDIT_DEFER_MS,
  ProviderSendError,
  classifyProviderFailure,
} from "./provider-errors.server";
import {
  isShortBrasilRefusal,
  isUnknownShortBrasilRefusal,
  smsProviderAccountReason,
} from "./transport-errors";

describe("smsProviderAccountReason", () => {
  it("101 and 505 in the body are account errors, even with HTTP 200", () => {
    expect(smsProviderAccountReason(200, { status: 101, statusDetalhe: "Erro de Autenticação" })).toBe("auth");
    expect(smsProviderAccountReason(200, { status: "505", statusDetalhe: "Saldo insuficiente" })).toBe(
      "no_balance",
    );
  });

  it("status 5 'Saldo insuficiente' (incident 27-28/10/2026) is no_balance", () => {
    expect(smsProviderAccountReason(200, { status: 5, statusDetalhe: "Saldo insuficiente" })).toBe("no_balance");
    expect(smsProviderAccountReason(200, { status: "5" })).toBe("no_balance");
  });

  it("HTTP 401/402/403 from the provider are account errors", () => {
    expect(smsProviderAccountReason(401, null)).toBe("auth");
    expect(smsProviderAccountReason(403, { message: "forbidden" })).toBe("auth");
    expect(smsProviderAccountReason(402, [{ status: "rejected" }])).toBe("no_balance");
  });

  it("per-lead errors are not", () => {
    expect(smsProviderAccountReason(200, { status: 303, statusDetalhe: "Erro de requisição" })).toBeNull();
    expect(smsProviderAccountReason(200, { status: 404 })).toBeNull();
    expect(smsProviderAccountReason(400, { message: "numero invalido" })).toBeNull();
    expect(smsProviderAccountReason(422, [{ status: "rejected", reason: "invalid number" }])).toBeNull();
    expect(smsProviderAccountReason(503, null)).toBeNull();
  });
});

describe("isShortBrasilRefusal", () => {
  it("an accepted message has an id and no status", () => {
    expect(isShortBrasilRefusal({ id: "0000237800004695", parceiroId: "k" })).toBe(false);
    expect(isShortBrasilRefusal(null)).toBe(false);
  });

  it("known codes are refusals, with or without an id", () => {
    for (const status of [5, 101, 303, 404, 505]) expect(isShortBrasilRefusal({ status })).toBe(true);
    expect(isShortBrasilRefusal({ status: "5", statusDetalhe: "Saldo insuficiente" })).toBe(true);
  });

  it("an unknown code is a refusal only without an id", () => {
    expect(isShortBrasilRefusal({ status: 7 })).toBe(true);
    expect(isUnknownShortBrasilRefusal({ status: 7 })).toBe(true);
    expect(isShortBrasilRefusal({ status: 7, id: "msg-1" })).toBe(false);
    expect(isUnknownShortBrasilRefusal({ status: 5 })).toBe(false);
  });
});

describe("classifyProviderFailure — provider_account", () => {
  const accountError = (status: number) =>
    new ProviderSendError({
      channel: "sms",
      message: "Short Brasil: erro de autenticacao",
      status,
      body: JSON.stringify({ status: 101 }),
      temporary: true,
      errorKind: "provider_account",
    });

  it("101/505 marked by the adapter never fail and never cost an attempt", () => {
    const decision = classifyProviderFailure(accountError(200));
    expect(decision).toMatchObject({ kind: "provider_account", reason: "provider_account" });
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("the provider's OWN 402 (no errorKind) keeps its original provider-level classification: insufficient_credit", () => {
    const providerCredit = new ProviderSendError({
      channel: "sms",
      message: "Saldo insuficiente",
      status: 402,
    });
    expect(classifyProviderFailure(providerCredit)).toMatchObject({
      kind: "defer",
      reason: "insufficient_credit",
      retryAfterMs: CREDIT_DEFER_MS,
    });
  });

  it("errorKind insufficient_balance (set by the wallet reservation, the HOUSE's own wallet) is a skip (journey advances, no retry, no attempt), never a provider-level defer (PG3 Task 7)", () => {
    const walletRefusal = new ProviderSendError({
      channel: "sms",
      message: "Saldo insuficiente",
      status: 402,
      errorKind: "insufficient_balance",
    });
    expect(classifyProviderFailure(walletRefusal)).toEqual({
      kind: "skip",
      reason: "insufficient_balance",
      retryAfterMs: 0,
    });
  });

  it("real per-lead errors are still permanent", () => {
    const invalid = new ProviderSendError({ channel: "sms", message: "numero invalido", status: 400 });
    expect(classifyProviderFailure(invalid)).toMatchObject({ kind: "fail", reason: "permanent_error" });
    const missingCredentials = new ProviderSendError({
      channel: "sms",
      message: "credenciais ausentes",
      status: 0,
      errorKind: "misconfigured",
    });
    expect(classifyProviderFailure(missingCredentials)).toMatchObject({
      kind: "fail",
      reason: "provider_misconfigured",
    });
  });
});
