import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown };

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: () => "/inicio",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/tenants.functions", () => ({
  getCurrentTenantAccessStatus: () => Promise.resolve(null),
}));

import { BillingBanner } from "./billing-banner";

function billingFor(overrides: Partial<Record<string, unknown>>) {
  return {
    state: "due_soon",
    effectiveLock: false,
    role: "payer",
    invoice: { amountCents: 400_000, dueDate: "2026-11-05" },
    enforcement: true,
    today: "2026-11-02",
    ...overrides,
  };
}

describe("BillingBanner", () => {
  it("renders the yellow banner with the pay button for the payer", () => {
    queryState.data = { billing: billingFor({ role: "payer" }) };
    const html = renderToStaticMarkup(<BillingBanner />);
    expect(html).toContain("Sua mensalidade de R$ 4.000,00 vence em 05/11");
    expect(html).toMatch(/<a href="\/plano-e-creditos"[^>]*>Pagar agora<\/a>/);
  });

  it("renders the banner without a button and with the member hint", () => {
    queryState.data = { billing: billingFor({ role: "member" }) };
    const html = renderToStaticMarkup(<BillingBanner />);
    expect(html).not.toContain("Pagar agora");
    expect(html).toContain("Peça ao administrador da casa para pagar a mensalidade.");
  });

  it("renders the banner for the superadmin", () => {
    queryState.data = {
      billing: billingFor({
        role: "super_admin",
        state: "locked_unpaid",
        today: "2026-11-10",
      }),
    };
    const html = renderToStaticMarkup(<BillingBanner />);
    expect(html).toContain("Sua mensalidade venceu em 05/11");
  });

  it("renders nothing without billing data", () => {
    queryState.data = { billing: null };
    const html = renderToStaticMarkup(<BillingBanner />);
    expect(html).toBe("");
  });
});
