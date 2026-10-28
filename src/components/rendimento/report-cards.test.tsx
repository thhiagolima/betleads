import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReportBlock } from "@/lib/expert-report.functions";

import { ReportCards, VariationTag } from "./report-cards";
import { ReportFunnel } from "./report-funnel";

const block: ReportBlock = {
  depositado: 1500,
  depositadoClique: 1000,
  depositadoAfiliado: 500,
  ftds: 2,
  valorFtd: 300,
  redepositos: 4,
  valorRedeposito: 1200,
  ticketRedeposito: 300,
  reativados: 1,
  depositantes: 3,
  links: 20,
  leadsComLink: 10,
  leadsClicaram: 4,
  leadsDepositaramClique: 1,
  contatos: 7,
};

// `brl` separa "R$" do valor com espaço não separável (U+00A0), como no app.
const variacao = { depositado: 12.5, ftds: -50, redepositos: null, reativados: 0 };

describe("ReportCards", () => {
  it("shows the four cards with the spec copy", () => {
    const html = renderToStaticMarkup(<ReportCards current={block} variacao={variacao} />);
    expect(html).toContain("Depositado creditado");
    expect(html).toContain("R$ 1.500,00");
    expect(html).toContain("clique R$ 1.000,00 · afiliado R$ 500,00");
    expect(html).toContain("FTDs");
    expect(html).toContain("R$ 300,00 em 1º depósito");
    expect(html).toContain("Redepósitos");
    expect(html).toContain("R$ 1.200,00 · ticket R$ 300,00");
    expect(html).toContain("Reativados");
    expect(html).toContain("leads que estavam dormindo");
  });

  it("shows a dash for the ticket without redeposits", () => {
    const html = renderToStaticMarkup(
      <ReportCards
        current={{ ...block, redepositos: 0, valorRedeposito: 0, ticketRedeposito: null }}
        variacao={variacao}
      />,
    );
    expect(html).toContain("R$ 0,00 · ticket —");
  });
});

describe("VariationTag", () => {
  it("is green ▲ for growth, red ▼ for a drop and — without a base", () => {
    const up = renderToStaticMarkup(<VariationTag value={12.5} />);
    expect(up).toContain("▲ 12,5%");
    expect(up).toContain("text-success");
    const down = renderToStaticMarkup(<VariationTag value={-50} />);
    expect(down).toContain("▼ 50,0%");
    expect(down).toContain("text-danger");
    expect(renderToStaticMarkup(<VariationTag value={null} />)).toContain("—");
  });
});

describe("ReportFunnel", () => {
  it("shows links, clicks and deposits with their shares", () => {
    const html = renderToStaticMarkup(<ReportFunnel current={block} janelaHoras={72} />);
    expect(html).toContain("Links gerados");
    expect(html).toContain("Leads que clicaram (40%)");
    expect(html).toContain("Depositaram em até 72h (25% dos que clicaram)");
    expect(html).toContain("Contatos registrados");
  });

  it("omits the share when there is no base", () => {
    const html = renderToStaticMarkup(
      <ReportFunnel
        current={{ ...block, leadsComLink: 0, leadsClicaram: 0, leadsDepositaramClique: 0 }}
        janelaHoras={48}
      />,
    );
    expect(html).toContain("Leads que clicaram<");
    expect(html).toContain("Depositaram em até 48h<");
  });
});
