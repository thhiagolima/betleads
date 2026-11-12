import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordBillingSignal } = vi.hoisted(() => ({
  recordBillingSignal: vi.fn(async () => undefined),
}));
vi.mock("./billing-signals.server", () => ({ recordBillingSignal }));

// Tokens, base, callback secret and payer come from the gateway config loader
// (DB, env fallback); the tests drive it through this mutable config.
type TestSpacePayConfig = {
  gatewayToken: string;
  casinoToken: string | null;
  callbackSecret: string;
  apiBase: string | null;
  payer: { name: string; document: string; email: string; phone: string };
};
const gatewayConfig = vi.hoisted(() => ({ spacepay: null as TestSpacePayConfig | null }));
vi.mock("./payment-gateway-config.server", () => ({
  getSpacePayConfig: async () => ({
    source: gatewayConfig.spacepay ? "database" : "none",
    config: gatewayConfig.spacepay,
  }),
}));

import { PixGatewayError, isPixNotFound } from "./pix-gateway-error";
import { verifySpacePayCallbackToken } from "./spacepay-callback-token";
import { SpacePayError, spacePayCallbackUrl, spacePayGateway } from "./spacepay-pix.server";

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  gatewayConfig.spacepay = {
    apiBase: "https://spacepay.test/",
    gatewayToken: "gw-token",
    casinoToken: null,
    callbackSecret: "cb-secret",
    payer: {
      name: "Betleads Ltda",
      document: "12.345.678/0001-90",
      email: "financeiro@example.com",
      phone: "11999998888",
    },
  };
  process.env.PUBLIC_APP_URL = "https://crm.example.com/";
}

/** Blanks one config field (dotted path for payer fields). */
function blankConfigField(field: string) {
  const config = gatewayConfig.spacepay!;
  if (field.startsWith("payer.")) {
    const key = field.slice("payer.".length) as keyof TestSpacePayConfig["payer"];
    config.payer = { ...config.payer, [key]: "  " };
  } else {
    (config as unknown as Record<string, string>)[field] = "  ";
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message = "erro") {
  return json(
    { statusCode: status, timestamp: "2026-11-12T00:00:00Z", path: "/x", message },
    status,
  );
}

const cashIn = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: "8f6c7c1e-0000-4000-8000-000000000001",
  idempotency_key: "bl-top-abc",
  copy_paste: "00020101021226...",
  qr_code: "https://integration.prod.spacedev.pro/qr/8f6c.png",
  expiration_time: "2026-11-12T12:05:00.000Z",
  status: "created",
  currency: "BRL",
  created_at: "2026-11-12T12:00:00.000Z",
  paid_at: null,
  ...overrides,
});

const tx = (overrides: Record<string, unknown> = {}) => ({
  id: "8f6c7c1e-0000-4000-8000-000000000001",
  idempotencyKey: "bl-top-abc",
  externalId: "psp-1",
  amount: 150.1,
  callbackUrl: "https://crm.example.com/api/public/spacepay/webhook/x",
  gateway: "paganopay",
  status: "created",
  type: "cash_in",
  paidAt: null,
  payload: {},
  createdAt: "2026-11-12T12:00:00.000Z",
  updatedAt: "2026-11-12T12:00:00.000Z",
  history: [],
  ...overrides,
});

const createInput = {
  amountCents: 15010,
  description: "Casa - Créditos",
  externalId: "bl-top-abc",
  expiresIn: 3600,
  metadata: { tenantId: "t1" },
  requestIp: "203.0.113.7",
};

function call(fetchMock: ReturnType<typeof vi.fn>, i: number) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe("spacepay-pix.server", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setConfigured();
    recordBillingSignal.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("SpacePayError is a PixGatewayError with provider spacepay", () => {
    const err = new SpacePayError("x", { status: 404, code: "NOT_FOUND", retryable: false });
    expect(err).toBeInstanceOf(PixGatewayError);
    expect(err.provider).toBe("spacepay");
    expect(isPixNotFound(err)).toBe(true);
  });

  describe("isConfigured", () => {
    it("is true only when every required config field and PUBLIC_APP_URL are set", async () => {
      expect(await spacePayGateway.isConfigured()).toBe(true);
      for (const field of [
        "gatewayToken",
        "callbackSecret",
        "payer.name",
        "payer.document",
        "payer.email",
        "payer.phone",
      ]) {
        setConfigured();
        blankConfigField(field);
        expect(await spacePayGateway.isConfigured(), field).toBe(false);
      }
      setConfigured();
      process.env.PUBLIC_APP_URL = "  ";
      expect(await spacePayGateway.isConfigured(), "PUBLIC_APP_URL").toBe(false);
    });

    it("is false when there is no SpacePay config at all", async () => {
      gatewayConfig.spacepay = null;
      expect(await spacePayGateway.isConfigured()).toBe(false);
    });

    it("does not require the casino token", async () => {
      gatewayConfig.spacepay!.casinoToken = null;
      expect(await spacePayGateway.isConfigured()).toBe(true);
    });
  });

  it("callback URL uses PUBLIC_APP_URL without trailing slash and a verifiable token", async () => {
    const url = await spacePayCallbackUrl("bl-inv-9");
    const prefix = "https://crm.example.com/api/public/spacepay/webhook/";
    expect(url.startsWith(prefix)).toBe(true);
    const token = url.slice(prefix.length);
    expect(verifySpacePayCallbackToken(token, "cb-secret")).toEqual({
      ok: true,
      externalId: "bl-inv-9",
    });
  });

  it("callback URL is signed with the CURRENT callback secret", async () => {
    gatewayConfig.spacepay!.callbackSecret = "rotated-secret";
    const url = await spacePayCallbackUrl("bl-inv-9");
    const token = url.split("/").pop()!;
    expect(verifySpacePayCallbackToken(token, "rotated-secret")).toMatchObject({ ok: true });
    expect(verifySpacePayCallbackToken(token, "cb-secret")).toMatchObject({ ok: false });
  });

  it("callback URL throws NOT_CONFIGURED without a SpacePay config", async () => {
    gatewayConfig.spacepay = null;
    await expect(spacePayCallbackUrl("bl-inv-9")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  describe("create", () => {
    it("sends the exact strict body with reais and maps the response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json(cashIn()));
      vi.stubGlobal("fetch", fetchMock);

      const charge = await spacePayGateway.create(createInput);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init, body } = call(fetchMock, 0);
      expect(url).toBe("https://spacepay.test/create_gateway_cash_in");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw-token");
      expect(body).toEqual({
        document: "12.345.678/0001-90",
        email: "financeiro@example.com",
        name: "Betleads Ltda",
        amount: 150.1,
        webhook: await spacePayCallbackUrl("bl-top-abc"),
        ip_address: "203.0.113.7",
        idempotency_key: "bl-top-abc",
        phone: "11999998888",
      });
      expect(String(init.body)).toContain('"amount":150.1,');

      expect(charge).toEqual({
        id: "8f6c7c1e-0000-4000-8000-000000000001",
        externalId: "bl-top-abc",
        status: "ACTIVE",
        amountCents: 15010,
        emv: "00020101021226...",
        qrCodeImage: "https://integration.prod.spacedev.pro/qr/8f6c.png",
        paymentUrl: null,
        expiresAt: "2026-11-12T12:05:00.000Z",
        paidAt: null,
        paidAmountCents: null,
        payer: null,
        raw: {
          transaction_id: "8f6c7c1e-0000-4000-8000-000000000001",
          idempotency_key: "bl-top-abc",
          status: "created",
          expiration_time: "2026-11-12T12:05:00.000Z",
          created_at: "2026-11-12T12:00:00.000Z",
          paid_at: null,
          currency: "BRL",
        },
      });
    });

    it("keeps unknown fields and copy_paste out of raw (LGPD allow-list)", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            json(cashIn({ payer: { document: "123.456.789-09" }, webhook: "https://x/secret" })),
          ),
      );
      const charge = await spacePayGateway.create(createInput);
      const serialized = JSON.stringify(charge.raw);
      expect(serialized).not.toContain("123.456.789-09");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("00020101021226");
    });

    it("converts cents to reais exactly and sends ip_address null when absent", async () => {
      for (const [cents, reais] of [
        [1999, "19.99"],
        [10, "0.1"],
        [1, "0.01"],
        [123456789, "1234567.89"],
        [29, "0.29"],
      ] as const) {
        const fetchMock = vi.fn().mockResolvedValue(json(cashIn()));
        vi.stubGlobal("fetch", fetchMock);
        await spacePayGateway.create({ ...createInput, amountCents: cents, requestIp: undefined });
        const raw = String(call(fetchMock, 0).init.body);
        expect(raw).toContain(`"amount":${reais},`);
        expect(call(fetchMock, 0).body.ip_address).toBeNull();
      }
    });

    it("rejects a non-positive or fractional amount without calling the API", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      for (const amountCents of [0, -100, 10.5]) {
        await expect(spacePayGateway.create({ ...createInput, amountCents })).rejects.toMatchObject(
          {
            code: "VALIDATION",
          },
        );
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops a non-https qr_code", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json(cashIn({ qr_code: "data:image/png;base64,AAAA" }))),
      );
      const charge = await spacePayGateway.create(createInput);
      expect(charge.qrCodeImage).toBeNull();
    });

    it("retries once on 5xx with the same body, then succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(502))
        .mockResolvedValueOnce(json(cashIn()));
      vi.stubGlobal("fetch", fetchMock);

      const charge = await spacePayGateway.create(createInput);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(fetchMock, 1).init.body).toBe(call(fetchMock, 0).init.body);
      expect(charge.status).toBe("ACTIVE");
      expect(recordBillingSignal).toHaveBeenCalledWith("spacepay_unavailable", "502 SERVER_ERROR");
    });

    it("retries once on a network error and gives up after the second failure", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({
        provider: "spacepay",
        code: "NETWORK_ERROR",
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(recordBillingSignal).toHaveBeenCalledWith("spacepay_unavailable", "NETWORK_ERROR");
    });

    it("does not retry on 400 and maps it to VALIDATION", async () => {
      const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, "amount inválido"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({
        status: 400,
        code: "VALIDATION",
        retryable: false,
        message: "amount inválido",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recordBillingSignal).not.toHaveBeenCalled();
    });

    it.each([
      [401, "INVALID_TOKEN"],
      [403, "FORBIDDEN"],
    ])("%i records spacepay_unauthorized and is not retried", async (status, code) => {
      const fetchMock = vi.fn().mockResolvedValue(errorResponse(status));
      vi.stubGlobal("fetch", fetchMock);

      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({ status, code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recordBillingSignal).toHaveBeenCalledWith(
        "spacepay_unauthorized",
        `${status} ${code}`,
      );
    });

    it("on 409 finds the existing transaction by idempotency key across pages", async () => {
      const others = Array.from({ length: 100 }, (_, i) =>
        tx({ id: `other-${i}`, idempotencyKey: `bl-other-${i}` }),
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(409, "duplicate"))
        .mockResolvedValueOnce(
          json({ status: "success", data: others, meta: { page: 1, perPage: 100, total: 101 } }),
        )
        .mockResolvedValueOnce(
          json({
            status: "success",
            data: [tx({ status: "paid", paidAt: "2026-11-12T12:01:00.000Z" })],
            meta: { page: 2, perPage: 100, total: 101 },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-12T12:00:00.000Z"));

      const charge = await spacePayGateway.create(createInput);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const first = new URL(call(fetchMock, 1).url);
      expect(first.pathname).toBe("/transactions");
      expect(Object.fromEntries(first.searchParams)).toEqual({
        type: "cash_in",
        dateField: "createdAt",
        from: "2026-11-10T12:00:00.000Z",
        page: "1",
        perPage: "100",
      });
      expect(new URL(call(fetchMock, 2).url).searchParams.get("page")).toBe("2");
      expect(charge).toMatchObject({
        id: "8f6c7c1e-0000-4000-8000-000000000001",
        externalId: "bl-top-abc",
        status: "PAID",
        amountCents: 15010,
        paidAmountCents: 15010,
        paidAt: "2026-11-12T12:01:00.000Z",
        emv: null,
        qrCodeImage: null,
        expiresAt: null,
        payer: null,
      });
    });

    it("on 409 with no matching transaction rethrows the 409", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(409, "duplicate"))
        .mockResolvedValueOnce(
          json({ status: "success", data: [], meta: { page: 1, perPage: 100, total: 0 } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({
        status: 409,
        code: "DUPLICATE",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("a retry that hits 409 (first attempt landed) recovers through the lookup", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(errorResponse(409))
        .mockResolvedValueOnce(json({ status: "success", data: [tx()], meta: { total: 1 } }));
      vi.stubGlobal("fetch", fetchMock);

      const charge = await spacePayGateway.create(createInput);
      expect(charge.status).toBe("ACTIVE");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("throws NOT_CONFIGURED without calling the API when the payer is missing", async () => {
      gatewayConfig.spacepay!.payer = { ...gatewayConfig.spacepay!.payer, phone: "" };
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({
        code: "NOT_CONFIGURED",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a response without transaction_id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(cashIn({ transaction_id: null }))));
      await expect(spacePayGateway.create(createInput)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    });
  });

  describe("get", () => {
    it("by providerChargeId reads /transactions/{id} with the casino token when set", async () => {
      gatewayConfig.spacepay!.casinoToken = "casino-token";
      const body = {
        status: "success",
        data: tx({ status: "paid", paidAt: "2026-11-12T12:02:00Z" }),
      };
      const fetchMock = vi.fn().mockResolvedValue(json(body));
      vi.stubGlobal("fetch", fetchMock);

      const charge = await spacePayGateway.get({
        externalId: "bl-top-abc",
        providerChargeId: "8f6c7c1e-0000-4000-8000-000000000001",
      });

      const { url, init } = call(fetchMock, 0);
      expect(url).toBe("https://spacepay.test/transactions/8f6c7c1e-0000-4000-8000-000000000001");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer casino-token");
      expect(charge).toEqual({
        id: "8f6c7c1e-0000-4000-8000-000000000001",
        externalId: "bl-top-abc",
        status: "PAID",
        amountCents: 15010,
        emv: null,
        qrCodeImage: null,
        paymentUrl: null,
        expiresAt: null,
        paidAt: "2026-11-12T12:02:00Z",
        paidAmountCents: 15010,
        payer: null,
        raw: {
          id: "8f6c7c1e-0000-4000-8000-000000000001",
          status: "paid",
          amount: 150.1,
          paidAt: "2026-11-12T12:02:00Z",
          createdAt: "2026-11-12T12:00:00.000Z",
          updatedAt: "2026-11-12T12:00:00.000Z",
          idempotencyKey: "bl-top-abc",
          externalId: "psp-1",
          gateway: "paganopay",
          type: "cash_in",
          endToEndId: null,
        },
      });
    });

    it("stores only the allow-list: no payload, history, callbackUrl or payer data", async () => {
      const body = {
        status: "success",
        data: tx({
          status: "paid",
          paidAt: "2026-11-12T12:02:00Z",
          callbackUrl: "https://crm.example.com/api/public/spacepay/webhook/SECRET-TOKEN",
          payload: { payer: { cpf: "12345678909", nome: "Fulano Pagador" } },
          history: [
            { status: "created", payload: { endToEndId: "E-old" } },
            {
              status: "paid",
              payload: {
                pix: { endToEndId: "E-new" },
                pagador: { documento: "12345678909", nome: "Fulano Pagador" },
              },
            },
          ],
        }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));

      const charge = await spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "id" });

      const serialized = JSON.stringify(charge.raw);
      expect(serialized).not.toContain("12345678909");
      expect(serialized).not.toContain("Fulano");
      expect(serialized).not.toContain("SECRET-TOKEN");
      expect(Object.keys(charge.raw as object).sort()).toEqual(
        [
          "amount",
          "createdAt",
          "endToEndId",
          "externalId",
          "gateway",
          "id",
          "idempotencyKey",
          "paidAt",
          "status",
          "type",
          "updatedAt",
        ].sort(),
      );
      // Newest history entry wins, found one level down (pix.endToEndId).
      expect((charge.raw as { endToEndId: string }).endToEndId).toBe("E-new");
    });

    it.each([
      [{ end_to_end_id: "E1" }, "E1"],
      [{ e2eId: "E2" }, "E2"],
      [{ end2end: "E3" }, "E3"],
      [{ endToEnd: "E4" }, "E4"],
      [{ data: { e2eId: "E5" } }, "E5"],
      [{ deep: { deeper: { endToEndId: "too-deep" } } }, null],
    ])("extracts the end-to-end id from history payload %j", async (payload, expected) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(json({ status: "success", data: tx({ history: [{ payload }] }) })),
      );
      const charge = await spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "id" });
      expect((charge.raw as { endToEndId: unknown }).endToEndId).toBe(expected);
    });

    it("rejects a transaction whose idempotencyKey is another charge's externalId", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            json({ status: "success", data: tx({ idempotencyKey: "bl-top-other" }) }),
          ),
      );
      const err = await spacePayGateway
        .get({ externalId: "bl-top-abc", providerChargeId: "id" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpacePayError);
      expect(err).toMatchObject({ status: 0, code: "INVALID_RESPONSE", retryable: false });
    });

    it("accepts a transaction without idempotencyKey", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ status: "success", data: tx({ idempotencyKey: null }) })),
      );
      const charge = await spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "id" });
      expect(charge.externalId).toBeNull();
    });

    it("falls back to the gateway token for reads", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json({ status: "success", data: tx() }));
      vi.stubGlobal("fetch", fetchMock);
      await spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "id-1" });
      expect((call(fetchMock, 0).init.headers as Record<string, string>).Authorization).toBe(
        "Bearer gw-token",
      );
    });

    it("by externalId looks the transaction up through the list", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(json({ status: "success", data: [tx()], meta: { total: 1 } }));
      vi.stubGlobal("fetch", fetchMock);

      const charge = await spacePayGateway.get({
        externalId: "bl-top-abc",
        providerChargeId: null,
      });

      expect(new URL(call(fetchMock, 0).url).pathname).toBe("/transactions");
      expect(charge.id).toBe("8f6c7c1e-0000-4000-8000-000000000001");
      expect(charge.status).toBe("ACTIVE");
    });

    it("by externalId not found throws 404 NOT_FOUND", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ status: "success", data: [tx({ idempotencyKey: "x" })] })),
      );
      const err = await spacePayGateway
        .get({ externalId: "bl-top-abc", providerChargeId: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpacePayError);
      expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(isPixNotFound(err)).toBe(true);
    });

    it("by id passes a 404 through as NOT_FOUND", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(404)));
      await expect(
        spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "missing" }),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", retryable: false });
    });

    it.each([
      ["created", "ACTIVE"],
      ["paid", "PAID"],
      ["expired", "EXPIRED"],
      ["failed", "FAILED"],
      ["refunded", "FAILED"],
      ["callback_failed", "ACTIVE"],
    ])("maps status %s to %s", async (status, expected) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ status: "success", data: tx({ status }) })),
      );
      const charge = await spacePayGateway.get({
        externalId: "bl-top-abc",
        providerChargeId: "id",
      });
      expect(charge.status).toBe(expected);
      expect(charge.paidAmountCents).toBe(expected === "PAID" ? 15010 : null);
      expect(errorSpy).toHaveBeenCalledTimes(status === "refunded" ? 1 : 0);
    });

    it("rejects an unknown status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ status: "success", data: tx({ status: "weird" }) })),
      );
      await expect(
        spacePayGateway.get({ externalId: "bl-top-abc", providerChargeId: "id" }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("rounds a float amount to cents", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ status: "success", data: tx({ amount: 0.29 }) })),
      );
      const charge = await spacePayGateway.get({
        externalId: "bl-top-abc",
        providerChargeId: "id",
      });
      expect(charge.amountCents).toBe(29);
    });
  });

  it("cancel returns null without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      spacePayGateway.cancel({ externalId: "bl-top-abc", providerChargeId: "id" }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
