import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { WalletBalanceNotice } from "./wallet-balance-notice";

describe("WalletBalanceNotice", () => {
  it("with canBuy, links 'Saldo e consumo' to /plano-e-creditos", () => {
    const html = renderToStaticMarkup(
      <WalletBalanceNotice balance={0} exempt={false} smsUnitPrice={0.08} canBuy />,
    );
    expect(html).toMatch(
      /Compre créditos por Pix em <a href="\/plano-e-creditos"[^>]*>Saldo e consumo<\/a>\./,
    );
  });

  it("without canBuy, renders the support text with no link", () => {
    const html = renderToStaticMarkup(
      <WalletBalanceNotice balance={0} exempt={false} smsUnitPrice={0.08} canBuy={false} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("fale com o suporte para adicionar saldo.");
  });

  it("renders nothing for an exempt house", () => {
    const html = renderToStaticMarkup(
      <WalletBalanceNotice balance={0} exempt smsUnitPrice={0.08} canBuy />,
    );
    expect(html).toBe("");
  });

  it("warns below the house's own threshold", () => {
    const below = renderToStaticMarkup(
      <WalletBalanceNotice balance={450} exempt={false} smsUnitPrice={0.08} threshold={500} />,
    );
    expect(below).toContain("Saldo baixo");
    expect(below).toContain("SMS, voz e e-mail");
    const above = renderToStaticMarkup(
      <WalletBalanceNotice balance={150} exempt={false} smsUnitPrice={0.08} threshold={100} />,
    );
    expect(above).toBe("");
  });
});
