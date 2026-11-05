import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantCurrency } from "@/lib/currency";
import type { ExpertMetrics } from "@/lib/expert-metrics.functions";

import { ExpertMetricCards } from "./expert-metric-cards";

// Sem QueryClient no render estático: a moeda da casa vem de um mock trocável.
const tenantCurrency = vi.hoisted(() => ({ value: "BRL" as TenantCurrency }));
vi.mock("@/hooks/use-tenant-currency", async () => {
  const { currencySymbol, formatMoney } =
    await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    useMoney: () => ({
      currency: tenantCurrency.value,
      money: (value: number | null | undefined) => formatMoney(value, tenantCurrency.value),
      symbol: currencySymbol(tenantCurrency.value),
    }),
  };
});

afterEach(() => {
  tenantCurrency.value = "BRL";
});

const metrics: ExpertMetrics = {
  expertId: "e1",
  depositado: 1234.5,
  depositadoClique: 1000,
  depositadoAfiliado: 234.5,
  depositos: 10,
  depositantes: 8,
  reativacoes: 3,
  ftds: 5,
  links: 12,
  cliques: 40,
  contatos: 7,
};

describe("ExpertMetricCards", () => {
  it("shows the deposited total with the click/affiliate breakdown", () => {
    const html = renderToStaticMarkup(<ExpertMetricCards metrics={metrics} />);
    expect(html).toContain("Depositado atribuído");
    expect(html).toContain("R$ 1.234,50");
    expect(html).toContain("por clique R$ 1.000,00");
    expect(html).toContain("por afiliado R$ 234,50");
  });

  it("formats the deposited amounts in the house currency (ARS)", () => {
    tenantCurrency.value = "ARS";
    const html = renderToStaticMarkup(<ExpertMetricCards metrics={metrics} />).replace(/\s/g, " ");
    expect(html).toContain("$ 1.234,50");
    expect(html).toContain("por clique $ 1.000,00");
    expect(html).not.toContain("R$");
  });

  it("shows reactivations, first deposits and clicks/links", () => {
    const html = renderToStaticMarkup(<ExpertMetricCards metrics={metrics} />);
    expect(html).toContain("Reativados");
    expect(html).toContain(">3<");
    expect(html).toContain("Primeiros depósitos");
    expect(html).toContain(">5<");
    expect(html).toContain("Cliques / links");
    expect(html).toContain("40 / 12");
  });
});
