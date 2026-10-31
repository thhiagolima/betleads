// sanitizeEmailHtml — allowlist sanitizer (sanitize-html) applied to every
// e-mail body right before it goes to the provider.
import { describe, expect, it } from "vitest";

import { MODELOS, renderModeloHtml, type FieldsState } from "@/components/email/template-presets";
import { sanitizeEmailHtml } from "./email-send.server";

describe("sanitizeEmailHtml — dangerous markup", () => {
  it("drops event handlers, quoted or not", () => {
    const out = sanitizeEmailHtml(
      `<p onclick="x()">a</p><img src="https://x.test/a.png" onerror=alert(1)><div onmouseover='y()' >b</div><a href="https://x.test" ONFOCUS=z>c</a>`,
    );
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(out).toContain('<img src="https://x.test/a.png" />');
    expect(out).toContain('<a href="https://x.test">c</a>');
  });

  it("drops script, iframe, form controls, object/embed, base, link, svg", () => {
    const out = sanitizeEmailHtml(
      `<script>alert(1)</script><iframe src="https://evil"></iframe>` +
        `<form action="https://evil/steal"><input name="cpf"><button>Enviar</button></form>` +
        `<object data="https://evil/x.swf"><embed src="https://evil/x.swf"></object>` +
        `<base href="https://evil/"><link rel="stylesheet" href="https://evil/x.css">` +
        `<svg><script>alert(2)</script></svg><p>ok</p>`,
    );
    for (const tag of ["script", "iframe", "form", "input", "button", "object", "embed", "base", "link", "svg"]) {
      expect(out.toLowerCase()).not.toContain(`<${tag}`);
    }
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>ok</p>");
  });

  it("drops meta refresh (http-equiv) but keeps charset/viewport", () => {
    const out = sanitizeEmailHtml(
      `<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil"><meta name="viewport" content="width=device-width"></head><body>x</body></html>`,
    );
    expect(out).not.toMatch(/http-equiv/i);
    expect(out).not.toContain("url=https://evil");
    expect(out).toContain('<meta charset="utf-8" />');
    expect(out).toContain('<meta name="viewport" content="width=device-width" />');
  });

  it("drops javascript:, vbscript: and data: links; keeps data:/cid: images", () => {
    const out = sanitizeEmailHtml(
      `<a href="javascript:alert(1)">a</a><a href="JaVaScRiPt&colon;alert(1)">b</a>` +
        `<a href=" javascript:alert(1)">c</a><a href="vbscript:x">d</a>` +
        `<a href="data:text/html;base64,PHNjcmlwdD4=">e</a>` +
        `<img src="data:image/png;base64,iVBORw0KGgo="><img src="cid:logo">` +
        `<td background="javascript:alert(1)">f</td>`,
    );
    expect(out).not.toMatch(/javascript|vbscript|text\/html/i);
    expect(out).toContain("<a>a</a>");
    expect(out).toContain("<a>e</a>");
    expect(out).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" />');
    expect(out).toContain('<img src="cid:logo" />');
  });

  it("drops inline CSS and style blocks that can run code", () => {
    const out = sanitizeEmailHtml(
      `<div style="width:expression(alert(1))">a</div><p style="background:url(javascript:x)">b</p>` +
        `<style>@import url(https://evil/x.css);</style><style>.ok{color:red}</style>`,
    );
    expect(out).toBe("<div>a</div><p>b</p><style>.ok{color:red}</style>");
  });
});

describe("sanitizeEmailHtml — templates render the same", () => {
  const fields: FieldsState = {
    titulo: "Olá, {primeiro_nome}!",
    texto: "Seu bônus chegou.<br/>Aproveite.",
    cta: "Resgatar",
    link: "https://casa.bet/promo?utm_source=email&utm_campaign=x",
    beneficio: "R$ 50",
    cupom: "BEM50",
    logo_url: "https://cdn.casa.bet/logo.png",
    hero_image_url: "https://cdn.casa.bet/hero.png",
    hero_alt: "Promo",
    secondary_image_url: "https://cdn.casa.bet/2.png",
    secondary_alt: "",
    mostrar_banner_secundario: true,
    benefit_icon_url: "https://cdn.casa.bet/icon.png",
    mostrar_icone_beneficio: true,
  };

  it("keeps tables, inline styles, images, links and placeholders of every preset model", () => {
    for (const modelo of MODELOS) {
      const html = renderModeloHtml(modelo.id, fields);
      const out = sanitizeEmailHtml(html);
      expect(out.startsWith("<!DOCTYPE html>"), modelo.id).toBe(true);
      expect(out).toContain(
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">',
      );
      expect(out).toContain('<td align="center">');
      expect(out).toContain('href="https://casa.bet/promo?utm_source=email&amp;utm_campaign=x"');
      expect(out).toContain('<a href="{link_descadastro}" style="color:#94a3b8;text-decoration:underline">');
      expect(out).toContain("Olá, {primeiro_nome}!");
      // Every style attribute of the source survives byte for byte.
      const styles = (s: string) => [...s.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
      expect(styles(out), modelo.id).toEqual(styles(html));
      const imgs = (s: string) => [...s.matchAll(/<img\b[^>]*src="([^"]*)"/g)].map((m) => m[1]);
      expect(imgs(html).length, modelo.id).toBeGreaterThan(0);
      expect(imgs(out), modelo.id).toEqual(imgs(html));
    }
  });

  it("keeps head, title, style blocks and the body", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Oferta</title><style>@media (max-width:600px){.c{width:100%!important}}</style></head><body style="margin:0"><center><font color="#333" face="Arial">Oi</font></center></body></html>`;
    expect(sanitizeEmailHtml(html)).toBe(
      `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Oferta</title><style>@media (max-width:600px){.c{width:100%!important}}</style></head><body style="margin:0"><center><font color="#333" face="Arial">Oi</font></center></body></html>`,
    );
  });
});
