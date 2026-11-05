import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/help/glossary", () => ({
  GLOSSARY: [
    { id: "ftd", term: "FTD", short: "Primeiro depósito do jogador." },
    {
      id: "net",
      term: "NET",
      short: "Depósitos menos sacadas.",
      long: "Texto mais longo sobre NET.",
    },
  ],
}));

import { Term } from "./term";

describe("Term", () => {
  it("renderiza os children e um ícone com aria-label 'O que é <termo>?'", () => {
    const html = renderToStaticMarkup(<Term id="ftd">FTD</Term>);
    expect(html).toContain("FTD");
    expect(html).toContain('aria-label="O que é FTD?"');
  });

  it("sem `long`, não mostra o link para o glossário (fechado, sem conteúdo montado)", () => {
    const html = renderToStaticMarkup(<Term id="ftd">FTD</Term>);
    expect(html).not.toContain("Ver no glossário");
  });

  it("com `long`, renderiza normalmente (conteúdo do popover só monta quando aberto)", () => {
    const html = renderToStaticMarkup(<Term id="net">NET</Term>);
    expect(html).toContain("NET");
    expect(html).toContain('aria-label="O que é NET?"');
    // O popover começa fechado: o Radix Popover não monta o conteúdo
    // (short/"Ver no glossário") até ser aberto por hover ou toque, o que
    // exige interação real e não é exercitável com renderToStaticMarkup.
    expect(html).not.toContain("Ver no glossário");
  });

  it("com id desconhecido, renderiza só os children", () => {
    const html = renderToStaticMarkup(<Term id="nao-existe">Algo</Term>);
    expect(html).toContain("Algo");
    expect(html).not.toContain("O que é");
  });

  it("funciona fora do HelpProvider (sem lançar)", () => {
    expect(() => renderToStaticMarkup(<Term id="ftd">FTD</Term>)).not.toThrow();
  });
});
