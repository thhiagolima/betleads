import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown, isLoading: false, isError: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/billing/payment-gateway-admin.functions", () => ({
  adminDeletePaymentGateway: vi.fn(),
  adminListPaymentGateways: vi.fn(),
  adminSavePaymentGateway: vi.fn(),
  adminSetActivePixProvider: vi.fn(),
  adminTestPaymentGateway: vi.fn(),
}));

import {
  generateCallbackSecret,
  isBlank,
  PaymentGatewaysCard,
  spacePayPayload,
  upperPayload,
} from "./payment-gateways-card";

describe("PaymentGatewaysCard", () => {
  it("shows each gateway's source, active badge, masked hints and webhook URLs", () => {
    queryState.data = {
      activeProvider: "spacepay",
      activeSource: "database",
      gateways: {
        upper: { source: "env", hints: { apiKey: "upk_…abcd" }, updatedAt: null },
        spacepay: {
          source: "database",
          hints: { gatewayToken: "eyJh…9f2c", payerDocument: "***.982.247-**" },
          updatedAt: "2026-11-10T15:30:00Z",
        },
      },
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain("Gateways de pagamento");
    expect(html).toContain("Variável de ambiente");
    expect(html).toContain("Banco");
    expect(html).toContain("Ativo");
    expect(html).toContain("eyJh…9f2c");
    expect(html).toContain("***.982.247-**");
    expect(html).toContain("Atualizado em 10/11/2026");
    expect(html).toContain("/api/public/upper/webhook");
    expect(html).toContain("/api/public/spacepay/webhook/&lt;token&gt;");
    // Only the inactive one can become active; only the DB row can be removed.
    expect(html.match(/Usar para novas cobranças/g)).toHaveLength(1);
    expect(html.match(/Remover do banco/g)).toHaveLength(1);
    expect(html.match(/Editar credenciais/g)).toHaveLength(2);
  });

  it("marks an unconfigured gateway", () => {
    queryState.data = {
      activeProvider: "upper",
      activeSource: "default",
      gateways: {
        upper: { source: "env", hints: { apiKey: "upk_…abcd" }, updatedAt: null },
        spacepay: { source: "none", hints: {}, updatedAt: null },
      },
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain("Não configurado");
    expect(html).toContain("Nenhuma credencial configurada.");
  });
});

describe("helpers", () => {
  it("generates 48 random alphanumeric characters", () => {
    const a = generateCallbackSecret();
    const b = generateCallbackSecret();
    expect(a).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(a).not.toBe(b);
  });

  it("builds save payloads keeping blank fields blank and filtering clearable fields", () => {
    expect(
      upperPayload({ apiKey: "", webhookSecret: "x", apiBase: "" }, ["apiBase", "apiKey"]),
    ).toEqual({
      provider: "upper",
      credentials: { apiKey: "", webhookSecret: "x", apiBase: "" },
      clearFields: ["apiBase"],
    });
    const sp = spacePayPayload(
      {
        gatewayToken: "",
        casinoToken: "",
        callbackSecret: "",
        apiBase: "",
        payerName: "Empresa",
        payerDocument: "",
        payerEmail: "",
        payerPhone: "",
      },
      ["casinoToken", "callbackSecret"],
    );
    expect(sp.credentials.payer).toEqual({ name: "Empresa", document: "", email: "", phone: "" });
    expect(sp.clearFields).toEqual(["casinoToken"]);
  });

  it("isBlank", () => {
    expect(isBlank({ a: " ", b: "" })).toBe(true);
    expect(isBlank({ a: "x" })).toBe(false);
  });
});
