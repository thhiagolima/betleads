import { describe, expect, it } from "vitest";
import { countSubdomainLinks, normalizeLinkDomain, replaceLinkDomain } from "./link-domain";

describe("replaceLinkDomain", () => {
  const r = (t: string) => replaceLinkDomain(t, "casa-antiga.com", "casa-nova.com");
  it("troca só o host e mantém caminho, query e fragmento", () => {
    expect(r("Entre: https://casa-antiga.com/promo?cupom=X#topo")).toEqual({
      text: "Entre: https://casa-nova.com/promo?cupom=X#topo", count: 1 });
  });
  it("preserva www. e http", () => {
    expect(r("http://www.casa-antiga.com/x").text).toBe("http://www.casa-nova.com/x");
  });
  it("casa host com maiúsculas", () => {
    expect(r("https://Casa-Antiga.COM/a").text).toBe("https://casa-nova.com/a");
  });
  it("preserva porta", () => {
    expect(r("https://casa-antiga.com:8443/a").text).toBe("https://casa-nova.com:8443/a");
  });
  it("não toca domínios parecidos", () => {
    const t = "https://minhacasa-antiga.com https://casa-antiga.com.br https://casa-antiga.combo.net";
    expect(r(t)).toEqual({ text: t, count: 0 });
  });
  it("não toca subdomínios", () => {
    expect(r("https://go.casa-antiga.com/a").count).toBe(0);
  });
  it("não toca o domínio sem esquema nem {link}", () => {
    expect(r("casa-antiga.com {link}")).toEqual({ text: "casa-antiga.com {link}", count: 0 });
  });
  it("troca várias URLs e URL no fim de frase", () => {
    expect(r("https://casa-antiga.com, ou https://casa-antiga.com/b.")).toEqual({
      text: "https://casa-nova.com, ou https://casa-nova.com/b.", count: 2 });
  });
  it("funciona dentro de href e mantém &amp;", () => {
    expect(r('<a href="https://casa-antiga.com/a?x=1&amp;y=2">').text)
      .toBe('<a href="https://casa-nova.com/a?x=1&amp;y=2">');
  });
});
describe("normalizeLinkDomain", () => {
  it("normaliza URL colada", () => {
    expect(normalizeLinkDomain("https://WWW.Casa-Antiga.com/promo")).toEqual({ ok: true, domain: "casa-antiga.com" });
  });
  it("rejeita vazio", () => { expect(normalizeLinkDomain(" ").ok).toBe(false); });
});
describe("countSubdomainLinks", () => {
  it("conta subdomínios mas não o domínio exato nem www", () => {
    expect(countSubdomainLinks("https://go.casa-antiga.com https://www.casa-antiga.com https://casa-antiga.com", "casa-antiga.com")).toBe(1);
  });
});
