import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DnsRecord } from "@/lib/house-config";
import { DomainDetail, formatNextAutoCheck, type DomainDetailDomain } from "./domain-detail";

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
    created_at: "2026-10-21T10:00:00.000Z",
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

  it("demo tenant: every action still renders but is disabled", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "verified" })} canEdit isDemo />,
    );

    // Actions are still present (read access is unaffected by demo gating)...
    expect(html).toContain("Verificar agora");
    expect(html).toContain("Enviar instruções por e-mail");
    expect(html).toContain("Definir como padrão");
    expect(html).toContain("Remover");

    // ...but every one of them is disabled.
    expect(isDisabled(findButtonOpenTag(html, "Verificar agora"))).toBe(true);
    expect(isDisabled(findButtonOpenTag(html, "Enviar instruções por e-mail"))).toBe(true);
    expect(isDisabled(findButtonOpenTag(html, "Definir como padrão"))).toBe(true);
    expect(isDisabled(findButtonOpenTag(html, "Remover"))).toBe(true);
  });

  it("shows the per-record DNS status: ok for true, pendente for false, — for null", () => {
    const records: DnsRecord[] = [
      { type: "CNAME", name: "go.suacasa.bet.br", value: "cname.short.io", verified: true },
      { type: "TXT", name: "_dnsauth.go.suacasa.bet.br", value: "abc123", verified: false },
      { type: "MX", name: "mail.suacasa.bet.br", value: "mx.infobip.com", verified: null },
    ];
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ dns_records: records })} canEdit />,
    );

    expect(html).toContain("ok");
    expect(html).toContain("pendente");
    expect(html).toContain("—");
  });

  it("shows last_error highlighted inside an element with the text-destructive class", () => {
    const html = renderToStaticMarkup(
      <DomainDetail
        domain={makeDomain({ status: "failed", last_error: "Domínio rejeitado pelo provedor" })}
        canEdit
      />,
    );

    const re = /<[^>]*class="[^"]*text-destructive[^"]*"[^>]*>Domínio rejeitado pelo provedor/;
    expect(html).toMatch(re);
  });

  it("a pending domain shows the 'Próxima verificação automática' label", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "pending" })} canEdit />,
    );

    expect(html).toContain("Próxima verificação automática");
  });

  it("a pending domain never checked yet says the next check is 'em instantes'", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "pending", last_checked_at: null })} canEdit />,
    );

    expect(html).toContain("Próxima verificação automática: em instantes");
  });

  it("a verified domain shows the 'Próxima checagem' label instead", () => {
    const html = renderToStaticMarkup(
      <DomainDetail
        domain={makeDomain({ status: "verified", last_checked_at: "2026-10-21T09:00:00.000Z" })}
        canEdit
      />,
    );

    expect(html).toContain("Próxima checagem");
    expect(html).not.toContain("Próxima verificação automática");
  });

  it("pending + canEdit: the disabled 'Definir como padrão' button is described by a sr-only reason", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "pending" })} canEdit />,
    );

    // The tooltip itself renders via a real Portal (same pattern as
    // DemoDisabledTooltip), so it never appears in renderToStaticMarkup
    // output — this is why the accessible reason is also exposed as a
    // sr-only span linked via aria-describedby, which IS checkable here.
    const buttonAttrs = findButtonOpenTag(html, "Definir como padrão");
    const describedByMatch = buttonAttrs.match(/aria-describedby="([^"]+)"/);
    expect(describedByMatch).not.toBeNull();
    const describedById = describedByMatch![1];

    const reasonRe = new RegExp(
      `<span[^>]*id="${describedById}"[^>]*class="[^"]*sr-only[^"]*"[^>]*>Disponível depois que o domínio for verificado</span>`,
    );
    expect(html).toMatch(reasonRe);
  });

  it("verified + canBeDefault: 'Definir como padrão' has no not-verified reason wired up", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "verified" })} canEdit />,
    );

    const buttonAttrs = findButtonOpenTag(html, "Definir como padrão");
    expect(buttonAttrs).not.toContain("aria-describedby");
    expect(html).not.toContain("Disponível depois que o domínio for verificado");
  });

  it("demo tenant: the not-verified reason is suppressed (the demo tooltip takes precedence)", () => {
    const html = renderToStaticMarkup(
      <DomainDetail domain={makeDomain({ status: "pending" })} canEdit isDemo />,
    );

    const buttonAttrs = findButtonOpenTag(html, "Definir como padrão");
    expect(buttonAttrs).not.toContain("aria-describedby");
    expect(html).not.toContain("Disponível depois que o domínio for verificado");
  });
});

describe("formatNextAutoCheck", () => {
  const now = new Date(2026, 10, 5, 14, 0, 0);

  it("says 'em instantes' when the scheduled time is now or already past", () => {
    expect(formatNextAutoCheck(now, now)).toBe("em instantes");
    expect(formatNextAutoCheck(new Date(2026, 10, 5, 13, 50, 0), now)).toBe("em instantes");
  });

  it("shows only the time when it's later today", () => {
    const next = new Date(2026, 10, 5, 14, 10, 0);
    expect(formatNextAutoCheck(next, now)).toBe(next.toLocaleTimeString("pt-BR"));
  });

  it("shows the date and the time when it's another day", () => {
    const next = new Date(2026, 10, 6, 9, 0, 0);
    expect(formatNextAutoCheck(next, now)).toBe(
      `${next.toLocaleDateString("pt-BR")} às ${next.toLocaleTimeString("pt-BR")}`,
    );
    expect(formatNextAutoCheck(next, now)).toContain("06/11/2026");
  });
});
