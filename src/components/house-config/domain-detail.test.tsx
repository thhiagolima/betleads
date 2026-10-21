import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DnsRecord } from "@/lib/house-config";
import { DomainDetail, type DomainDetailDomain } from "./domain-detail";

function makeDomain(overrides: Partial<DomainDetailDomain> = {}): DomainDetailDomain {
  const records: DnsRecord[] = [
    { type: "CNAME", name: "go.suacasa.bet.br", value: "cname.short.io", verified: null },
  ];
  return {
    id: "d1",
    hostname: "go.suacasa.bet.br",
    status: "pending",
    is_default: false,
    dns_records: records,
    last_checked_at: null,
    last_error: null,
    ...overrides,
  };
}

function findButtonOpenTag(html: string, label: string): string {
  const re = new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${label}`);
  const match = html.match(re);
  if (!match) throw new Error(`button not found for label: ${label}`);
  return match[1];
}

function isDisabled(buttonOpenTagAttrs: string): boolean {
  return /(^|\s)disabled(=|\s|$)/.test(buttonOpenTagAttrs);
}

describe("DomainDetail", () => {
  it("pending domain: shows 'Aguardando DNS', the DNS records table with a copy button per row, and the actions", () => {
    const html = renderToStaticMarkup(<DomainDetail domain={makeDomain()} canEdit />);

    expect(html).toContain("Aguardando DNS");
    expect(html).toContain("CNAME");
    expect(html).toContain("go.suacasa.bet.br");
    expect(html).toContain("cname.short.io");
    expect(html).toContain("Copiar valor de go.suacasa.bet.br");
    expect(html).toContain("Verificar agora");
    expect(html).toContain("Enviar instruções por e-mail");

    const defaultButtonAttrs = findButtonOpenTag(html, "Definir como padrão");
    expect(isDisabled(defaultButtonAttrs)).toBe(true);
  });

  it("verified domain: shows 'Verificado' and an enabled 'Definir como padrão'", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "verified" })} canEdit />,
    );

    expect(html).toContain("Verificado");
    expect(html).not.toContain("Aguardando DNS");

    const defaultButtonAttrs = findButtonOpenTag(html, "Definir como padrão");
    expect(isDisabled(defaultButtonAttrs)).toBe(false);
  });

  it("canEdit:false hides every action", () => {
    const html = renderToStaticMarkup(<DomainDetail domain={makeDomain()} canEdit={false} />);

    expect(html).not.toContain("Verificar agora");
    expect(html).not.toContain("Enviar instruções por e-mail");
    expect(html).not.toContain("Definir como padrão");
    expect(html).not.toContain("Remover");
    // The read-only info is still shown.
    expect(html).toContain("Aguardando DNS");
    expect(html).toContain("CNAME");
  });

  it("shows last_error as muted text when present", () => {
    const html = renderToStaticMarkup(
      <DomainDetail
        domain={makeDomain({ status: "failed", last_error: "Domínio rejeitado pelo provedor" })}
        canEdit
      />,
    );

    expect(html).toContain("Falhou");
    expect(html).toContain("Domínio rejeitado pelo provedor");
  });

  it("shows a 'Padrão' badge when the domain is already the default", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "verified", is_default: true })} canEdit />,
    );

    expect(html).toContain("Padrão");
    const defaultButtonAttrs = findButtonOpenTag(html, "Definir como padrão");
    expect(isDisabled(defaultButtonAttrs)).toBe(true);
  });
});
