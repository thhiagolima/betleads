import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Data by query key (what each useQuery returns) ──────────────────────────
const queryData: Record<string, unknown> = {};
const sourceState = { isExpert: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => ({
    data: enabled === false ? undefined : queryData[String(queryKey[0])],
    isSuccess: enabled !== false && String(queryKey[0]) in queryData,
    isError: false,
    isLoading: false,
    isFetching: false,
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock("@/hooks/use-campaign-data-source", () => ({
  useCampaignDataSource: () => ({
    kind: sourceState.isExpert ? "expert" : "house",
    isExpert: sourceState.isExpert,
    queryKeys: sourceState.isExpert
      ? {
          audiences: ["expert-audiences"],
          drafts: ["expert-campaign-drafts"],
          draft: (id: string | null) => ["expert-campaign-draft", id],
        }
      : {
          audiences: ["sms-audiences"],
          drafts: ["campaign-drafts"],
          draft: (id: string | null) => ["campaign-draft", id],
        },
    listAudiences: vi.fn(),
    saveAudience: vi.fn(),
    deleteAudience: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
    submitDraft: vi.fn(),
  }),
}));

// Server function modules (never loaded for real here).
vi.mock("@/lib/calls.functions", () => ({ bulkDispatchCalls: vi.fn(), listCallScripts: vi.fn() }));
vi.mock("@/lib/campaign-drafts.functions", () => ({}));
vi.mock("@/lib/email.functions", () => ({
  listEmailTemplates: vi.fn(),
  saveEmailCampaign: vi.fn(),
  saveEmailTemplate: vi.fn(),
  sendEmailCampaignNow: vi.fn(),
}));
vi.mock("@/lib/billing/billing.functions", () => ({ getBillingPrices: vi.fn() }));
vi.mock("@/lib/journey-voice-assets.functions", () => ({ listJourneyVoiceAssets: vi.fn() }));
vi.mock("@/lib/sms-audiences.functions", () => ({ resolveCampaignAudience: vi.fn() }));
vi.mock("@/lib/sms-templates.functions", () => ({ listSmsTemplates: vi.fn() }));
vi.mock("@/lib/sms.functions", () => ({
  previewSmsCampaignRecipients: vi.fn(),
  scheduleBulkSms: vi.fn(),
  sendBulkSms: vi.fn(),
}));
vi.mock("@/lib/house-config.functions", () => ({ getComposerOptions: vi.fn() }));
vi.mock("@/lib/expert-campaigns.functions", () => ({
  bulkDispatchExpertCalls: vi.fn(),
  getExpertCampaignUsage: vi.fn(),
  getExpertComposerOptions: vi.fn(),
  resolveExpertCampaignAudience: vi.fn(),
  saveExpertEmailCampaign: vi.fn(),
  scheduleExpertBulkSms: vi.fn(),
  sendExpertBulkSms: vi.fn(),
}));
vi.mock("@/lib/expert-templates.functions", () => ({ listExpertTemplates: vi.fn() }));

// UI that needs a browser (portals) or its own queries.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Pass,
    SelectContent: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectItem: ({ children }: { children?: ReactNode }) => <div role="option">{children}</div>,
  };
});
vi.mock("@/components/sms/sms-template-dialog", () => ({ SmsTemplateDialog: () => null }));
vi.mock("@/components/ligacoes/script-form-dialog", () => ({ ScriptFormDialog: () => null }));
vi.mock("@/components/ligacoes/voice-asset-upload-dialog", () => ({
  VoiceAssetUploadDialog: () => null,
}));
vi.mock("@/components/email/template-editor-dialog", () => ({ TemplateEditorDialog: () => null }));
vi.mock("@/components/message-variable-picker", () => ({ MessageVariablePicker: () => null }));
vi.mock("@/components/house-config/link-insert-menu", () => ({ LinkInsertMenu: () => null }));
vi.mock("@/components/system-dialog-host", () => ({
  requestConfirmation: vi.fn(),
  requestTextInput: vi.fn(),
}));

import { ChannelCampaignComposer, EXPERT_APPROVAL_NOTICE } from "./channel-campaign-composer";

const render = (channel: "sms" | "email" | "voice" = "sms") =>
  renderToStaticMarkup(
    <ChannelCampaignComposer
      open
      onOpenChange={() => undefined}
      onCreated={() => undefined}
      initialChannel={channel}
    />,
  ).replace(/\u00a0/g, " ");

const expertOptions = (envioModo: "livre" | "aprovacao") => ({
  siteUrl: null,
  quickLinks: [],
  shortDomains: [],
  shortenerPending: false,
  senders: [],
  emailTemplates: [{ id: "t1", nome: "Boas-vindas", assunto: "Olá" }],
  callScripts: [],
  voiceAssets: [],
  prices: { sms: 0.08, email: 0.01, voice_30s: 0.5 },
  envioModo,
});

beforeEach(() => {
  for (const key of Object.keys(queryData)) delete queryData[key];
});

describe("ChannelCampaignComposer — house", () => {
  beforeEach(() => {
    sourceState.isExpert = false;
    queryData["house-config-composer-options"] = undefined;
  });

  it("keeps the house-only controls", () => {
    const sms = render("sms");
    expect(sms).toContain("Lista de números · quem ainda não é jogador");
    expect(sms).toContain("Domínio do encurtador");
    expect(sms).toContain("Novo template");
    expect(sms).not.toContain(EXPERT_APPROVAL_NOTICE);
    expect(sms).not.toContain("Restante do teto");
    expect(render("email")).toContain("Remetente");
  });
});

describe("ChannelCampaignComposer — expert", () => {
  beforeEach(() => {
    sourceState.isExpert = true;
    queryData["expert-campaign-usage"] = {
      teto: 100,
      usado: 20,
      restante: 80,
      pendentes: 0,
      pendentesEstimado: 0,
      mes: "2026-10",
    };
  });

  it("hides the external list, sender, short domain, template creation and wallet wording", () => {
    queryData["expert-composer-options"] = expertOptions("livre");
    const sms = render("sms");
    expect(sms).not.toContain("Lista de números");
    expect(sms).not.toContain("Domínio do encurtador");
    expect(sms).not.toContain("Novo template");
    expect(sms).not.toContain("casa isenta");
    expect(sms).not.toContain("Casa isenta");
    expect(sms).toContain("Custo estimado");
    expect(sms).toContain("Restante do teto após este envio: R$ 80,00");
    expect(sms).toContain('aria-live="polite"');

    const email = render("email");
    expect(email).not.toContain("Remetente");
    expect(email).not.toContain("Domínio do encurtador");
    expect(email).not.toContain("Novo template");
    expect(email).toContain("Boas-vindas");
    expect(email).toContain("Templates publicados da casa");

    const voice = render("voice");
    expect(voice).not.toContain("Enviar áudio");
    expect(voice).not.toContain("Novo roteiro");
  });

  it("free mode: the button says who receives and the estimated cost", () => {
    queryData["expert-composer-options"] = expertOptions("livre");
    const html = render("sms");
    expect(html).toContain("Enviar para 0 leads · R$ 0,00");
    expect(html).not.toContain("Enviar para aprovação");
    expect(html).not.toContain(EXPERT_APPROVAL_NOTICE);
  });

  it("approval mode: 'Enviar para aprovação' with the approval notice", () => {
    queryData["expert-composer-options"] = expertOptions("aprovacao");
    const html = render("sms");
    expect(html).toContain("Enviar para aprovação");
    expect(html).toContain(EXPERT_APPROVAL_NOTICE);
    expect(html).toContain('campaign-approval-notice campaign-cost"');
  });

  it("cap R$ 0 disables the submit and explains why", () => {
    queryData["expert-composer-options"] = expertOptions("livre");
    queryData["expert-campaign-usage"] = {
      teto: 0,
      usado: 0,
      restante: 0,
      pendentes: 0,
      pendentesEstimado: 0,
      mes: "2026-10",
    };
    const html = render("sms");
    expect(html).toContain("Seus envios estão bloqueados: o teto mensal é R$ 0,00.");
  });

  it("labels house and system audiences for the expert", () => {
    queryData["expert-composer-options"] = expertOptions("livre");
    queryData["expert-audiences"] = [
      { id: "a1", name: "Meus VIPs", criteria: {}, owner: "meu", readOnly: false },
      { id: "a2", name: "Ouro parado", criteria: {}, owner: "casa", readOnly: true },
    ];
    const html = render("sms");
    expect(html).toContain("Meus VIPs");
    expect(html).toContain("Da casa · Ouro parado");
    expect(html).toContain("(dos seus leads)");
  });
});
