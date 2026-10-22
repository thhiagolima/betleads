import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LinkInsertMenu, insertAtCursor, linkInsertItems } from "./link-insert-menu";

describe("insertAtCursor", () => {
  it("inserts the token at the cursor, replacing any selection", () => {
    expect(insertAtCursor("Olá , tudo bem?", 4, 4, "{link}")).toEqual({
      text: "Olá {link}, tudo bem?",
      cursor: 10,
    });
  });

  it("replaces a selection range instead of inserting inside it", () => {
    expect(insertAtCursor("Olá XXXX, tudo bem?", 4, 8, "{link_promo}")).toEqual({
      text: "Olá {link_promo}, tudo bem?",
      cursor: 16,
    });
  });

  it("falls back to the end of the text when the cursor position is not finite", () => {
    expect(insertAtCursor("Olá", Number.NaN, Number.NaN, "{link}")).toEqual({
      text: "Olá{link}",
      cursor: 9,
    });
  });
});

describe("linkInsertItems", () => {
  it("is empty when the house has no site URL", () => {
    expect(linkInsertItems({ siteUrl: null, quickLinks: [] })).toEqual([]);
  });

  it("lists the house URL first, then each quick link, with their variable tokens", () => {
    expect(
      linkInsertItems({
        siteUrl: "https://suacasa.bet.br",
        quickLinks: [
          { key: "promo", label: "Promoções", url: "https://suacasa.bet.br/promo" },
          { key: "login", label: "Login", url: "https://suacasa.bet.br/login" },
        ],
      }),
    ).toEqual([
      { label: "URL da casa", token: "{link}" },
      { label: "Promoções", token: "{link_promo}" },
      { label: "Login", token: "{link_login}" },
    ]);
  });
});

describe("LinkInsertMenu", () => {
  it("without a site URL, shows the 'cadastre a URL da casa' notice linking to the house config", () => {
    const html = renderToStaticMarkup(
      <LinkInsertMenu siteUrl={null} quickLinks={[]} value="" onChange={() => {}} />,
    );

    expect(html).toContain("Cadastre a URL da casa");
    expect(html).toContain('href="/configuracoes/casa"');
  });

  it("with a site URL, lists 'URL da casa' and every quick link as insertable items", () => {
    const html = renderToStaticMarkup(
      <LinkInsertMenu
        siteUrl="https://suacasa.bet.br"
        quickLinks={[{ key: "promo", label: "Promoções", url: "https://suacasa.bet.br/promo" }]}
        value=""
        onChange={() => {}}
      />,
    );

    expect(html).toContain("URL da casa");
    expect(html).toContain("{link}");
    expect(html).toContain("Promoções");
    expect(html).toContain("{link_promo}");
    expect(html).not.toContain("Cadastre a URL da casa");
  });
});
