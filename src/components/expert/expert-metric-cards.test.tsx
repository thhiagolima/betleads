import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExpertMetrics } from "@/lib/expert-metrics.functions";

import { ExpertMetricCards } from "./expert-metric-cards";

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
