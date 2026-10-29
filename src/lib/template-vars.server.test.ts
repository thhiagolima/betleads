// Task 9 — house URL and quick links as message variables. Legacy behavior
// (hard-coded betleads.app links, unknown tokens kept literal) must be
// byte-for-byte identical when no house data is supplied.
import { describe, expect, it } from "vitest";
import { buildPlayerVariables, renderTemplate } from "./template-vars.server";
import type { HouseLinks } from "./house-links.server";

const PLAYER = { nome: "Carol Silva" };

const HOUSE: HouseLinks = {
  siteUrl: "https://x.com",
  quickLinks: { login: "https://x.com/login", promo: "https://x.com/promo" },
};

describe("buildPlayerVariables — house links", () => {
  it("usa a URL da casa e as URLs rápidas quando house é informado", () => {
    const vars = buildPlayerVariables(PLAYER, HOUSE);
    expect(vars.link).toBe("https://x.com");
    expect(vars.link_login).toBe("https://x.com/login");
    // Sem URL rápida "deposito": cai para a URL do site.
    expect(vars.link_deposito).toBe("https://x.com");
    expect(vars.nome).toBe("Carol Silva");
  });

  it("mantém os valores legados sem house", () => {
    const vars = buildPlayerVariables(PLAYER);
    expect(vars.link).toBe("https://betleads.app/depositar");
    expect(vars.link_login).toBe("https://betleads.app");
    expect(vars.link_deposito).toBe("https://betleads.app/depositar");
    expect(vars.nome).toBe("Carol Silva");
  });

  it("mantém os valores legados quando house.siteUrl é null", () => {
    const vars = buildPlayerVariables(PLAYER, { siteUrl: null, quickLinks: {} });
    expect(vars.link).toBe("https://betleads.app/depositar");
    expect(vars.link_login).toBe("https://betleads.app");
    expect(vars.link_deposito).toBe("https://betleads.app/depositar");
  });
});

describe("renderTemplate — fallback de {link_*} desconhecido", () => {
  it("resolve uma URL rápida dinâmica ({link_promo}) pelo house", () => {
    const vars = buildPlayerVariables(PLAYER, HOUSE);
    expect(renderTemplate("Promo: {link_promo}", vars, HOUSE)).toBe(
      "Promo: https://x.com/promo",
    );
  });

  it("cai para siteUrl quando a URL rápida referenciada não existe mais", () => {
    const vars = buildPlayerVariables(PLAYER, HOUSE);
    expect(renderTemplate("Veja: {link_apagado}", vars, HOUSE)).toBe("Veja: https://x.com");
  });

  it("sem house, token {link_*} desconhecido permanece literal (legado)", () => {
    const vars = buildPlayerVariables(PLAYER);
    expect(renderTemplate("Veja: {link_apagado}", vars)).toBe("Veja: {link_apagado}");
  });

  it("com house mas siteUrl null, token {link_*} desconhecido permanece literal", () => {
    const house: HouseLinks = { siteUrl: null, quickLinks: {} };
    const vars = buildPlayerVariables(PLAYER, house);
    expect(renderTemplate("Veja: {link_apagado}", vars, house)).toBe("Veja: {link_apagado}");
  });

  it("{nome} continua igual com ou sem house", () => {
    const vars = buildPlayerVariables(PLAYER, HOUSE);
    expect(renderTemplate("Olá {nome}", vars, HOUSE)).toBe("Olá Carol Silva");
  });
});

describe("renderTemplate — chaves duplas", () => {
  it("{{token}} é substituído sem sobrar chave no texto", () => {
    const vars = buildPlayerVariables(PLAYER, HOUSE);
    expect(renderTemplate("{{nome}}, saque pago!", vars, HOUSE)).toBe("Carol Silva, saque pago!");
    expect(renderTemplate("Oi {{primeiro_nome}} / {nome}", vars, HOUSE)).toBe("Oi Carol / Carol Silva");
  });

  it("{{token}} desconhecido é preservado como estava", () => {
    expect(renderTemplate("Oi {{inexistente}}", {})).toBe("Oi {{inexistente}}");
  });
});
