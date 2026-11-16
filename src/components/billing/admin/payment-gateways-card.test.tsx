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
  PaganoPayEditForm,
  paganoPayPayload,
  PaymentGatewaysCard,
  PUBLIC_APP_URL_LOCAL_WARNING,
  PUBLIC_APP_URL_MISSING_WARNING,
  publicAppUrlWarning,
  SpacePayEditForm,
  spacePayPayload,
  upperPayload,
} from "./payment-gateways-card";

describe("PaganoPay panel", () => {
  it("shows the PaganoPay panel with the webhook URL to register in their panel", () => {
    queryState.data = {
      activeProvider: "upper",
      activeSource: "default",
      gateways: {
        upper: { source: "env", hints: {}, updatedAt: null },
        spacepay: { source: "none", hints: {}, updatedAt: null },
        paganopay: { source: "database", hints: { publicKey: "pk_f…3210" }, updatedAt: null },
      },
      publicAppUrl: "https://crm.betleads.com",
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain("PaganoPay");
    expect(html).toContain("pk_f…3210");
    expect(html).toContain("https://crm.betleads.com/api/public/paganopay/webhook");
    expect(html).toContain("Integrações → Webhook");
  });

  it("the edit form offers the SpacePay payer as the blank-field fallback", () => {
    const html = renderToStaticMarkup(
      <PaganoPayEditForm
        info={{ source: "none", hints: {}, updatedAt: null }}
        onSaved={() => undefined}
        spacePayHints={{ payerName: "BetLeads Ltda", payerDocument: "**.222.333/0001-**" }}
      />,
    );
    expect(html).toContain("copiar o pagador já cadastrado na SpacePay");
    expect(html).toContain("BetLeads Ltda (da SpacePay)");
    expect(html).toContain("**.222.333/0001-** (da SpacePay)");
    expect(html).toContain("também permite saques");
  });

  it("paganoPayPayload sends blank fields blank and only apiBase is clearable", () => {
    const payload = paganoPayPayload(
      {
        publicKey: "pk_1",
        secretKey: "",
        webhookSecret: "",
        apiBase: "",
        payerName: "",
        payerDocument: "",
        payerEmail: "",
        payerPhone: "",
      },
      ["apiBase", "secretKey"],
    );
    expect(payload.provider).toBe("paganopay");
    expect(payload.credentials.secretKey).toBe("");
    expect(payload.clearFields).toEqual(["apiBase"]);
  });
});

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
      publicAppUrl: "https://crm.betleads.com",
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain("Gateways de pagamento");
    expect(html).toContain("Variável de ambiente");
    expect(html).toContain("Banco");
    expect(html).toContain("Ativo");
    expect(html).toContain("eyJh…9f2c");
    expect(html).toContain("***.982.247-**");
    expect(html).toContain("Atualizado em 10/11/2026");
    // Both URLs come from the server's PUBLIC_APP_URL only.
    expect(html).toContain("https://crm.betleads.com/api/public/upper/webhook");
    expect(html).toContain("https://crm.betleads.com/api/public/spacepay/webhook/&lt;token&gt;");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain(PUBLIC_APP_URL_MISSING_WARNING);
    expect(html).not.toContain(PUBLIC_APP_URL_LOCAL_WARNING);
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
      publicAppUrl: "https://crm.betleads.com",
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain("Não configurado");
    expect(html).toContain("Nenhuma credencial configurada.");
  });

  it("warns when the server has no PUBLIC_APP_URL (and never guesses one)", () => {
    queryState.data = {
      activeProvider: "spacepay",
      activeSource: "database",
      gateways: {
        upper: { source: "none", hints: {}, updatedAt: null },
        spacepay: { source: "database", hints: {}, updatedAt: null },
      },
      publicAppUrl: null,
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain(PUBLIC_APP_URL_MISSING_WARNING);
    expect(html).toContain("&lt;PUBLIC_APP_URL&gt;/api/public/spacepay/webhook/&lt;token&gt;");
    expect(html).not.toContain("localhost");
  });

  it("warns when PUBLIC_APP_URL points to a local address", () => {
    queryState.data = {
      activeProvider: "spacepay",
      activeSource: "database",
      gateways: {
        upper: { source: "none", hints: {}, updatedAt: null },
        spacepay: { source: "database", hints: {}, updatedAt: null },
      },
      publicAppUrl: "http://localhost:3000",
    };
    const html = renderToStaticMarkup(<PaymentGatewaysCard />);
    expect(html).toContain(PUBLIC_APP_URL_LOCAL_WARNING);
    expect(html).toContain("http://localhost:3000/api/public/spacepay/webhook/&lt;token&gt;");
  });

});

describe("SpacePayEditForm", () => {
  it("has a plain-text Platform ID input right after the gateway token, with the stored hint", () => {
    const html = renderToStaticMarkup(
      <SpacePayEditForm
        info={{
          source: "database",
          hints: { gatewayToken: "eyJh…9f2c", platformId: "casino-42" },
          updatedAt: null,
        }}
        onSaved={() => undefined}
      />,
    );
    const labels = [...html.matchAll(/<label[^>]*>([^<]*)<\/label>/g)].map((m) => m[1]);
    const tokenIdx = labels.indexOf("Token do gateway");
    expect(labels[tokenIdx + 1]).toBe("Platform ID (X-Platform-Id) — opcional");
    expect(html).toContain(
      "Vem do /create_gateway_token da SpacePay. Em branco, o próprio token do gateway é enviado como X-Platform-Id.",
    );
    expect(html).toContain("Apagar o Platform ID salvo");
    const input = html.match(/<input[^>]*placeholder="Salvo: casino-42[^"]*"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="text"');
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
        platformId: " p-1 ",
        callbackSecret: "",
        apiBase: "",
        payerName: "Empresa",
        payerDocument: "",
        payerEmail: "",
        payerPhone: "",
      },
      ["casinoToken", "callbackSecret", "platformId"],
    );
    expect(sp.credentials.payer).toEqual({ name: "Empresa", document: "", email: "", phone: "" });
    expect(sp.credentials.platformId).toBe(" p-1 ");
    expect(sp.clearFields).toEqual(["casinoToken", "platformId"]);
  });

  it("publicAppUrlWarning", () => {
    expect(publicAppUrlWarning(null)).toBe(PUBLIC_APP_URL_MISSING_WARNING);
    expect(publicAppUrlWarning("")).toBe(PUBLIC_APP_URL_MISSING_WARNING);
    expect(publicAppUrlWarning("http://localhost:3000")).toBe(PUBLIC_APP_URL_LOCAL_WARNING);
    expect(publicAppUrlWarning("http://127.0.0.1:8080")).toBe(PUBLIC_APP_URL_LOCAL_WARNING);
    expect(publicAppUrlWarning("https://crm.betleads.com")).toBeNull();
  });

  it("isBlank", () => {
    expect(isBlank({ a: " ", b: "" })).toBe(true);
    expect(isBlank({ a: "x" })).toBe(false);
  });
});
