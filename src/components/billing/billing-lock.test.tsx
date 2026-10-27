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

import { BillingLock } from "./billing-lock";

describe("BillingLock", () => {
  it("shows the title, text and pay button for the payer", () => {
    const html = renderToStaticMarkup(
      <BillingLock
        view={{
          title: "Acesso suspenso por falta de pagamento",
          text: "A mensalidade de R$ 4.000,00 venceu em 05/11. Pague por Pix e o acesso volta na hora.",
          showPay: true,
          memberHint: null,
        }}
      />,
    );
    expect(html).toContain("Acesso suspenso por falta de pagamento");
    expect(html).toContain("A mensalidade de R$ 4.000,00 venceu em 05/11.");
    expect(html).toMatch(/<a href="\/plano-e-creditos"[^>]*>Ir para o pagamento<\/a>/);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<h2 id="billing-lock-title"[^>]*>Acesso suspenso por falta de pagamento<\/h2>/);
    expect(html).toContain('aria-labelledby="billing-lock-title"');
  });

  it("hides the pay button and shows the member hint for a member", () => {
    const html = renderToStaticMarkup(
      <BillingLock
        view={{
          title: "Acesso suspenso por falta de pagamento",
          text: "A mensalidade de R$ 4.000,00 venceu em 05/11. Pague por Pix e o acesso volta na hora.",
          showPay: false,
          memberHint: "Peça ao administrador da casa para pagar a mensalidade.",
        }}
      />,
    );
    expect(html).not.toContain("Ir para o pagamento");
    expect(html).toContain("Peça ao administrador da casa para pagar a mensalidade.");
  });

  it("renders nothing when view is null", () => {
    const html = renderToStaticMarkup(<BillingLock view={null} />);
    expect(html).toBe("");
  });
});
