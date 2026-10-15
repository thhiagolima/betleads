// Incident 15/10/2026: Short Brasil 101 (auth) / 505 (no balance) and HTTP
// 401/402/403 refuse the ACCOUNT, not the lead.
import { describe, expect, it } from "vitest";

import {
  ProviderSendError,
  classifyProviderFailure,
} from "./provider-errors.server";
import { smsProviderAccountReason } from "./transport-errors";

describe("smsProviderAccountReason", () => {
  it("101 and 505 in the body are account errors, even with HTTP 200", () => {
    expect(smsProviderAccountReason(200, { status: 101, statusDetalhe: "Erro de Autenticação" })).toBe("auth");
    expect(smsProviderAccountReason(200, { status: "505", statusDetalhe: "Saldo insuficiente" })).toBe(
      "no_balance",
    );
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

  it("the tenant's own credit (402 without provider_account) stays insufficient_credit", () => {
    const tenantCredit = new ProviderSendError({
      channel: "sms",
      message: "Saldo de créditos SMS insuficiente",
      status: 402,
    });
    expect(classifyProviderFailure(tenantCredit)).toMatchObject({
      kind: "defer",
      reason: "insufficient_credit",
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
