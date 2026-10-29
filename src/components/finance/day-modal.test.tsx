import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { computeDay } from "@/lib/finance/calc";
import type { FinanceDayInput } from "@/lib/finance/types";

import { DayModalContent, type DayModalContentProps } from "./day-modal";

function props(overrides: Partial<DayModalContentProps> = {}): DayModalContentProps {
  const input: FinanceDayInput = {
    date: "2026-10-29",
    registrations: 12,
    ftds: 3,
    ftdDepositAmount: 150,
    depositAmount: 2000,
    withdrawalAmount: 800,
    adSpend: null,
    adSpendSuggested: 321.5,
    ggr: null,
    ggrFeePct: 0,
    movementFeePct: 0,
  };
  return {
    day: computeDay(input),
    sends: [
      { item: "sms", units: 1000, amount: 59, missingCostUnits: 0 },
      { item: "email", units: 200, amount: 0.08, missingCostUnits: 0 },
    ],
    activity: null,
    otherCosts: [],
    usingMonthlyGgr: false,
    readOnly: false,
    adSpend: "",
    ggr: "",
    onAdSpendChange: () => {},
    onGgrChange: () => {},
    neighbors: { prev: "2026-10-28", next: null },
    onPrev: () => {},
    onNext: () => {},
    onSave: () => {},
    saving: false,
    dirty: false,
    ...overrides,
  };
}

/** The opening tag of the first <button> whose text contains `label`. */
function buttonTag(html: string, label: string): string {
  const at = html.indexOf(label);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", open) + 1);
}

describe("DayModalContent", () => {
  it("shows the three sections, per-channel sends and a disabled Próximo dia on today", () => {
    const html = renderToStaticMarkup(<DayModalContent {...props()} />);

    expect(html).toContain("Veio do CRM");
    expect(html).toContain("Você lança");
    expect(html).toContain("Resultado do dia");

    expect(html).toContain("SMS");
    expect(html).toContain("1.000 envios");
    expect(html).toContain("R$ 59,00");
    expect(html).toContain("E-mail");
    expect(html).toContain("200 e-mails");

    expect(html).toContain("Usar valor da Meta (R$ 321,50)");
    expect(html).toContain("Outros custos deste dia");

    expect(buttonTag(html, "Próximo dia")).toMatch(/ disabled=""/);
    expect(buttonTag(html, "Dia anterior")).not.toMatch(/ disabled=""/);
  });

  it("a month GGR total makes the day's GGR read-only", () => {
    const html = renderToStaticMarkup(<DayModalContent {...props({ usingMonthlyGgr: true })} />);
    expect(html).toContain("usando o total do mês");
    expect(html).not.toContain('aria-label="GGR (Perdas na casa)"');
    expect(html).toContain('aria-label="Anúncios"');
  });

  it("read-only shows values without inputs or Salvar", () => {
    const html = renderToStaticMarkup(<DayModalContent {...props({ readOnly: true })} />);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Salvar");
    expect(html).not.toContain("Usar valor da Meta");
    expect(html).toContain("Gasto da Meta");
    expect(html).not.toContain("Editar em Outros custos");
  });

  it("a pending save disables both nav buttons and the Outros custos link", () => {
    const html = renderToStaticMarkup(
      <DayModalContent
        {...props({ saving: true, onEditCosts: () => {} })}
        neighbors={{ prev: "2026-10-27", next: "2026-10-29" }}
      />,
    );
    expect(buttonTag(html, "Dia anterior")).toMatch(/ disabled=""/);
    expect(buttonTag(html, "Próximo dia")).toMatch(/ disabled=""/);
    expect(buttonTag(html, "Editar em Outros custos")).toMatch(/ disabled=""/);
  });

  it("links the day's costs to Outros custos when editable", () => {
    const html = renderToStaticMarkup(<DayModalContent {...props({ onEditCosts: () => {} })} />);
    expect(html).toContain("Editar em Outros custos");
  });
});
