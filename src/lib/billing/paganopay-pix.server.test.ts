import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordBillingSignal } = vi.hoisted(() => ({
  recordBillingSignal: vi.fn(async () => undefined),
}));
vi.mock("./billing-signals.server", () => ({ recordBillingSignal }));

type TestConfig = {
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  apiBase: string | null;
  payer: { name: string; document: string; email: string; phone: string };
};
const gatewayConfig = vi.hoisted(() => ({ paganopay: null as TestConfig | null }));
vi.mock("./payment-gateway-config.server", () => ({
  getPaganoPayConfig: async () => ({
    source: gatewayConfig.paganopay ? "database" : "none",
    config: gatewayConfig.paganopay,
  }),
}));

import { isPixNotFound } from "./pix-gateway-error";
import {
  PaganoPayError,
  buildPaganoPayChargeBody,
  mapPaganoPayStatus,
  paganoPayErrorDetail,
  paganoPayGateway,
  parsePaganoPayCharge,
} from "./paganopay-pix.server";

const PK = "pk_0123456789abcdef0123456789abcdef";
const SK = "sk_" + "ab".repeat(32);
const EMV = "00020101021226870014br.gov.bcb.pix2565qrcode.exemplo.com/v2/cobv/abc6304B14F";

function setConfigured() {
  gatewayConfig.paganopay = {
    publicKey: PK,
    secretKey: SK,
    webhookSecret: "whsec",
    apiBase: "https://pagano.test/api/",
    payer: {
      name: "Betleads Ltda",
      document: "11.222.333/0001-81",
      email: "financeiro@example.com",
      phone: "(11) 99999-8888",
    },
  };
}

const INPUT = {
  amountCents: 400000,
  description: "Mensalidade Casa X — 12/2026",
  externalId: "bl-inv-abc-1",
  expiresIn: 3600,
  metadata: { kind: "invoice" },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const CREATED = {
  success: true,
  data: {
    id: 26150,
    status: "PENDING",
    amount_brl: "4000.00",
    external_id: "01a020de-96d2",
    pix: { qrcode: EMV, copyPaste: EMV, expiresAt: "2026-11-16T18:00:00Z" },
  },
};

function txBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      id: 26150,
      status: "PAID",
      amount: 400000,
      amount_brl: 4000,
      externalRef: "bl-inv-abc-1",
      externalId: "01a020de-96d2",
      endToEndId: "E000202611161705abc",
      customer: { name: "Betleads Ltda", document: "11222333000181" },
      payer: { name: "FULANO", document: "12345678909" },
      payerMatchesCustomer: false,
      paidAt: "2026-11-16T17:05:12.000Z",
      fee_amount: 1.99,
      ...overrides,
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setConfigured();
  recordBillingSignal.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapPaganoPayStatus", () => {
  it.each([
    ["PENDING", "ACTIVE"],
    ["WAITING_PAYMENT", "ACTIVE"],
    ["PROCESSING", "ACTIVE"],
    ["PAID", "PAID"],
    ["COMPLETED", "PAID"],
    ["confirmed", "PAID"],
    ["MED", "PAID"],
    ["CHARGEBACK", "PAID"],
    ["EXPIRED", "EXPIRED"],
    ["CANCELLED", "CANCELLED"],
    ["FAILED", "FAILED"],
    ["REJECTED", "FAILED"],
    ["REFUNDED", "FAILED"],
    ["SOMETHING_NEW", "ACTIVE"],
    [undefined, "ACTIVE"],
  ])("%s → %s", (input, expected) => {
    expect(mapPaganoPayStatus(input)).toBe(expected);
  });
});

describe("buildPaganoPayChargeBody", () => {
  it("sends cents, digits-only payer, one item matching the total", () => {
    const body = buildPaganoPayChargeBody(INPUT, gatewayConfig.paganopay!.payer);
    expect(body).toEqual({
      amount: 400000,
      sellerExternalRef: "bl-inv-abc-1",
      customer: {
        name: "Betleads Ltda",
        email: "financeiro@example.com",
        phone: "11999998888",
        documentType: "CNPJ",
        document: "11222333000181",
      },
      items: [{ title: INPUT.description, quantity: 1, amount: 400000 }],
      expiresIn: 3600,
      metadata: { kind: "invoice" },
    });
  });

  it("clamps expiresIn to PaganoPay's 60 s – 30 d", () => {
    const payer = gatewayConfig.paganopay!.payer;
    expect(buildPaganoPayChargeBody({ ...INPUT, expiresIn: 5 }, payer).expiresIn).toBe(60);
    expect(buildPaganoPayChargeBody({ ...INPUT, expiresIn: 9e9 }, payer).expiresIn).toBe(2_592_000);
  });

  it("uses CPF for an 11-digit payer document", () => {
    const body = buildPaganoPayChargeBody(INPUT, {
      ...gatewayConfig.paganopay!.payer,
      document: "123.456.789-09",
    });
    expect(body.customer.documentType).toBe("CPF");
  });

  it("refuses an amount under R$ 1,00", () => {
    expect(() =>
      buildPaganoPayChargeBody({ ...INPUT, amountCents: 99 }, gatewayConfig.paganopay!.payer),
    ).toThrow(PaganoPayError);
  });
});

describe("paganoPayGateway.create", () => {
  it("POSTs to /payments/pix with both keys and our Idempotency-Key, and normalizes", async () => {
    fetchMock.mockResolvedValueOnce(json(201, CREATED));
    const charge = await paganoPayGateway.create({ ...INPUT, requestIp: "1.2.3.4" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pagano.test/api/payments/pix");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Public-Key"]).toBe(PK);
    expect(init.headers["X-API-Secret-Key"]).toBe(SK);
    expect(init.headers["Idempotency-Key"]).toBe("betleads-bl-inv-abc-1");
    expect(JSON.parse(init.body).amount).toBe(400000);

    expect(charge).toMatchObject({
      id: "26150",
      externalId: "bl-inv-abc-1",
      status: "ACTIVE",
      amountCents: 400000,
      emv: EMV,
      qrCodeImage: null,
      expiresAt: "2026-11-16T18:00:00Z",
      paidAmountCents: null,
    });
    // Allow-list only: never the customer block.
    expect(JSON.stringify(charge.raw)).not.toContain("financeiro@example.com");
  });

  it("treats a 200 idempotent repeat as success", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...CREATED, message: "Pagamento já processado anteriormente" }));
    const charge = await paganoPayGateway.create(INPUT);
    expect(charge.id).toBe("26150");
  });

  it("retries once with the same Idempotency-Key after a 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { success: false, message: "Arranjo indisponível" }))
      .mockResolvedValueOnce(json(200, CREATED));
    await paganoPayGateway.create(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).toBe("betleads-bl-inv-abc-1");
    expect(recordBillingSignal).toHaveBeenCalledWith("paganopay_unavailable", "503 SERVER_ERROR");
  });

  it("does not retry a 400, and keeps their message without our keys", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { success: false, message: `CPF inválido para ${SK}` }),
    );
    const err = await paganoPayGateway.create(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(PaganoPayError);
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("CPF inválido");
    expect(err.message).not.toContain(SK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("signals refused keys (401) and a disabled account", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { success: false, message: "API Keys inválidas" }));
    await expect(paganoPayGateway.create(INPUT)).rejects.toThrow(PaganoPayError);
    expect(recordBillingSignal).toHaveBeenCalledWith("paganopay_unauthorized", "401 UNAUTHORIZED");

    fetchMock.mockResolvedValueOnce(
      json(400, { success: false, code: "ACCOUNT_DISABLED", message: "Conta desativada" }),
    );
    await expect(paganoPayGateway.create(INPUT)).rejects.toThrow(PaganoPayError);
    expect(recordBillingSignal).toHaveBeenCalledWith(
      "paganopay_unauthorized",
      "400 ACCOUNT_DISABLED",
    );
  });

  it("refuses to create without a complete payer", async () => {
    gatewayConfig.paganopay!.payer.email = " ";
    await expect(paganoPayGateway.create(INPUT)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("paganoPayGateway.get", () => {
  it("reads by id and keeps an allow-listed raw with the end-to-end id", async () => {
    fetchMock.mockResolvedValueOnce(json(200, txBody()));
    const charge = await paganoPayGateway.get({
      externalId: "bl-inv-abc-1",
      providerChargeId: "26150",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://pagano.test/api/payments/transactions/26150");
    expect(charge).toMatchObject({
      status: "PAID",
      amountCents: 400000,
      paidAmountCents: 400000,
      paidAt: "2026-11-16T17:05:12.000Z",
      payer: { name: "FULANO", document: "12345678909" },
    });
    const raw = charge.raw as Record<string, unknown>;
    expect(raw.endToEndId).toBe("E000202611161705abc");
    expect(raw.status).toBe("PAID");
    expect(raw).not.toHaveProperty("customer");
    expect(raw).not.toHaveProperty("payer");
  });

  it("finds the id by our reference when we never stored it", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, data: [{ id: 26150, status: "PAID" }] }))
      .mockResolvedValueOnce(json(200, txBody()));
    await paganoPayGateway.get({ externalId: "bl-inv-abc-1", providerChargeId: null });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://pagano.test/api/payments/transactions?sellerExternalRef=bl-inv-abc-1&limit=1",
    );
  });

  it("throws a not-found PixGatewayError when the reference is unknown", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: [] }));
    const err = await paganoPayGateway
      .get({ externalId: "bl-x", providerChargeId: null })
      .catch((e) => e);
    expect(isPixNotFound(err)).toBe(true);
  });

  it("maps their 404 to not-found", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { success: false, message: "Transação não encontrada" }));
    const err = await paganoPayGateway
      .get({ externalId: "bl-inv-abc-1", providerChargeId: "1" })
      .catch((e) => e);
    expect(isPixNotFound(err)).toBe(true);
  });

  it("never reads a charge whose reference is someone else's", async () => {
    fetchMock.mockResolvedValueOnce(json(200, txBody({ externalRef: "other-ref" })));
    await expect(
      paganoPayGateway.get({ externalId: "bl-inv-abc-1", providerChargeId: "26150" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("paganoPayGateway.cancel", () => {
  const ref = { externalId: "bl-inv-abc-1", providerChargeId: "26150" };

  it("cancels a pending charge and returns the fresh CANCELLED one", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, txBody({ status: "PENDING" })))
      .mockResolvedValueOnce(json(200, { success: true, message: "Cobrança cancelada" }))
      .mockResolvedValueOnce(json(200, txBody({ status: "CANCELLED" })));
    const charge = await paganoPayGateway.cancel(ref);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://pagano.test/api/payments/transactions/26150/cancel",
    );
    expect(charge?.status).toBe("CANCELLED");
  });

  it("returns the PAID charge instead of cancelling it", async () => {
    fetchMock.mockResolvedValueOnce(json(200, txBody({ status: "PAID" })));
    const charge = await paganoPayGateway.cancel(ref);
    expect(charge?.status).toBe("PAID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads after a 400 (it moved on meanwhile)", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, txBody({ status: "PENDING" })))
      .mockResolvedValueOnce(json(400, { success: false, message: "A cobrança não está pendente" }))
      .mockResolvedValueOnce(json(200, txBody({ status: "PAID" })));
    const charge = await paganoPayGateway.cancel(ref);
    expect(charge?.status).toBe("PAID");
  });
});

describe("parsePaganoPayCharge / paganoPayErrorDetail", () => {
  it("accepts a webhook-shaped body (amount in cents, external_ref)", () => {
    const charge = parsePaganoPayCharge({
      event: "pix.confirmed",
      id: 7,
      status: "PAID",
      amount: 10000,
      external_ref: "bl-top-1",
      pix: { endToEndId: "E1" },
    });
    expect(charge).toMatchObject({ id: "7", externalId: "bl-top-1", amountCents: 10000 });
    expect((charge.raw as Record<string, unknown>).endToEndId).toBe("E1");
  });

  it("redacts key-looking strings from their message", () => {
    expect(
      paganoPayErrorDetail({ message: "chave pk_0123456789abcdef inválida" }, []),
    ).toBe("chave ••• inválida");
  });
});
