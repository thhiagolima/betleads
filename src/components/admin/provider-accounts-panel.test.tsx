import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown, isLoading: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/provider-accounts.functions", () => ({
  adminListProviderAccounts: vi.fn(),
  adminSaveProviderAccount: vi.fn(),
  adminSetProviderAccountStatus: vi.fn(),
  adminSetTenantChannelProvider: vi.fn(),
  adminTestProviderAccount: vi.fn(),
}));

import { ProviderAccountsPanel } from "./provider-accounts-panel";

const houses = (sms = 0, email = 0, voice = 0) => ({ sms, email, voice });

describe("ProviderAccountsPanel", () => {
  it("lists accounts with masked credentials only and each house's account per channel", () => {
    queryState.data = {
      accounts: [
        {
          id: "00000000-0000-4000-a000-00000000a001",
          provider: "short_brasil",
          label: "Short Brasil (padrão)",
          channels: ["sms"],
          status: "active",
          platformDefault: true,
          configured: true,
          config: {},
          credentialHints: { shortcode_token: "••••9f2a" },
          houses: houses(),
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          provider: "infobip",
          label: "Infobip Casa Um",
          channels: ["email", "voice"],
          status: "disabled",
          platformDefault: false,
          configured: false,
          config: { base_url: "https://own.api.infobip.test" },
          credentialHints: { api_key: "••••1234" },
          houses: houses(0, 1, 0),
        },
      ],
      tenants: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Um",
          accounts: { sms: null, email: "55555555-5555-4555-8555-555555555555", voice: null },
        },
      ],
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html).toContain("Contas de provedor");
    expect(html).toContain("Short Brasil (padrão)");
    expect(html).toContain("padrão da plataforma");
    expect(html).toContain("shortcode_token: ••••9f2a");
    expect(html).toContain("api_key: ••••1234");
    expect(html).toContain("E-mail: 1");
    expect(html).toContain("desativada");
    expect(html).toContain("incompleta");
    // The platform accounts are read-only: only the house account has Editar.
    expect(html.match(/Editar/g)).toHaveLength(1);
    expect(html).toContain("Provedor por casa");
    expect(html).toContain("Casa Um");
  });
});
