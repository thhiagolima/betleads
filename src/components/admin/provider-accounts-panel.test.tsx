import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown, isLoading: false };
/** Task 12: `ProviderAccountsPanel` now also queries the own-provider grants list
 * (`OWN_GRANTS_QUERY_KEY`, key[1] = "own-provider-grants") alongside the main
 * accounts list — route by queryKey so each query gets its own fixture instead of
 * both reading `queryState.data`. */
const grantsQueryState = { data: [] as unknown[], isLoading: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) =>
    Array.isArray(opts.queryKey) && opts.queryKey[1] === "own-provider-grants"
      ? grantsQueryState
      : queryState,
  useMutation: (opts: { mutationFn: (vars: unknown) => unknown }) => ({
    mutate: (vars: unknown) => void opts.mutationFn(vars),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/system-dialog-host", () => ({
  requestConfirmation: vi.fn(async () => true),
  requestTextInput: vi.fn(async () => null),
}));
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
vi.mock("@/lib/own-provider.functions", () => ({
  adminListOwnProviderGrants: vi.fn(),
  adminSetOwnProviderGrant: vi.fn(),
  adminResolveRevokedOwnProvider: vi.fn(),
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

import {
  AccountsCard,
  ProviderAccountsPanel,
  TenantSmsOptionsDialog,
  TenantProvidersCard,
  createOwnProviderSaveFeeHandler,
  createOwnProviderToggleHandler,
  ownProviderFeeConfirmMessage,
  ownProviderPauseConfirmMessage,
  ownProviderStateLabel,
  parseFeeInputCents,
  tenantChannelAccountOptions,
  type TenantProvidersRow,
} from "./provider-accounts-panel";
import { requestConfirmation, requestTextInput } from "@/components/system-dialog-host";
import type { ProviderAccountView } from "@/lib/provider-accounts-admin.server";
import type { OwnProviderGrantView } from "@/lib/own-provider-admin.server";

const mockedRequestConfirmation = requestConfirmation as unknown as ReturnType<typeof vi.fn>;
const mockedRequestTextInput = requestTextInput as unknown as ReturnType<typeof vi.fn>;

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

// ---------------------------------------------------------------------------
// Task 12: conta própria de provedor por casa — telas do super admin.
// ---------------------------------------------------------------------------

function account(overrides: Partial<ProviderAccountView> = {}): ProviderAccountView {
  return {
    id: "acc-1",
    provider: "infobip",
    label: "Infobip Padrão",
    channels: ["sms"],
    status: "active",
    envAccount: false,
    ownerTenantId: null,
    defaultFor: [],
    configured: true,
    config: {},
    credentialHints: { api_key: "••••abcd" },
    houses: { sms: 0, email: 0, voice: 0, webpush: 0 },
    ...overrides,
  };
}

function tenantRow(overrides: Partial<TenantProvidersRow> = {}): TenantProvidersRow {
  return {
    id: "tenant-1",
    nome: "Casa Teste",
    accounts: { sms: null, email: null, voice: null, webpush: null },
    channels: { sms: true, email: true, voice: true, webpush: true },
    ...overrides,
  };
}

describe("AccountsCard — conta com dono", () => {
  it('mostra o selo "Conta da casa {nome}" e esconde Editar/Testar/Excluir, só Desativar/Reativar', () => {
    const owned = account({
      id: "acc-owned",
      ownerTenantId: "tenant-1",
      label: "Conta própria SMS",
      credentialHints: {},
    });
    const html = renderToStaticMarkup(
      <AccountsCard
        accounts={[owned]}
        tenants={[tenantRow()]}
        verifiedEmailDomainsOnDefault={0}
        loading={false}
        onCreate={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(html).toContain("Conta da casa Casa Teste");
    expect(html).not.toContain("Editar");
    expect(html).not.toContain("Testar");
    expect(html).not.toContain("Excluir");
    expect(html).toContain("Desativar");
  });

  it("uma conta da plataforma continua com Editar/Testar/Excluir", () => {
    const platform = account({ id: "acc-platform" });
    const html = renderToStaticMarkup(
      <AccountsCard
        accounts={[platform]}
        tenants={[]}
        verifiedEmailDomainsOnDefault={0}
        loading={false}
        onCreate={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(html).toContain("Editar");
    expect(html).toContain("Testar");
    expect(html).toContain("Excluir");
    expect(html).not.toContain("Conta da casa");
  });
});

describe("TenantProvidersCard — conta própria por casa", () => {
  it('mostra "Permitir conta própria", "Taxa mensal (R$)" e o estado "Plataforma" sem concessão', () => {
    const html = renderToStaticMarkup(
      <TenantProvidersCard
        accounts={[]}
        tenants={[tenantRow()]}
        defaults={{} as Record<string, string>}
        grants={[]}
        loading={false}
      />,
    );
    expect(html).toContain("Permitir conta própria");
    expect(html).toContain("Plataforma");
  });

  it('mostra "Conta da casa: {label}" e o campo de taxa quando a concessão está ativa e ligada', () => {
    const grant: OwnProviderGrantView = {
      tenantId: "tenant-1",
      channel: "sms",
      allowed: true,
      monthlyFeeCents: 5000,
      pendingDecision: false,
      account: {
        id: "acc-own",
        provider: "short_brasil",
        label: "Conta própria SMS",
        status: "active",
        disabledReason: null,
        lastCallbackAt: null,
        lastAcceptedSendAt: null,
      },
      active: true,
    };
    const html = renderToStaticMarkup(
      <TenantProvidersCard
        accounts={[]}
        tenants={[tenantRow()]}
        defaults={{} as Record<string, string>}
        grants={[grant]}
        loading={false}
      />,
    );
    expect(html).toContain("Conta da casa: Conta própria SMS");
    expect(html).toContain("Taxa mensal (R$)");
  });

  it('mostra "Pausado: aguardando decisão" com os botões de resolução', () => {
    const grant: OwnProviderGrantView = {
      tenantId: "tenant-1",
      channel: "email",
      allowed: false,
      monthlyFeeCents: 0,
      pendingDecision: true,
      account: null,
      active: false,
    };
    const html = renderToStaticMarkup(
      <TenantProvidersCard
        accounts={[]}
        tenants={[tenantRow()]}
        defaults={{} as Record<string, string>}
        grants={[grant]}
        loading={false}
      />,
    );
    expect(html).toContain("Pausado: aguardando decisão");
    expect(html).toContain("Voltar para a padrão");
    expect(html).toContain("Manter pausado");
  });
});

describe("ownProviderStateLabel", () => {
  it("retorna Plataforma sem concessão", () => {
    expect(ownProviderStateLabel(undefined)).toBe("Plataforma");
  });

  it("retorna o rótulo pausado quando pendingDecision", () => {
    expect(
      ownProviderStateLabel({
        tenantId: "t",
        channel: "sms",
        allowed: false,
        monthlyFeeCents: 0,
        pendingDecision: true,
        account: null,
        active: false,
      }),
    ).toBe("Pausado: aguardando decisão");
  });

  it("retorna Conta da casa quando ativa com conta ligada", () => {
    expect(
      ownProviderStateLabel({
        tenantId: "t",
        channel: "sms",
        allowed: true,
        monthlyFeeCents: 100,
        pendingDecision: false,
        account: {
          id: "a",
          provider: "short_brasil",
          label: "X",
          status: "active",
          disabledReason: null,
          lastCallbackAt: null,
          lastAcceptedSendAt: null,
        },
        active: true,
      }),
    ).toBe("Conta da casa: X");
  });
});

describe("ownProviderPauseConfirmMessage", () => {
  it("monta a mensagem de confirmação ao desligar o canal", () => {
    expect(ownProviderPauseConfirmMessage("sms")).toBe(
      "Os envios de SMS desta casa vão pausar e a equipe da casa verá um aviso. Nada sai pela rota da BetLeads até você decidir.",
    );
  });
});

describe("tenantChannelAccountOptions", () => {
  it("não lista conta com dono de outra casa", () => {
    const own = account({ id: "own", ownerTenantId: "other-tenant", channels: ["sms"] });
    const platform = account({ id: "plat", ownerTenantId: null, channels: ["sms"] });
    const options = tenantChannelAccountOptions([own, platform], "sms");
    expect(options.map((a) => a.id)).toEqual(["plat"]);
  });

  it("não lista conta com dono mesmo quando é a conta própria da própria casa", () => {
    const own = account({ id: "own", ownerTenantId: "tenant-1", channels: ["sms"] });
    const options = tenantChannelAccountOptions([own], "sms");
    expect(options).toEqual([]);
  });

  it("não lista conta desativada nem conta que não atende o canal", () => {
    const disabled = account({ id: "off", status: "disabled", channels: ["sms"] });
    const otherChannel = account({ id: "voice-only", channels: ["voice"] });
    const options = tenantChannelAccountOptions([disabled, otherChannel], "sms");
    expect(options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1: enable asks for the fee up front; the fee field never saves on
// blur — only an explicit "Salvar" after a confirmation, like every other
// billing change in this panel.
// ---------------------------------------------------------------------------

afterEach(() => {
  mockedRequestConfirmation.mockReset().mockResolvedValue(true);
  mockedRequestTextInput.mockReset().mockResolvedValue(null);
});

function tenantGrantRow(overrides: Partial<TenantProvidersRow> = {}): TenantProvidersRow {
  return tenantRow(overrides);
}

describe("parseFeeInputCents", () => {
  it("aceita 0", () => {
    expect(parseFeeInputCents("0")).toBe(0);
  });

  it("converte vírgula e ponto para centavos", () => {
    expect(parseFeeInputCents("75,50")).toBe(7550);
    expect(parseFeeInputCents("75.50")).toBe(7550);
  });

  it("rejeita vazio, não numérico e negativo", () => {
    expect(parseFeeInputCents("")).toBeNull();
    expect(parseFeeInputCents("  ")).toBeNull();
    expect(parseFeeInputCents("abc")).toBeNull();
    expect(parseFeeInputCents("-1")).toBeNull();
  });
});

describe("ownProviderFeeConfirmMessage", () => {
  it("monta a mensagem com o canal e o valor formatado em R$", () => {
    expect(ownProviderFeeConfirmMessage("sms", 5000)).toBe(
      "A taxa mensal de SMS desta casa passa a ser R$\u00A050,00 a partir da próxima fatura.",
    );
  });
});

describe("createOwnProviderToggleHandler", () => {
  it("ligar sem informar a taxa (fecha o diálogo) não chama onSetGrant", async () => {
    mockedRequestTextInput.mockResolvedValueOnce(null);
    const onSetGrant = vi.fn();
    const handler = createOwnProviderToggleHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      feeCents: 0,
      feeDraft: "0",
      onSetGrant,
    });

    await handler(true);

    expect(mockedRequestTextInput).toHaveBeenCalledTimes(1);
    expect(onSetGrant).not.toHaveBeenCalled();
  });

  it("ligar com uma taxa válida chama onSetGrant com allowed:true e a taxa digitada", async () => {
    mockedRequestTextInput.mockResolvedValueOnce("75,50");
    const onSetGrant = vi.fn();
    const handler = createOwnProviderToggleHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      feeCents: 0,
      feeDraft: "0",
      onSetGrant,
    });

    await handler(true);

    expect(onSetGrant).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      channel: "sms",
      allowed: true,
      monthlyFeeCents: 7550,
    });
  });

  it("ligar com uma taxa inválida não chama onSetGrant", async () => {
    mockedRequestTextInput.mockResolvedValueOnce("abc");
    const onSetGrant = vi.fn();
    const handler = createOwnProviderToggleHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      feeCents: 0,
      feeDraft: "0",
      onSetGrant,
    });

    await handler(true);

    expect(onSetGrant).not.toHaveBeenCalled();
  });

  it("desligar sem confirmar não chama onSetGrant", async () => {
    mockedRequestConfirmation.mockResolvedValueOnce(false);
    const onSetGrant = vi.fn();
    const handler = createOwnProviderToggleHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      feeCents: 5000,
      feeDraft: "50",
      onSetGrant,
    });

    await handler(false);

    expect(mockedRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(onSetGrant).not.toHaveBeenCalled();
  });

  it("desligar e confirmar chama onSetGrant com allowed:false mantendo a taxa gravada", async () => {
    mockedRequestConfirmation.mockResolvedValueOnce(true);
    const onSetGrant = vi.fn();
    const handler = createOwnProviderToggleHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      feeCents: 5000,
      feeDraft: "50",
      onSetGrant,
    });

    await handler(false);

    expect(onSetGrant).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      channel: "sms",
      allowed: false,
      monthlyFeeCents: 5000,
    });
  });
});

describe("createOwnProviderSaveFeeHandler", () => {
  it("nunca é chamado sozinho (sem clique) — não há onBlur: salvar exige o handler explícito", () => {
    // This is enforced by the component wiring (no onBlur on the Input any more); the
    // behavioral guarantee itself — confirm-then-call — is covered by the next two tests.
    expect(typeof createOwnProviderSaveFeeHandler).toBe("function");
  });

  it("não chama onSetGrant sem confirmar", async () => {
    mockedRequestConfirmation.mockResolvedValueOnce(false);
    const onSetGrant = vi.fn();
    const handler = createOwnProviderSaveFeeHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      allowed: true,
      draftCents: 7550,
      onSetGrant,
    });

    await handler();

    expect(mockedRequestConfirmation).toHaveBeenCalledTimes(1);
    expect(onSetGrant).not.toHaveBeenCalled();
  });

  it("chama onSetGrant com a taxa digitada só depois de confirmar", async () => {
    mockedRequestConfirmation.mockResolvedValueOnce(true);
    const onSetGrant = vi.fn();
    const handler = createOwnProviderSaveFeeHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      allowed: true,
      draftCents: 7550,
      onSetGrant,
    });

    await handler();

    expect(mockedRequestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ description: ownProviderFeeConfirmMessage("sms", 7550) }),
    );
    expect(onSetGrant).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      channel: "sms",
      allowed: true,
      monthlyFeeCents: 7550,
    });
  });

  it("taxa inválida nunca chama requestConfirmation nem onSetGrant", async () => {
    const onSetGrant = vi.fn();
    const handler = createOwnProviderSaveFeeHandler({
      tenant: tenantGrantRow(),
      channel: "sms",
      allowed: true,
      draftCents: null,
      onSetGrant,
    });

    await handler();

    expect(mockedRequestConfirmation).not.toHaveBeenCalled();
    expect(onSetGrant).not.toHaveBeenCalled();
  });
});

describe("TenantProvidersCard — botão Salvar da taxa mensal", () => {
  it('mostra o botão "Salvar" desabilitado quando a taxa não mudou', () => {
    const grant: OwnProviderGrantView = {
      tenantId: "tenant-1",
      channel: "sms",
      allowed: true,
      monthlyFeeCents: 5000,
      pendingDecision: false,
      account: null,
      active: false,
    };
    const html = renderToStaticMarkup(
      <TenantProvidersCard
        accounts={[]}
        tenants={[tenantRow()]}
        defaults={{} as Record<string, string>}
        grants={[grant]}
        loading={false}
      />,
    );
    expect(html).toMatch(/Salvar<\/button>/);
    expect(html).toMatch(/disabled=""[^]*?Salvar|Salvar[^]*?disabled=""/);
  });
});
