import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { SendLine } from "@/lib/finance/types";

import { EXEMPT_HOUSE_NOTE, SendsBlock, sendsBetleadsNote } from "./sends-block";
import { kpis } from "./test-fixtures";

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/** The markup of one row (data-send="<key>") up to the next row. */
function row(html: string, key: string) {
  const start = html.indexOf(`data-send="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-send=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

const line = (overrides: Partial<SendLine> & Pick<SendLine, "item" | "label">): SendLine => ({
  unitLabel: "envios",
  units: 0,
  amount: 0,
  unitCost: null,
  previousAmount: null,
  missingCost: false,
  ...overrides,
});

const lines: SendLine[] = [
  line({
    item: "sms",
    label: "SMS",
    unitLabel: "envios",
    units: 12000,
    amount: 1440,
    unitCost: 0.12,
    previousAmount: 1200,
  }),
  line({
    item: "voice_30s",
    label: "Voz",
    unitLabel: "blocos de 30 s",
    units: 300,
    amount: 0,
    missingCost: true,
  }),
  line({
    item: "email",
    label: "E-mail",
    unitLabel: "e-mails",
    units: 5000,
    amount: 2,
    unitCost: 0.0004,
    previousAmount: 4,
  }),
];

describe("SendsBlock", () => {
  it("SendsBlock shows each channel with quantity and the missing-cost text", () => {
    const html = render(
      <SendsBlock
        lines={lines}
        kpis={{
          current: kpis({
            sendCost: 1442,
            crmDirectRevenue: 2884,
            crmDirectReturn: 2,
            crmInfluencedRevenue: 7210,
            crmInfluencedReturn: 5,
          }),
          previous: kpis({ sendCost: 1204, crmDirectReturn: 1.5 }),
        }}
        exemptHouse={false}
        betleadsNote={null}
      />,
    );

    const sms = row(html, "sms");
    expect(sms).toContain("SMS");
    expect(sms).toContain("12.000 envios");
    expect(sms).toContain("R$ 1.440,00");
    expect(sms).toContain("R$ 0,12");
    expect(sms).toContain("▲ 20,0%");
    expect(sms).toContain("text-rose-400"); // a cost going up is bad

    const voice = row(html, "voice_30s");
    expect(voice).toContain("Voz");
    expect(voice).toContain("300 blocos de 30 s");
    expect(voice).toContain("custo do provedor não cadastrado");
    expect(voice).not.toContain("R$ 0,00");

    const email = row(html, "email");
    expect(email).toContain("5.000 e-mails");
    expect(email).toContain("R$ 0,0004");
    expect(email).toContain("▼ 50,0%");
    expect(email).toContain("text-emerald-400");

    const total = row(html, "total");
    expect(total).toContain("Envios");
    expect(total).toContain("R$ 1.442,00");
    expect(total).toContain('aria-label="Como calculamos"');

    expect(row(html, "direct")).toContain("Receita direta");
    expect(row(html, "direct")).toContain("R$ 2.884,00");
    expect(row(html, "direct-return")).toContain("Retorno direto");
    expect(row(html, "direct-return")).toContain("200,0%");
    expect(row(html, "influenced")).toContain("Receita influenciada");
    expect(row(html, "influenced-return")).toContain("Retorno influenciado");
    expect(row(html, "influenced-return")).toContain("500,0%");

    expect(html).not.toContain(EXEMPT_HOUSE_NOTE);
    expect(html).not.toContain("Sem dado de custo Betleads");
  });

  it("shows the Betleads note and the exempt-house note in the block", () => {
    const html = render(
      <SendsBlock
        lines={[]}
        kpis={{ current: kpis(), previous: kpis() }}
        exemptHouse
        betleadsNote="Sem dado de custo Betleads antes de out/2026"
      />,
    );

    expect(EXEMPT_HOUSE_NOTE).toBe("Casa isenta: custo do provedor (situação atual da casa)");
    expect(html).toContain(EXEMPT_HOUSE_NOTE);
    expect(html).toContain("Sem dado de custo Betleads antes de out/2026");
    expect(html).toContain("Sem envios no período.");
    expect(row(html, "direct-return")).toContain("n.a.");
  });
});

describe("sendsBetleadsNote", () => {
  it("notes the window starting before the first Betleads data", () => {
    expect(sendsBetleadsNote("2026-10-01", "2026-10-22")).toBe(
      "Sem dado de custo Betleads antes de out/2026",
    );
    expect(sendsBetleadsNote("2026-10-01", null)).toBe("Sem dado de custo Betleads");
    expect(sendsBetleadsNote("2026-10-22", "2026-10-22")).toBeNull();
    expect(sendsBetleadsNote("2026-10-25", "2026-10-22")).toBeNull();
  });
});
