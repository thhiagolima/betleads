import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState: { data: unknown; isLoading: boolean; isError: boolean; isFetching: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
};
let currentPathname = "/inicio";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: () => currentPathname,
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

import { TenantStatusGate } from "./tenant-status-gate";

function lockedBilling() {
  return {
    state: "locked_unpaid" as const,
    effectiveLock: true,
    role: "payer" as const,
    invoice: { amountCents: 400_000, dueDate: "2026-11-05" },
    enforcement: true,
    today: "2026-11-10",
  };
}

describe("TenantStatusGate — billing lock", () => {
  it("renders the lock card outside /plano-e-creditos", () => {
    currentPathname = "/inicio";
    queryState.data = { blocked: false, tenant: null, billing: lockedBilling() };
    const html = renderToStaticMarkup(
      <TenantStatusGate>
        <div>conteudo-da-casa</div>
      </TenantStatusGate>,
    );
    expect(html).toContain("Acesso suspenso por falta de pagamento");
    expect(html).not.toContain("conteudo-da-casa");
  });

  it("does not render the lock on /plano-e-creditos", () => {
    currentPathname = "/plano-e-creditos";
    queryState.data = { blocked: false, tenant: null, billing: lockedBilling() };
    const html = renderToStaticMarkup(
      <TenantStatusGate>
        <div>conteudo-da-casa</div>
      </TenantStatusGate>,
    );
    expect(html).not.toContain("Acesso suspenso por falta de pagamento");
    expect(html).toContain("conteudo-da-casa");
  });

  it("never locks the superadmin", () => {
    currentPathname = "/inicio";
    queryState.data = {
      blocked: false,
      tenant: null,
      billing: { ...lockedBilling(), role: "super_admin" as const },
    };
    const html = renderToStaticMarkup(
      <TenantStatusGate>
        <div>conteudo-da-casa</div>
      </TenantStatusGate>,
    );
    expect(html).not.toContain("Acesso suspenso por falta de pagamento");
    expect(html).toContain("conteudo-da-casa");
  });
});
