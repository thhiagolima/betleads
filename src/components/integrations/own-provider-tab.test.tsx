import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: (opts: { mutationFn: (vars: unknown) => unknown }) => ({
    mutate: (vars: unknown) => void opts.mutationFn(vars),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/own-provider.functions", () => ({
  getOwnProviderState: vi.fn(),
  saveOwnProviderAccount: vi.fn(),
  testOwnProviderAccount: vi.fn(),
  activateOwnProvider: vi.fn(),
  deactivateOwnProvider: vi.fn(),
  removeOwnProviderAccount: vi.fn(),
}));
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ children }: { children?: ReactNode }) => <div role="option">{children}</div>,
  };
});

import {
  lastCallbackLabel,
  OwnProviderChannelCard,
  OwnProviderTab,
  showOwnProviderTab,
} from "./own-provider-tab";
import {
  ActivateStepView,
  CredentialsStepView,
  OWN_CREDENTIAL_FIELDS,
  ProviderStepView,
  TestStepView,
  WebhookStepView,
  copyToClipboard,
  credentialHint,
  initialWizardStep,
  nextStep,
  ownConfigFields,
  ownProviderActivationMessages,
  parseOwnUnitCostInput,
  previousStep,
  webhookStepContent,
} from "./own-provider-wizard";
import { ownProviderSendRefusedMessage } from "@/lib/own-provider.shared";
import type { OwnAccountView, OwnProviderChannelState } from "@/lib/own-provider.server";

function account(overrides: Partial<OwnAccountView> = {}): OwnAccountView {
  return {
    id: "acc-1",
    provider: "infobip",
    label: "Infobip da casa",
    status: "active",
    disabledReason: null,
    ownUnitCost: null,
    smsFrom: null,
    voiceFrom: null,
    baseUrl: null,
    lastCallbackAt: null,
    lastAcceptedSendAt: null,
    credentialsSet: [],
    ...overrides,
  };
}

function channelState(overrides: Partial<OwnProviderChannelState> = {}): OwnProviderChannelState {
  return {
    channel: "sms",
    monthlyFeeCents: 5000,
    account: null,
    usingOwnAccount: false,
    callbackUrl: null,
    revoked: false,
    pendingDecision: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Visibilidade da aba

describe("showOwnProviderTab", () => {
  it("esconde quando o servidor recusa (não é admin da casa)", () => {
    expect(showOwnProviderTab(undefined, true)).toBe(false);
    expect(showOwnProviderTab([channelState()], true)).toBe(false);
  });

  it("esconde sem nenhum canal liberado/pausado", () => {
    expect(showOwnProviderTab([], false)).toBe(false);
    expect(showOwnProviderTab(undefined, false)).toBe(false);
  });

  it("mostra com ao menos 1 canal", () => {
    expect(showOwnProviderTab([channelState()], false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card por canal

describe("OwnProviderChannelCard", () => {
  it('sem conta: "Provedor: Plataforma BetLeads" + "Usar minha conta"', () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState()}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toContain("Provedor: Plataforma BetLeads");
    expect(html).toContain("Usar minha conta");
    expect(html).not.toContain("Voltar para a rota da BetLeads");
  });

  it('com conta ativa e ligada: nome do provedor, retorno e "Voltar para a rota da BetLeads"', () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({
          account: account({ provider: "short_brasil", lastCallbackAt: null }),
          usingOwnAccount: true,
        })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toContain("Short Brasil");
    expect(html).toContain("Nenhum retorno recebido ainda — confira o webhook no painel do provedor");
    expect(html).toContain("Voltar para a rota da BetLeads");
    expect(html).not.toContain("Usar minha conta");
  });

  it('com conta ativa e retorno recente: "Último retorno recebido há {x}"', () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({
          account: account({ lastCallbackAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
          usingOwnAccount: true,
        })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toMatch(/Último retorno recebido há \d+ minutos?/);
  });

  it("canal revogado/pausado: sem Usar minha conta; Voltar aparece só se ainda ligado", () => {
    const paused = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({ account: account(), revoked: true, usingOwnAccount: false })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(paused).not.toContain("Usar minha conta");
    expect(paused).not.toContain("Voltar para a rota da BetLeads");
    expect(paused).toContain("pausado");

    const stillLinked = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({ account: account(), revoked: true, usingOwnAccount: true })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(stillLinked).toContain("Voltar para a rota da BetLeads");
  });

  it("pendingDecision mostra o aviso de aguardando decisão", () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({ account: account(), revoked: true, pendingDecision: true })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toContain("aguardando decisão");
  });

  it("conta desativada pela BetLeads mostra o aviso e nenhum botão de ação, sem estar ligada", () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({ account: account({ status: "disabled", disabledReason: "platform" }) })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toContain("Esta conta foi desativada pela BetLeads. Fale com o suporte.");
    expect(html).not.toContain("Voltar para a rota da BetLeads");
    expect(html).not.toContain("Usar minha conta");
  });

  it("conta desativada pela BetLeads mas ainda ligada oferece Voltar para a rota da BetLeads", () => {
    const html = renderToStaticMarkup(
      <OwnProviderChannelCard
        state={channelState({
          account: account({ status: "disabled", disabledReason: "platform" }),
          usingOwnAccount: true,
        })}
        onOpenWizard={() => {}}
        onDeactivate={() => {}}
        deactivating={false}
      />,
    );
    expect(html).toContain("Esta conta foi desativada pela BetLeads. Fale com o suporte.");
    expect(html).toContain("Voltar para a rota da BetLeads");
  });
});

// ---------------------------------------------------------------------------
// Mensagem de erro de conta própria (telas de SMS/e-mail/voz)

describe("ownProviderSendRefusedMessage", () => {
  it("monta a mensagem exata do brief por canal", () => {
    expect(ownProviderSendRefusedMessage("sms")).toBe(
      "Sua conta de SMS recusou o envio. Confira saldo e credenciais em Integrações → Canais.",
    );
    expect(ownProviderSendRefusedMessage("email")).toBe(
      "Sua conta de E-mail recusou o envio. Confira saldo e credenciais em Integrações → Canais.",
    );
    expect(ownProviderSendRefusedMessage("voice")).toBe(
      "Sua conta de Voz recusou o envio. Confira saldo e credenciais em Integrações → Canais.",
    );
  });
});

// ---------------------------------------------------------------------------
// Assistente — passos puros

describe("initialWizardStep / nextStep / previousStep", () => {
  it("sem conta começa em provedor; com conta começa em webhook", () => {
    expect(initialWizardStep(null)).toBe("provedor");
    expect(initialWizardStep(account())).toBe("webhook");
  });

  it("avança e volta na ordem fixa", () => {
    expect(nextStep("provedor")).toBe("credenciais");
    expect(nextStep("credenciais")).toBe("webhook");
    expect(nextStep("webhook")).toBe("testar");
    expect(nextStep("testar")).toBe("ativar");
    expect(nextStep("ativar")).toBe("ativar");
    expect(previousStep("ativar")).toBe("testar");
    expect(previousStep("provedor")).toBe("provedor");
  });
});

describe("ownConfigFields", () => {
  it("Short Brasil nunca mostra campo de URL", () => {
    expect(ownConfigFields("short_brasil", "sms")).toEqual([]);
  });

  it("Infobip SMS mostra URL base + remetente (sms_from)", () => {
    const fields = ownConfigFields("infobip", "sms");
    expect(fields.map((f) => f.key)).toEqual(["base_url", "sms_from"]);
  });

  it("Infobip voz mostra URL base + remetente (voice_from)", () => {
    const fields = ownConfigFields("infobip", "voice");
    expect(fields.map((f) => f.key)).toEqual(["base_url", "voice_from"]);
  });

  it("Infobip e-mail mostra só a URL base (sem remetente)", () => {
    const fields = ownConfigFields("infobip", "email");
    expect(fields.map((f) => f.key)).toEqual(["base_url"]);
  });
});

describe("OWN_CREDENTIAL_FIELDS", () => {
  it("nunca inclui OneSignal", () => {
    expect(Object.keys(OWN_CREDENTIAL_FIELDS)).toEqual(["short_brasil", "infobip"]);
  });
});

describe("credentialHint", () => {
  it('mostra "Salvo — preencha só para substituir" quando a credencial já foi gravada', () => {
    expect(credentialHint("api_key", ["api_key"])).toBe("Salvo — preencha só para substituir");
    expect(credentialHint("api_key", [])).toBeUndefined();
  });
});

describe("webhookStepContent", () => {
  it("Short Brasil: URL própria, sem nota", () => {
    expect(webhookStepContent("short_brasil", "https://betleads.io/api/public/sms-webhook/pa_x")).toEqual({
      url: "https://betleads.io/api/public/sms-webhook/pa_x",
      note: null,
    });
  });

  it('Infobip: sem URL, com a nota "A URL vai automaticamente em cada envio."', () => {
    expect(webhookStepContent("infobip", null)).toEqual({
      url: null,
      note: "A URL vai automaticamente em cada envio.",
    });
  });
});

describe("ownProviderActivationMessages", () => {
  it("sms/voz: as duas mensagens fixas, com a taxa formatada em R$", () => {
    expect(ownProviderActivationMessages("sms", 5000)).toEqual([
      "Sem troca automática: se sua conta falhar, os envios deste canal pausam.",
      "A BetLeads deixa de cobrar por envio neste canal; a taxa mensal de R$ 50,00 entra na próxima fatura.",
    ]);
    expect(ownProviderActivationMessages("voice", 0)).toHaveLength(2);
  });

  it("e-mail: as duas mensagens fixas + o aviso de domínios de e-mail", () => {
    const messages = ownProviderActivationMessages("email", 1000);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toBe(
      "Seus domínios de e-mail voltam a pendente e precisam dos novos registros DNS.",
    );
  });
});

describe("parseOwnUnitCostInput", () => {
  it("vazio mantém o valor gravado (undefined)", () => {
    expect(parseOwnUnitCostInput("")).toBeUndefined();
    expect(parseOwnUnitCostInput("   ")).toBeUndefined();
  });

  it("aceita vírgula e ponto", () => {
    expect(parseOwnUnitCostInput("0,059")).toBeCloseTo(0.059);
    expect(parseOwnUnitCostInput("0.059")).toBeCloseTo(0.059);
  });

  it("rejeita negativo e não numérico", () => {
    expect(parseOwnUnitCostInput("-1")).toBeNull();
    expect(parseOwnUnitCostInput("abc")).toBeNull();
  });
});

describe("copyToClipboard", () => {
  it("sem navigator.clipboard, mostra o erro de cópia", async () => {
    const original = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const { toast } = await import("sonner");
    copyToClipboard("texto", "ok");
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
  });
});

// ---------------------------------------------------------------------------
// Assistente — etapas na ordem (provedor -> credenciais/remetente/custo ->
// webhook -> testar -> ativar com senha)

describe("ProviderStepView (etapa 1 — Provedor)", () => {
  it("lista os provedores do canal", () => {
    const html = renderToStaticMarkup(
      <ProviderStepView
        channel="sms"
        providers={["short_brasil", "infobip"]}
        provider="short_brasil"
        label=""
        lockProvider={false}
        onProviderChange={() => {}}
        onLabelChange={() => {}}
        onNext={() => {}}
      />,
    );
    expect(html).toContain("Short Brasil");
    expect(html).toContain("Infobip");
    expect(html).toContain("Nome da conta");
  });
});

describe("CredentialsStepView (etapa 2 — credenciais/remetente/custo)", () => {
  it("SMS mostra o campo de custo por SMS; e-mail não", () => {
    const sms = renderToStaticMarkup(
      <CredentialsStepView
        channel="sms"
        provider="infobip"
        config={{}}
        credentials={{}}
        credentialsSet={[]}
        ownUnitCost=""
        password=""
        saving={false}
        onConfigChange={() => {}}
        onCredentialsChange={() => {}}
        onOwnUnitCostChange={() => {}}
        onPasswordChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(sms).toContain("Custo por SMS na sua conta (R$)");

    const email = renderToStaticMarkup(
      <CredentialsStepView
        channel="email"
        provider="infobip"
        config={{}}
        credentials={{}}
        credentialsSet={[]}
        ownUnitCost=""
        password=""
        saving={false}
        onConfigChange={() => {}}
        onCredentialsChange={() => {}}
        onOwnUnitCostChange={() => {}}
        onPasswordChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(email).not.toContain("Custo por SMS na sua conta (R$)");
  });

  it('campos de credencial já salvos mostram "Salvo — preencha só para substituir" e vêm vazios', () => {
    const html = renderToStaticMarkup(
      <CredentialsStepView
        channel="sms"
        provider="infobip"
        config={{}}
        credentials={{}}
        credentialsSet={["api_key"]}
        ownUnitCost=""
        password=""
        saving={false}
        onConfigChange={() => {}}
        onCredentialsChange={() => {}}
        onOwnUnitCostChange={() => {}}
        onPasswordChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain("Salvo — preencha só para substituir");
    expect(html).toMatch(/id="own-cred-api_key"[^>]*value=""/);
  });
});

describe("WebhookStepView (etapa 3 — webhook)", () => {
  it("Short Brasil: mostra a URL com botão Copiar", () => {
    const html = renderToStaticMarkup(
      <WebhookStepView
        provider="short_brasil"
        callbackUrl="https://betleads.io/api/public/sms-webhook/pa_x"
        onNext={() => {}}
      />,
    );
    expect(html).toContain("https://betleads.io/api/public/sms-webhook/pa_x");
    expect(html).toContain("Copiar");
  });

  it('Infobip: sem URL, mostra "A URL vai automaticamente em cada envio."', () => {
    const html = renderToStaticMarkup(
      <WebhookStepView provider="infobip" callbackUrl={null} onNext={() => {}} />,
    );
    expect(html).toContain("A URL vai automaticamente em cada envio.");
    expect(html).not.toContain("Copiar");
  });
});

describe("TestStepView (etapa 4 — testar)", () => {
  it("Short Brasil pede o celular do teste; Infobip não", () => {
    const shortBrasil = renderToStaticMarkup(
      <TestStepView
        provider="short_brasil"
        testPhone=""
        testing={false}
        onTestPhoneChange={() => {}}
        onTest={() => {}}
        onNext={() => {}}
      />,
    );
    expect(shortBrasil).toContain("Celular que recebe o teste");

    const infobip = renderToStaticMarkup(
      <TestStepView
        provider="infobip"
        testPhone=""
        testing={false}
        onTestPhoneChange={() => {}}
        onTest={() => {}}
        onNext={() => {}}
      />,
    );
    expect(infobip).not.toContain("Celular que recebe o teste");
    expect(infobip).toContain("Testar");
  });
});

describe("ActivateStepView (etapa 5 — ativar com senha)", () => {
  it("lista as mensagens de confirmação e pede a senha", () => {
    const html = renderToStaticMarkup(
      <ActivateStepView
        channel="email"
        monthlyFeeCents={2500}
        password=""
        activating={false}
        onPasswordChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain("Sem troca automática: se sua conta falhar, os envios deste canal pausam.");
    expect(html).toContain(
      "A BetLeads deixa de cobrar por envio neste canal; a taxa mensal de R$ 25,00 entra na próxima fatura.",
    );
    expect(html).toContain("Seus domínios de e-mail voltam a pendente e precisam dos novos registros DNS.");
    expect(html).toContain("Sua senha");
    expect(html).toContain("Ativar");
  });
});

// ---------------------------------------------------------------------------
// OwnProviderTab (contêiner) — estado vazio / carregando, sem servidor real

describe("OwnProviderTab", () => {
  it("renderiza sem quebrar quando não há canais (estado de carregamento mockado)", () => {
    expect(() => renderToStaticMarkup(<OwnProviderTab />)).not.toThrow();
  });
});
