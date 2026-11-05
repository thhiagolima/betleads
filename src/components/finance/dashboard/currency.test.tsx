// Moeda da casa no painel: valores da casa na moeda dela, custos Betleads em
// BRL, e nada de lucro ou total somando moedas diferentes.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatBRL, formatCurrencyTotals, formatMoneyIn } from "@/components/finance/format";
import { GroupScoreboard, sortScoreboardRows } from "@/components/group/group-scoreboard";
import { TooltipProvider } from "@/components/ui/tooltip";

import { CurrencyTotals, mixedScopeNote } from "./currency-totals";
import { ResultBand } from "./result-band";
import {
  sortTenantProfitRows,
  TenantProfitTable,
  type TenantProfitRow,
} from "./tenant-profit-table";
import { kpis, summary } from "./test-fixtures";
import { WaterfallChart } from "./waterfall-chart";

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const plain = (html: string) => html.replace(/[\u00a0\u202f]/g, " ");

describe("formatMoneyIn", () => {
  it("ARS no formato argentino; BRL idêntico ao formatBRL", () => {
    expect(formatMoneyIn(10000, "ARS")).toBe("$ 10.000,00");
    expect(formatMoneyIn(1234.5, "BRL")).toBe(formatBRL(1234.5));
    expect(formatMoneyIn(1234.5, undefined)).toBe("R$ 1.234,50");
    expect(formatMoneyIn(null, "ARS")).toBe("n.a.");
  });

  it("formatCurrencyTotals: um total por moeda, nunca somados", () => {
    expect(
      formatCurrencyTotals([
        { currency: "BRL", amount: 1000 },
        { currency: "ARS", amount: 50000 },
      ]),
    ).toBe("R$ 1.000,00 · $ 50.000,00");
    expect(formatCurrencyTotals([{ currency: "ARS", amount: null }])).toBe("—");
  });
});

describe("ResultBand fora do BRL", () => {
  it("Lucro, Margem e ROI viram — com a nota; Anúncios na moeda da casa", () => {
    const html = plain(
      render(
        <ResultBand
          current={summary({ cashResult: null, roi: null, adSpend: 1500, net: 9000 })}
          previous={summary({ cashResult: null })}
          kpis={{ current: kpis(), previous: kpis() }}
          roiReference={{ roi: null, range: { from: "2026-09-01", to: "2026-09-24" } }}
          currency="ARS"
        />,
      ),
    );
    expect(html).toContain("Receita em ARS e custos em BRL: sem conversão de câmbio");
    expect(html).toContain("$ 1.500,00");
    expect(html).not.toContain("R$");
    expect(html).toContain("sem lucro líquido");
  });
});

describe("WaterfallChart fora do BRL", () => {
  it("valores na moeda da casa e a nota de que os custos BRL ficam fora", () => {
    const html = plain(
      render(
        <WaterfallChart
          currency="ARS"
          withoutFee
          steps={[
            { key: "deposits", label: "Depósitos", kind: "start", start: 0, end: 10000 },
            {
              key: "house_result",
              label: "Antes dos custos Betleads",
              kind: "subtotal",
              start: 10000,
              end: 10000,
            },
          ]}
        />,
      ),
    );
    expect(html).toContain("$ 10.000");
    expect(html).toContain("Envios e mensalidade (BRL) ficam fora do gráfico.");
    // Sem mensalidade num gráfico que já não tem custos Betleads.
    expect(html).not.toContain('data-note="no-fee"');
  });
});

const brlRow: TenantProfitRow = {
  id: "brl",
  nome: "Casa BR",
  moeda: "BRL",
  current: summary({ cashResult: 900, adSpend: 100 }),
  previous: summary(),
  margin: 0.3,
  sendCost: 10,
};
const arsRow: TenantProfitRow = {
  id: "ars",
  nome: "Los Hermanos",
  moeda: "ARS",
  current: summary({ cashResult: null, adSpend: 50000 }),
  previous: summary(),
  margin: null,
  sendCost: 20,
};

describe("tabelas com casas em moedas diferentes", () => {
  it("cada linha na sua moeda; envios em BRL; lucro fora do BRL é —", () => {
    const html = plain(render(<TenantProfitTable rows={[brlRow, arsRow]} comparing={false} />));
    expect(html).toContain("R$ 900,00");
    expect(html).toContain("$ 50.000,00");
    expect(html).toContain("R$ 20,00");
    expect(html).toContain('title="Receita em ARS e custos em BRL: sem conversão de câmbio"');
  });

  it("ordenar por dinheiro da casa agrupa por moeda antes (não compara ARS com BRL)", () => {
    expect(sortTenantProfitRows([arsRow, brlRow], "adSpend", "desc").map((r) => r.id)).toEqual([
      "brl",
      "ars",
    ]);
    const scoreRows = [
      { ...arsRow, goals: [] },
      { ...brlRow, goals: [] },
    ];
    expect(sortScoreboardRows(scoreRows, "depositAmount", "desc").map((r) => r.id)).toEqual([
      "brl",
      "ars",
    ]);
  });

  it("GroupScoreboard: dinheiro e meta na moeda da casa, Resultado/ROI — fora do BRL", () => {
    const html = plain(
      render(
        <GroupScoreboard
          rows={[
            {
              id: "ars",
              nome: "Los Hermanos",
              moeda: "ARS",
              current: summary({ depositAmount: 20000, cashResult: null, roi: null }),
              previous: summary(),
              goals: [
                {
                  metric: "deposits",
                  direction: "gte",
                  target: 30000,
                  value: 20000,
                  status: "red",
                },
              ],
            },
          ]}
        />,
      ),
    );
    expect(html).toContain("$ 20.000,00");
    expect(html).toContain("meta $ 30.000,00");
    expect(html).not.toContain("R$");
    expect(html).toContain('title="Receita em ARS e custos em BRL: sem conversão de câmbio"');
  });
});

describe("CurrencyTotals", () => {
  it("uma linha por moeda, sem total geral, e os envios BRL de todas as casas", () => {
    const html = plain(
      render(
        <CurrencyTotals
          rows={[
            {
              currency: "BRL",
              houses: 2,
              current: summary({ depositAmount: 1000, cashResult: 400 }),
            },
            {
              currency: "ARS",
              houses: 1,
              current: summary({ depositAmount: 50000, cashResult: null }),
            },
          ]}
          sends={[
            {
              item: "sms",
              label: "SMS",
              unitLabel: "envios",
              units: 10,
              amount: 12.5,
              unitCost: 1.25,
              previousAmount: null,
              missingCost: false,
            },
          ]}
        />,
      ),
    );
    expect(html).toContain("Casas em BRL e ARS: os totais aparecem por moeda");
    expect(html).toContain("R$ 1.000,00");
    expect(html).toContain("$ 50.000,00");
    expect(html).toContain("R$ 400,00");
    expect(html).toContain("R$ 12,50");
    expect(html).not.toContain("51.000");
    expect(mixedScopeNote(["BRL", "ARS", "MXN"])).toBe(
      "Casas em BRL, ARS e MXN: os totais aparecem por moeda, sem conversão de câmbio.",
    );
  });
});
