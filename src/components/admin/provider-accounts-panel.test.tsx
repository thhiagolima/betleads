import type { ReactNode } from "react";
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
  adminAddTenantSmsAccountOption: vi.fn(),
  adminRemoveTenantSmsAccountOption: vi.fn(),
  adminListProviderAccounts: vi.fn(),
  adminSaveProviderAccount: vi.fn(),
  adminSetProviderAccountStatus: vi.fn(),
  adminSetTenantChannelProvider: vi.fn(),
  adminTestProviderAccount: vi.fn(),
  adminSetPlatformDefault: vi.fn(),
  adminDeleteProviderAccount: vi.fn(),
  adminTenantChannelImpact: vi.fn(),
  adminSetTenantChannel: vi.fn(),
}));
// Dialog content is portaled too: render it inline only while open.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});
// Select/Dropdown content is rendered inside a Radix Portal that only mounts
// when open; pass through so static markup exposes the options/disabled state.
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({
      children,
      disabled,
    }: {
      children?: ReactNode;
      disabled?: boolean;
    }) => <div data-select-disabled={disabled ? "true" : "false"}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ children }: { children?: ReactNode }) => <div role="option">{children}</div>,
  };
});

import { ProviderAccountsPanel, TenantSmsOptionsDialog } from "./provider-accounts-panel";

const houses = (sms = 0, email = 0, voice = 0, webpush = 0) => ({ sms, email, voice, webpush });
const channels = (sms = true, email = true, voice = true, webpush = false) => ({
  sms,
  email,
  voice,
  webpush,
});

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
          envAccount: true,
          defaultFor: [],
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
          envAccount: false,
          defaultFor: [],
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
          accounts: {
            sms: null,
            email: "55555555-5555-4555-8555-555555555555",
            voice: null,
            webpush: null,
          },
          channels: channels(),
        },
      ],
      defaults: {
        sms: "00000000-0000-4000-a000-00000000a001",
        email: "00000000-0000-4000-a000-00000000a002",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html).toContain("Contas de provedor");
    expect(html).toContain("Short Brasil (padrão)");
    expect(html).toContain("shortcode_token: ••••9f2a");
    expect(html).toContain("api_key: ••••1234");
    expect(html).toContain("E-mail: 1");
    expect(html).toContain("desativada");
    expect(html).toContain("incompleta");
    // Both the env account and the house account are editable now.
    expect(html.match(/Editar/g)).toHaveLength(2);
    expect(html).toContain("Provedor por casa");
    expect(html).toContain("Casa Um");
  });

  it("lists a OneSignal account with its masked org key and a Web push column", () => {
    queryState.data = {
      accounts: [
        {
          id: "00000000-0000-4000-a000-00000000a003",
          provider: "onesignal",
          label: "OneSignal (padrão)",
          channels: ["webpush"],
          status: "active",
          envAccount: true,
          defaultFor: ["webpush"],
          configured: true,
          config: {},
          credentialHints: { org_api_key: "••••9f2a" },
          houses: houses(),
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          provider: "onesignal",
          label: "OneSignal Casa Um",
          channels: ["webpush"],
          status: "active",
          envAccount: false,
          defaultFor: [],
          configured: true,
          config: { org_id: "org-casa-1" },
          credentialHints: { org_api_key: "••••abcd" },
          houses: houses(0, 0, 0, 1),
        },
      ],
      tenants: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Um",
          accounts: {
            sms: null,
            email: null,
            voice: null,
            webpush: "66666666-6666-4666-8666-666666666666",
          },
          channels: channels(),
        },
      ],
      defaults: {
        sms: "00000000-0000-4000-a000-00000000a001",
        email: "00000000-0000-4000-a000-00000000a002",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html).toContain("OneSignal (padrão)");
    expect(html).toContain("OneSignal Casa Um");
    expect(html).toContain("org_api_key: ••••9f2a");
    expect(html).toContain("Web push: 1");
    expect(html).toContain("Web push");
    // defaultFor surfaces as a per-channel badge; the account column shows
    // the catch-all count instead of a precise tally.
    expect(html).toContain("padrão de Web push");
    expect(html).toContain("todas sem conta própria");
  });

  it("gates Editar/Excluir/Desativar by env vs. db account and by default status", () => {
    queryState.data = {
      accounts: [
        {
          id: "00000000-0000-4000-a000-00000000a002",
          provider: "infobip",
          label: "Infobip (ambiente)",
          channels: ["email", "voice"],
          status: "active",
          envAccount: true,
          defaultFor: ["voice"],
          configured: true,
          config: {},
          credentialHints: { api_key: "••••aaaa" },
          houses: houses(),
        },
        {
          id: "11111111-1111-4111-8111-111111111111",
          provider: "infobip",
          label: "Infobip Livre",
          channels: ["email"],
          status: "active",
          envAccount: false,
          defaultFor: [],
          configured: true,
          config: { base_url: "https://livre.api.infobip.test" },
          credentialHints: { api_key: "••••bbbb" },
          houses: houses(0, 0, 0, 0),
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "infobip",
          label: "Infobip Padrão de E-mail",
          channels: ["email"],
          status: "active",
          envAccount: false,
          defaultFor: ["email"],
          configured: true,
          config: { base_url: "https://padrao.api.infobip.test" },
          credentialHints: { api_key: "••••cccc" },
          houses: houses(0, 0, 0, 0),
        },
      ],
      tenants: [],
      defaults: {
        sms: "00000000-0000-4000-a000-00000000a001",
        email: "22222222-2222-4222-8222-222222222222",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    // All three accounts are editable.
    expect(html.match(/Editar/g)).toHaveLength(3);
    // Only the two db accounts can be excluded; the env account cannot.
    expect(html.match(/Excluir/g)).toHaveLength(2);
    // Only the free db account (not the default of any channel) can be
    // deactivated: the env account and the db default both hide Desativar.
    expect(html.match(/Desativar/g)).toHaveLength(1);
  });

  it("offers 'Tornar padrão' only for channels the account serves and isn't already default for", () => {
    queryState.data = {
      accounts: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          provider: "infobip",
          label: "Infobip Casa X",
          channels: ["sms", "email"],
          status: "active",
          envAccount: false,
          defaultFor: ["sms"],
          configured: true,
          config: { base_url: "https://casax.api.infobip.test" },
          credentialHints: { api_key: "••••dddd" },
          houses: houses(0, 0, 0, 0),
        },
      ],
      tenants: [],
      defaults: {
        sms: "11111111-1111-4111-8111-111111111111",
        email: "00000000-0000-4000-a000-00000000a002",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html).toContain("Tornar padrão de E-mail");
    expect(html).not.toContain("Tornar padrão de SMS");
    expect(html).not.toContain("Tornar padrão de Voz");
    expect(html).not.toContain("Tornar padrão de Web push");
  });

  it("shows a switch and the select per house/channel; a disabled channel disables the select; the empty row spans 5 columns", () => {
    queryState.data = {
      accounts: [
        {
          id: "00000000-0000-4000-a000-00000000a003",
          provider: "onesignal",
          label: "OneSignal (ambiente)",
          channels: ["webpush"],
          status: "active",
          envAccount: true,
          defaultFor: ["webpush"],
          configured: true,
          config: {},
          credentialHints: { org_api_key: "••••9f2a" },
          houses: houses(),
        },
      ],
      tenants: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Sem Webpush",
          accounts: { sms: null, email: null, voice: null, webpush: null },
          channels: channels(true, true, true, false),
        },
      ],
      defaults: {
        sms: "00000000-0000-4000-a000-00000000a001",
        email: "00000000-0000-4000-a000-00000000a002",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html).toContain("ligado");
    expect(html).toContain("desligado");
    // Web push is off for this house: its select is disabled.
    expect(html).toMatch(/data-select-disabled="true"[^]*?desligado|desligado[^]*?data-select-disabled="true"/);
    expect(html).toContain("Padrão (OneSignal (ambiente))");

    queryState.data = {
      ...(queryState.data as Record<string, unknown>),
      tenants: [],
    };
    const emptyHtml = renderToStaticMarkup(<ProviderAccountsPanel />);
    expect(emptyHtml).toContain("Nenhuma casa encontrada");
    expect(emptyHtml).toMatch(/colSpan="5"|colspan="5"/);
  });

  it("shows 'Contas extras (N)' only in each house's SMS cell", () => {
    queryState.data = {
      accounts: [],
      tenants: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Um",
          accounts: { sms: null, email: null, voice: null, webpush: null },
          channels: channels(),
          smsOptions: [
            { accountId: "11111111-1111-4111-8111-111111111111", displayName: "Rota principal" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          nome: "Casa Dois",
          accounts: { sms: null, email: null, voice: null, webpush: null },
          channels: channels(),
        },
      ],
      defaults: {
        sms: "00000000-0000-4000-a000-00000000a001",
        email: "00000000-0000-4000-a000-00000000a002",
        voice: "00000000-0000-4000-a000-00000000a002",
        webpush: "00000000-0000-4000-a000-00000000a003",
      },
      verifiedEmailDomainsOnDefault: 0,
    };

    const html = renderToStaticMarkup(<ProviderAccountsPanel />);

    expect(html.match(/Contas extras \(\d+\)/g)).toEqual([
      "Contas extras (1)",
      "Contas extras (0)",
    ]);
    // Closed until clicked.
    expect(html).not.toContain("Nome que a casa vê");
  });
});

describe("TenantSmsOptionsDialog", () => {
  const account = (id: string, label: string, provider = "infobip") => ({
    id,
    provider,
    label,
    channels: ["sms"],
    status: "active",
    envAccount: false,
    defaultFor: [],
    configured: true,
    config: {},
    credentialHints: {},
    houses: houses(),
  });
  const DEFAULT = "00000000-0000-4000-a000-00000000a001";
  const LINKED = "11111111-1111-4111-8111-111111111111";
  const FREE = "22222222-2222-4222-8222-222222222222";
  const accounts = [
    account(DEFAULT, "Short Brasil (padrão)", "short_brasil"),
    account(LINKED, "Infobip Rota A"),
    account(FREE, "Infobip Rota B"),
  ] as never[];

  it("lists the house name and internal label; offers only accounts not already in use", () => {
    const html = renderToStaticMarkup(
      <TenantSmsOptionsDialog
        tenant={{
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Um",
          accounts: { sms: null, email: null, voice: null, webpush: null },
          channels: channels(),
          smsOptions: [{ accountId: LINKED, displayName: "Rota principal" }],
        }}
        accounts={accounts}
        smsAccounts={accounts}
        defaultAccountId={DEFAULT}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Contas extras de SMS · Casa Um");
    // Linked option: name the house sees + internal label (super admin only).
    expect(html).toContain("Rota principal");
    expect(html).toContain("Infobip Rota A");
    expect(html).toContain('aria-label="Remover Rota principal"');
    // Add select: neither the house default nor an already linked account.
    const options = html.match(/<div role="option">[^<]*<\/div>/g) ?? [];
    expect(options).toEqual(['<div role="option">Infobip Rota B</div>']);
    expect(html).toContain("Nome que a casa vê");
  });

  it("empty list", () => {
    const html = renderToStaticMarkup(
      <TenantSmsOptionsDialog
        tenant={{
          id: "00000000-0000-4000-8000-000000000001",
          nome: "Casa Um",
          accounts: { sms: null, email: null, voice: null, webpush: null },
          channels: channels(),
        }}
        accounts={accounts}
        smsAccounts={accounts}
        defaultAccountId={DEFAULT}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("Nenhuma conta extra.");
  });
});
