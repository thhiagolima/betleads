import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  process.env.UPPER_API_KEY = "secret-upper-key";
  process.env.UPPER_API_BASE = "https://api.uppersc.com.br/v1";
}

function okResponse(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ statusCode: status, message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const chargeBody = (overrides: Record<string, unknown> = {}) => ({
  id: "charge-1",
  externalId: "bl-top-abc",
  status: "ACTIVE",
  amountCents: "15000",
  pix: { emv: "00020101...", qrCodeImage: "https://img.example/qr.png" },
  paymentUrl: "https://pay.example/abc",
  expiresAt: "2026-10-22T12:00:00Z",
  paidAt: null,
  paidAmountCents: null,
  payer: null,
  ...overrides,
});

const createInput = {
  amountCents: 15000,
  description: "Casa Betleads - Créditos BetLeads R$ 150,00",
  externalId: "bl-top-abc",
  expiresIn: 3600,
  metadata: { tenantId: "t1", kind: "credit_topup", refId: "r1" },
};

describe("upper-pix.server", () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    setConfigured();
    const mod = await import("./upper-pix.server");
    mod.__resetUpperRateLimiterForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it("201 returns an UpperCharge with amountCents as a number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(chargeBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { createUpperCharge } = await import("./upper-pix.server");

    const charge = await createUpperCharge(createInput);

    expect(charge.amountCents).toBe(15000);
    expect(typeof charge.amountCents).toBe("number");
    expect(charge.status).toBe("ACTIVE");
    expect(charge.id).toBe("charge-1");
    expect(charge.emv).toBe("00020101...");
    expect(charge.qrCodeImage).toBe("https://img.example/qr.png");
  });

  it("treats a response with idempotent: true the same way", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(chargeBody({ idempotent: true }), 200));
    vi.stubGlobal("fetch", fetchMock);
    const { createUpperCharge } = await import("./upper-pix.server");

    const charge = await createUpperCharge(createInput);

    expect(charge.amountCents).toBe(15000);
    expect(charge.id).toBe("charge-1");
  });

  it("401 INVALID_API_KEY throws a non-retryable UpperError", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => errorResponse(401, "INVALID_API_KEY", "Chave de API inválida"));
    vi.stubGlobal("fetch", fetchMock);
    const { createUpperCharge, UpperError } = await import("./upper-pix.server");

    await expect(createUpperCharge(createInput)).rejects.toMatchObject({
      status: 401,
      code: "INVALID_API_KEY",
      retryable: false,
    });
    await expect(createUpperCharge(createInput)).rejects.toBeInstanceOf(UpperError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one call per rejected assertion, no retry
  });

  it("403 FEATURE_DISABLED is not retryable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(403, "FEATURE_DISABLED", "Recurso desabilitado"));
    vi.stubGlobal("fetch", fetchMock);
    const { createUpperCharge } = await import("./upper-pix.server");

    await expect(createUpperCharge(createInput)).rejects.toMatchObject({
      status: 403,
      code: "FEATURE_DISABLED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("502 on create retries once with the same body and returns the 2nd response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(502, "UPSTREAM_ERROR", "Erro temporário"))
      .mockResolvedValueOnce(okResponse(chargeBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { createUpperCharge } = await import("./upper-pix.server");

    const charge = await createUpperCharge(createInput);

    expect(charge.id).toBe("charge-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.externalId).toBe(createInput.externalId);
    expect(secondBody.externalId).toBe(createInput.externalId);
  });

  it("a timeout is retryable", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    vi.useFakeTimers();
    const promise = getUpperCharge("bl-top-abc");
    const assertion = expect(promise).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("sends the Authorization: Bearer <key> header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(chargeBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    await getUpperCharge("bl-top-abc");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-upper-key");
  });

  it("never includes the API key in an error message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(400, "VALIDATION", "Dados inválidos"));
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    try {
      await getUpperCharge("bl-top-abc");
      throw new Error("expected to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret-upper-key");
    }
  });

  it("throws UpperError NOT_CONFIGURED when UPPER_API_KEY is missing", async () => {
    delete process.env.UPPER_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    await expect(getUpperCharge("bl-top-abc")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["https://api.uppersc.com.br", "https://api.uppersc.com.br/v1/pix/charges/bl-top-abc"],
    ["https://api.uppersc.com.br/", "https://api.uppersc.com.br/v1/pix/charges/bl-top-abc"],
    ["https://api.uppersc.com.br/v1", "https://api.uppersc.com.br/v1/pix/charges/bl-top-abc"],
    ["https://api.uppersc.com.br/v1/", "https://api.uppersc.com.br/v1/pix/charges/bl-top-abc"],
  ])("normalizes UPPER_API_BASE=%s to exactly one /v1 segment", async (configured, expectedUrl) => {
    process.env.UPPER_API_BASE = configured;
    const fetchMock = vi.fn().mockResolvedValue(okResponse(chargeBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    await getUpperCharge("bl-top-abc");

    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.anything());
  });

  it("throws UpperError INVALID_RESPONSE when amountCents doesn't parse to a finite number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(chargeBody({ amountCents: "not-a-number" })));
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    await expect(getUpperCharge("bl-top-abc")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("accepts a null paidAmountCents but throws on an unparsable non-null one", async () => {
    const fetchMockOk = vi
      .fn()
      .mockResolvedValue(okResponse(chargeBody({ paidAmountCents: null })));
    vi.stubGlobal("fetch", fetchMockOk);
    const { getUpperCharge } = await import("./upper-pix.server");
    const ok = await getUpperCharge("bl-top-abc");
    expect(ok.paidAmountCents).toBeNull();

    const fetchMockBad = vi
      .fn()
      .mockResolvedValue(okResponse(chargeBody({ paidAmountCents: "garbage" })));
    vi.stubGlobal("fetch", fetchMockBad);
    await expect(getUpperCharge("bl-top-abc")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("waits (never fails) when over 100 calls in a rolling 60s window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(chargeBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { getUpperCharge } = await import("./upper-pix.server");

    for (let i = 0; i < 100; i++) {
      await getUpperCharge("bl-top-abc");
    }
    expect(fetchMock).toHaveBeenCalledTimes(100);

    const promise = getUpperCharge("bl-top-abc");
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(100);

    await vi.advanceTimersByTimeAsync(60_001);
    await promise;
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(101);
  });
});
