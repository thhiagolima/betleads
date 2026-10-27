import { describe, expect, it } from "vitest";
import {
  hasLinkDomainWork,
  planLinkDomainChange,
  type LinkDomainPreview,
  type LinkDomainSources,
} from "./link-domain-plan";

function sources(overrides: Partial<LinkDomainSources> = {}): LinkDomainSources {
  return {
    journeySteps: [],
    smsTemplates: [],
    emailTemplates: [],
    quickLinks: [],
    trackingHosts: [],
    scheduledCampaigns: [],
    activeLegacyFlows: [],
    ...overrides,
  };
}

// A domain much longer than "casa-antiga.com" (15 chars) so swaps can be made
// to cross the 480/1600-char limits (see controller Ruling 1).
const LONG_TO = "dominio-novo-bem-mais-longo-que-o-anterior.com"; // 47 chars

describe("planLinkDomainChange", () => {
  it("erro quando os domínios são iguais", () => {
    expect(planLinkDomainChange(sources(), "www.casa.com", "https://casa.com/x")).toEqual({
      ok: false,
      error: "Os dois domínios são iguais.",
    });
  });

  it("erro quando o domínio é inválido", () => {
    const result = planLinkDomainChange(sources(), " ", "casa-nova.com");
    expect(result.ok).toBe(false);
  });

  it("etapa SMS: troca content, variants e template_snapshot.content no config", () => {
    const config = {
      content: "A https://casa-antiga.com/a",
      variants: ["B https://casa-antiga.com/b"],
      template_snapshot: { id: "tpl1", content: "A https://casa-antiga.com/a", version: 2 },
      track_links: true,
    };
    const result = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step1",
            journeyId: "j1",
            journeyName: "Jornada X",
            journeyStatus: "active",
            position: 1,
            stepType: "sms",
            label: null,
            config,
          },
        ],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect(item.key).toBe("journey_step:step1");
    expect(item.kind).toBe("journey_step");
    expect(item.title).toBe("Jornada X");
    expect(item.detail).toBe("Etapa 2 · SMS");
    expect(item.replacements).toBe(3);
    expect(item.blockedReason).toBeNull();
    expect(item.update.config).toEqual({
      content: "A https://casa-nova.com/a",
      variants: ["B https://casa-nova.com/b"],
      template_snapshot: { id: "tpl1", content: "A https://casa-nova.com/a", version: 2 },
      track_links: true,
    });
    expect(item.previous.config).toEqual(config);
  });

  it("etapa de e-mail: troca template_snapshot.subject e body_html", () => {
    const config = {
      template_snapshot: {
        subject: "Promo https://casa-antiga.com/a",
        body_html: '<a href="https://casa-antiga.com/b">clique</a>',
      },
    };
    const result = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step2",
            journeyId: "j2",
            journeyName: "Jornada Y",
            journeyStatus: "draft",
            position: 0,
            stepType: "email",
            label: null,
            config,
          },
        ],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect(item.detail).toBe("Etapa 1 · E-mail");
    expect(item.replacements).toBe(2);
    expect(item.update.config).toEqual({
      template_snapshot: {
        subject: "Promo https://casa-nova.com/a",
        body_html: '<a href="https://casa-nova.com/b">clique</a>',
      },
    });
  });

  it("etapa sem ocorrência não vira item", () => {
    const result = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step3",
            journeyId: "j3",
            journeyName: "Jornada Z",
            journeyStatus: "active",
            position: 0,
            stepType: "sms",
            label: null,
            config: { content: "sem link nenhum" },
          },
        ],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(0);
  });

  it("template SMS acima de 480 fica bloqueado", () => {
    const content = `${"x".repeat(450)} https://casa-antiga.com`; // 450 + 1 + 23 = 474 chars
    expect(content.length).toBe(474);
    const result = planLinkDomainChange(
      sources({ smsTemplates: [{ id: "tpl1", name: "Template 1", content }] }),
      "casa-antiga.com",
      LONG_TO,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect(item.update.content as string).toHaveLength(450 + 1 + 8 + LONG_TO.length);
    expect((item.update.content as string).length).toBeGreaterThan(480);
    expect(item.blockedReason).toBe("O texto passaria de 480 caracteres.");
  });

  it("SMS de jornada acima de 1600 fica bloqueado", () => {
    const content = `${"x".repeat(1570)} https://casa-antiga.com`; // 1570 + 1 + 23 = 1594 chars
    expect(content.length).toBe(1594);
    const result = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step4",
            journeyId: "j4",
            journeyName: "Jornada Grande",
            journeyStatus: "active",
            position: 0,
            stepType: "sms",
            label: null,
            config: { content },
          },
        ],
      }),
      "casa-antiga.com",
      LONG_TO,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect((item.update.config as { content: string }).content.length).toBeGreaterThan(1600);
    expect(item.blockedReason).toBe("O texto passaria de 1600 caracteres.");
  });

  it("aviso de segmentos só com track_links === false e quando aumenta", () => {
    const content = `${"x".repeat(132)} https://casa-antiga.com`; // 132 + 1 + 23 = 156 units (1 segment)
    expect(content.length).toBe(156);
    const to = "casa-nova-dominio.com.br"; // 24 chars, pushes total past 160

    const withWarning = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step5",
            journeyId: "j5",
            journeyName: "Jornada Segmento",
            journeyStatus: "active",
            position: 0,
            stepType: "sms",
            label: null,
            config: { content, track_links: false },
          },
        ],
      }),
      "casa-antiga.com",
      to,
    );
    expect(withWarning.ok).toBe(true);
    if (!withWarning.ok) throw new Error("expected ok");
    expect(withWarning.preview.items[0].segmentWarning).toEqual({ before: 1, after: 2 });

    const withoutWarning = planLinkDomainChange(
      sources({
        journeySteps: [
          {
            id: "step6",
            journeyId: "j6",
            journeyName: "Jornada Segmento",
            journeyStatus: "active",
            position: 0,
            stepType: "sms",
            label: null,
            config: { content, track_links: true },
          },
        ],
      }),
      "casa-antiga.com",
      to,
    );
    expect(withoutWarning.ok).toBe(true);
    if (!withoutWarning.ok) throw new Error("expected ok");
    expect(withoutWarning.preview.items[0].segmentWarning).toBeNull();
  });

  it("template de e-mail: troca subject, preheader, body_html, body_text", () => {
    const result = planLinkDomainChange(
      sources({
        emailTemplates: [
          {
            id: "email1",
            name: "Template E-mail",
            subject: "Oferta https://casa-antiga.com/s",
            preheader: "Veja https://casa-antiga.com/p",
            body_html: '<a href="https://casa-antiga.com/h">clique</a>',
            body_text: "Acesse https://casa-antiga.com/t",
          },
        ],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect(item.replacements).toBe(4);
    expect(item.update).toEqual({
      subject: "Oferta https://casa-nova.com/s",
      preheader: "Veja https://casa-nova.com/p",
      body_html: '<a href="https://casa-nova.com/h">clique</a>',
      body_text: "Acesse https://casa-nova.com/t",
    });
    expect(item.previous).toEqual({
      subject: "Oferta https://casa-antiga.com/s",
      preheader: "Veja https://casa-antiga.com/p",
      body_html: '<a href="https://casa-antiga.com/h">clique</a>',
      body_text: "Acesse https://casa-antiga.com/t",
    });
  });

  it("link rápido absoluto é trocado; relativo é ignorado", () => {
    const result = planLinkDomainChange(
      sources({
        quickLinks: [
          { id: "ql1", label: "Link absoluto", path: "https://casa-antiga.com/promo" },
          { id: "ql2", label: "Link relativo", path: "/promo" },
        ],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.items).toHaveLength(1);
    const item = result.preview.items[0];
    expect(item.kind).toBe("quick_link");
    expect(item.update).toEqual({ path: "https://casa-nova.com/promo" });
    expect(item.previous).toEqual({ path: "https://casa-antiga.com/promo" });
  });

  it("rastreio: lista vazia → null; lista sem o novo → adiciona mantendo o antigo", () => {
    const plan = (trackingHosts: string[] | null) =>
      planLinkDomainChange(sources({ trackingHosts }), "casa-antiga.com", "casa-nova.com");

    const withOld = plan(["casa-antiga.com"]);
    expect(withOld.ok).toBe(true);
    if (!withOld.ok) throw new Error("expected ok");
    expect(withOld.preview.trackingHosts).toEqual({
      current: ["casa-antiga.com"],
      next: ["casa-antiga.com", "casa-nova.com"],
    });

    const withOther = plan(["outra.com"]);
    expect(withOther.ok).toBe(true);
    if (!withOther.ok) throw new Error("expected ok");
    expect(withOther.preview.trackingHosts).toEqual({
      current: ["outra.com"],
      next: ["outra.com", "casa-nova.com"],
    });

    const withNew = plan(["casa-nova.com"]);
    expect(withNew.ok).toBe(true);
    if (!withNew.ok) throw new Error("expected ok");
    expect(withNew.preview.trackingHosts).toBeNull();

    const empty = plan([]);
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error("expected ok");
    expect(empty.preview.trackingHosts).toBeNull();

    const none = plan(null);
    expect(none.ok).toBe(true);
    if (!none.ok) throw new Error("expected ok");
    expect(none.preview.trackingHosts).toBeNull();
  });

  it("outOfScope lista campanhas agendadas e fluxos legados que têm o domínio antigo e conta subdomínios", () => {
    const result = planLinkDomainChange(
      sources({
        scheduledCampaigns: [
          { id: "c1", name: "Campanha Com Link", channel: "sms", text: "Veja https://casa-antiga.com/promo" },
          { id: "c2", name: "Campanha Sem Link", channel: "email", text: "Sem link nenhum" },
        ],
        activeLegacyFlows: [
          { id: "f1", name: "Fluxo Com Link", text: "Oi https://casa-antiga.com/x" },
          { id: "f2", name: "Fluxo Sem Link", text: "Nada aqui" },
        ],
        smsTemplates: [
          { id: "tpl1", name: "Template com subdomínio", content: "Veja https://go.casa-antiga.com/promo" },
        ],
        quickLinks: [{ id: "ql1", label: "Outro subdomínio", path: "https://app.casa-antiga.com/painel" }],
      }),
      "casa-antiga.com",
      "casa-nova.com",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.preview.outOfScope.scheduledCampaigns).toEqual([
      { id: "c1", name: "Campanha Com Link", channel: "sms" },
    ]);
    expect(result.preview.outOfScope.legacyFlows).toEqual([{ id: "f1", name: "Fluxo Com Link" }]);
    expect(result.preview.outOfScope.subdomainLinks).toBe(2);
  });

  it("hasLinkDomainWork é true só com itens ou rastreio", () => {
    const base: LinkDomainPreview = {
      from: "casa-antiga.com",
      to: "casa-nova.com",
      items: [],
      trackingHosts: null,
      outOfScope: { scheduledCampaigns: [], legacyFlows: [], subdomainLinks: 0 },
    };
    expect(hasLinkDomainWork(base)).toBe(false);
    expect(
      hasLinkDomainWork({
        ...base,
        items: [
          {
            key: "quick_link:ql1",
            kind: "quick_link",
            id: "ql1",
            title: "Link",
            detail: null,
            replacements: 1,
            sample: { before: "", after: "" },
            blockedReason: null,
            segmentWarning: null,
            update: { path: "https://casa-nova.com/x" },
            previous: { path: "https://casa-antiga.com/x" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasLinkDomainWork({
        ...base,
        trackingHosts: { current: ["casa-antiga.com"], next: ["casa-antiga.com", "casa-nova.com"] },
      }),
    ).toBe(true);
  });
});
