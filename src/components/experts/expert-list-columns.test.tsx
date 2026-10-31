import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-is-demo-tenant", () => ({ useIsDemoTenant: () => false }));
vi.mock("@/lib/expert-campaigns.functions", () => ({}));
vi.mock("@/lib/expert-campaigns-admin.functions", () => ({}));
vi.mock("@/lib/experts-admin.functions", () => ({}));

import { ExpertEnvioCell, ExpertTetoCell, ExpertUsageCell } from "./expert-list-columns";

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("experts list columns", () => {
  it("Envio: Livre / Com aprovação with the pending badge", () => {
    expect(html(<ExpertEnvioCell expertId="e1" envioModo="livre" pendentes={0} />)).toContain(
      "Livre",
    );
    const approval = html(<ExpertEnvioCell expertId="e1" envioModo="aprovacao" pendentes={3} />);
    expect(approval).toContain("Com aprovação");
    expect(approval).toContain("3 pendentes");
    expect(
      html(<ExpertEnvioCell expertId="e1" envioModo="aprovacao" pendentes={0} />),
    ).not.toContain("pendente");
  });

  it("Teto: R$, Sem teto or blocked", () => {
    expect(html(<ExpertTetoCell teto={1500} />)).toContain("R$ 1.500,00");
    expect(html(<ExpertTetoCell teto={null} />)).toContain("Sem teto");
    expect(html(<ExpertTetoCell teto={0} />)).toContain("(bloqueado)");
  });

  it("Uso do mês: bar or dash", () => {
    expect(html(<ExpertUsageCell usage={{ teto: 200, usado: 50 }} />)).toContain("25% do teto");
    expect(html(<ExpertUsageCell usage={null} />)).toContain("—");
  });
});
