// Content model + pure progress calculation for the help panel's "Guias
// passo a passo" (brief, Task 6). Plain typed data, like help/types.ts, so
// it can be unit-tested without a server or DOM. The signals themselves come
// from `getGuideSignals` (src/lib/help-guides.functions.ts); this module
// never talks to the database.
import type { HelpRole } from "./types";

export type GuideSignals = {
  shortenerAdded: boolean;
  shortenerVerified: boolean;
  shortenerDefault: boolean;
  emailDomainAdded: boolean;
  emailDomainVerified: boolean;
  verifiedSender: boolean;
  publishedEmailTemplate: boolean;
  emailCampaignSent: boolean;
  journeySaved: boolean;
  journeyActive: boolean;
  journeyHasEntries: boolean;
};

/** Every signal false — the state of a house that hasn't done anything yet. */
export const EMPTY_SIGNALS: GuideSignals = {
  shortenerAdded: false,
  shortenerVerified: false,
  shortenerDefault: false,
  emailDomainAdded: false,
  emailDomainVerified: false,
  verifiedSender: false,
  publishedEmailTemplate: false,
  emailCampaignSent: false,
  journeySaved: false,
  journeyActive: false,
  journeyHasEntries: false,
};

export type GuideStep = {
  id: string;
  title: string;
  route: string;
  tab?: string;
  /** The element to highlight once `route`(`#tab`) has loaded. Left
   * undefined when the target screen doesn't declare that `tourAnchor` yet
   * (see the task report — later article tasks fill these in). */
  anchor?: string;
  substeps: string[];
  signal: keyof GuideSignals;
};

export type Guide = {
  id: string;
  title: string;
  requiresRole?: HelpRole;
  steps: GuideStep[];
};

export type GuideView = Guide & {
  doneCount: number;
  total: number;
  stepDone: boolean[];
};

export const GUIDES: Guide[] = [
  {
    id: "encurtador",
    title: "Configurar o encurtador de links",
    requiresRole: "admin",
    steps: [
      {
        id: "shortener-added",
        title: "Adicione o domínio do encurtador",
        route: "/configuracoes/casa",
        tab: "encurtador",
        anchor: "casa.encurtador.add-domain",
        substeps: [],
        signal: "shortenerAdded",
      },
      {
        id: "shortener-verified",
        title: "Verifique o domínio",
        route: "/configuracoes/casa",
        tab: "encurtador",
        anchor: "casa.dominio.dns-table",
        substeps: [
          "Copiar os registros DNS",
          "Colar no site onde o domínio foi comprado",
          "Aguardar a verificação automática",
        ],
        signal: "shortenerVerified",
      },
      {
        id: "shortener-default",
        title: "Marque o domínio como padrão",
        route: "/configuracoes/casa",
        tab: "encurtador",
        anchor: "casa.dominio.set-default",
        substeps: [],
        signal: "shortenerDefault",
      },
    ],
  },
  {
    id: "primeiro-email",
    title: "Enviar o primeiro e-mail",
    requiresRole: "admin",
    steps: [
      {
        id: "email-domain-added",
        title: "Adicione o domínio de e-mail",
        route: "/configuracoes/casa",
        tab: "email",
        anchor: "casa.email.add-domain",
        substeps: [],
        signal: "emailDomainAdded",
      },
      {
        id: "email-domain-verified",
        title: "Verifique o domínio",
        route: "/configuracoes/casa",
        tab: "email",
        anchor: "casa.dominio.dns-table",
        substeps: [
          "Copiar os registros DNS",
          "Colar no site onde o domínio foi comprado",
          "Aguardar a verificação automática",
        ],
        signal: "emailDomainVerified",
      },
      {
        id: "verified-sender",
        title: "Cadastre um remetente",
        route: "/configuracoes/casa",
        tab: "email",
        anchor: "casa.remetente.save",
        substeps: [],
        signal: "verifiedSender",
      },
      {
        id: "published-email-template",
        title: "Publique um template de e-mail",
        route: "/email",
        tab: "templates",
        anchor: "email.templates.novo",
        substeps: [],
        signal: "publishedEmailTemplate",
      },
      {
        id: "email-campaign-sent",
        title: "Envie a campanha",
        route: "/campanhas",
        anchor: "campanhas.hub.nova-campanha",
        substeps: ["Mandar um envio de teste antes"],
        signal: "emailCampaignSent",
      },
    ],
  },
  {
    id: "primeira-jornada",
    title: "Criar a primeira jornada",
    steps: [
      {
        id: "journey-saved",
        title: "Salve a jornada",
        route: "/jornadas/nova",
        anchor: "jornada.rodape.salvar",
        substeps: ["gatilho", "público e reentrada", "etapas", "saída", "limites"],
        signal: "journeySaved",
      },
      {
        id: "journey-active",
        title: "Ative a jornada",
        route: "/automacoes",
        anchor: "automacoes.jornadas.pausar-ativar",
        substeps: [],
        signal: "journeyActive",
      },
      {
        id: "journey-has-entries",
        title: "Aguarde as primeiras entradas",
        route: "/automacoes",
        anchor: "automacoes.jornadas.relatorio",
        substeps: ["Acompanhar no relatório"],
        signal: "journeyHasEntries",
      },
    ],
  },
];

/**
 * A guide's progress for `signals`: each step is "done" either on its own
 * signal, or because a later step's signal is already true (completing a
 * later step always implies the earlier ones happened too).
 */
export function computeGuideView(guide: Guide, signals: GuideSignals): GuideView {
  const total = guide.steps.length;
  const stepDone = new Array<boolean>(total).fill(false);
  let laterDone = false;
  for (let i = total - 1; i >= 0; i--) {
    const own = signals[guide.steps[i].signal];
    stepDone[i] = own || laterDone;
    if (own) laterDone = true;
  }
  const doneCount = stepDone.filter(Boolean).length;
  return { ...guide, doneCount, total, stepDone };
}
