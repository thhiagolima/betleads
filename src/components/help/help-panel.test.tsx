import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HelpScreen } from "@/help/types";
import { HelpPanelView, type HelpPanelViewProps } from "./help-panel";

// No jsdom here: HelpPanelView is the presentational part of the panel (no
// Sheet/portal), so renderToStaticMarkup captures all of it.

const screen: HelpScreen = {
  id: "casa-email",
  route: "/configuracoes/casa",
  title: "Configuração da casa · E-mail",
  purpose: "Onde você conecta o domínio que envia os e-mails da casa.",
  roles: ["admin", "gestor"],
  sections: [
    {
      id: "dominio",
      title: "Domínio de envio",
      tab: "email",
      items: [
        { anchor: "casa.email.add-domain", label: "Adicionar domínio", what: "Abre o cadastro." },
        { label: "Apagar remetente", what: "Remove o remetente.", roles: ["admin"] },
      ],
    },
  ],
  states: [{ id: "vazio", title: "Nenhum domínio", what: "Você ainda não conectou." }],
  tours: { default: [{ anchor: "casa.email.add-domain", title: "t", body: "b" }] },
};

const noop = () => {};

function render(overrides: Partial<HelpPanelViewProps> = {}) {
  const props: HelpPanelViewProps = {
    screen,
    role: "gestor",
    currentTab: "email",
    glossary: [{ id: "ggr", term: "GGR", short: "Perdas na casa." }],
    query: "",
    results: [],
    autoToursOff: false,
    articleOpen: true,
    highlightTermId: null,
    onQueryChange: noop,
    onSelectResult: noop,
    onStartTour: noop,
    onToggleArticle: noop,
    onShowAnchor: noop,
    onAutoToursOffChange: noop,
    onOpenShellArticle: noop,
    ...overrides,
  };
  return renderToStaticMarkup(<HelpPanelView {...props} />);
}

describe("HelpPanelView", () => {
  it("shows the screen help, guides and glossary labels", () => {
    const html = render();
    for (const label of [
      "Nesta tela",
      "Fazer o tour desta tela",
      "Ver todos os botões e campos",
      "Guias passo a passo",
      "Glossário",
      "Não mostrar tours automaticamente",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain(screen.title);
    expect(html).toContain(screen.purpose);
  });

  it("shows the article's items, states and a 'mostrar na tela' link when expanded", () => {
    const html = render();
    expect(html).toContain("Adicionar domínio");
    expect(html).toContain("mostrar na tela");
    expect(html).toContain("Nenhum domínio");
    expect(render({ articleOpen: false })).not.toContain("Adicionar domínio");
  });

  it("hides an item restricted to admin from gestor", () => {
    expect(render({ role: "gestor" })).not.toContain("Apagar remetente");
    expect(render({ role: "admin" })).toContain("Apagar remetente");
  });

  it("without a screen, says so and keeps guides and glossary", () => {
    const html = render({ screen: null });
    expect(html).toContain("Esta tela ainda não tem ajuda detalhada");
    expect(html).toContain("Guias passo a passo");
    expect(html).toContain("Glossário");
    expect(html).toContain("GGR");
    expect(html).not.toContain("Fazer o tour desta tela");
  });

  it("renders the guides slot under its heading", () => {
    const html = render({ guidesSlot: <p>Guia de teste</p> });
    expect(html).toContain("Guia de teste");
  });

  it("shows search results instead of the sections while searching", () => {
    const html = render({
      query: "ggr",
      results: [{ kind: "term", title: "GGR", text: "Perdas na casa.", termId: "ggr" }],
    });
    expect(html).toContain("1 resultado");
    expect(html).not.toContain("Nesta tela");
    expect(render({ query: "zz", results: [] })).toContain("Nada encontrado");
  });

  it("opens the highlighted glossary term", () => {
    const html = render({ highlightTermId: "ggr" });
    expect(html).toMatch(/<details[^>]*id="help-term-ggr"[^>]*open/);
  });

  it('shows "Sobre o CRM" below "Nesta tela", with or without a screen (ruling R4)', () => {
    expect(render()).toContain("Sobre o CRM");
    expect(render({ screen: null })).toContain("Sobre o CRM");
  });

  it('while the "shell" article shows, offers "Voltar para esta tela" instead of "Sobre o CRM"', () => {
    const shell: HelpScreen = { ...screen, id: "shell", route: "shell", title: "Sobre o CRM", tours: {} };
    const html = render({ screen: shell, onCloseShellArticle: noop });
    expect(html).toContain("Voltar para esta tela");
    expect(html).not.toContain(">Sobre o CRM</button>");
    expect(render({ onCloseShellArticle: noop })).not.toContain("Voltar para esta tela");
  });

  it('"Fazer o tour desta tela" is tab-aware (ruling R11): hidden on a tab with no tour of its own and no "default"', () => {
    const tabOnlyTours: HelpScreen = {
      ...screen,
      tours: { email: [{ anchor: "casa.email.add-domain", title: "t", body: "b" }] },
    };
    expect(render({ screen: tabOnlyTours, currentTab: "email" })).toContain(
      "Fazer o tour desta tela",
    );
    expect(render({ screen: tabOnlyTours, currentTab: "outra-aba" })).not.toContain(
      "Fazer o tour desta tela",
    );
  });

  it('without a hash, "Fazer o tour desta tela" follows the screen defaultTab', () => {
    const tabOnlyTours: HelpScreen = {
      ...screen,
      tours: { email: [{ anchor: "casa.email.add-domain", title: "t", body: "b" }] },
    };
    expect(render({ screen: tabOnlyTours, currentTab: null })).not.toContain(
      "Fazer o tour desta tela",
    );
    expect(
      render({ screen: { ...tabOnlyTours, defaultTab: "email" }, currentTab: null }),
    ).toContain("Fazer o tour desta tela");
  });
});
