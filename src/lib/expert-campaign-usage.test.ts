import { describe, expect, it } from "vitest";

import {
  expertCapBlockReason,
  expertEstimatedCost,
  expertPendingText,
  expertUsageView,
  nextMonthStartLabel,
  remainingAfterSend,
  type ExpertCampaignUsageData,
} from "./expert-campaign-usage";

const nbsp = (text: string | null) => (text ?? "").replace(/\u00a0/g, " ");

function usage(overrides: Partial<ExpertCampaignUsageData> = {}): ExpertCampaignUsageData {
  return {
    teto: 100,
    usado: 10,
    restante: 90,
    pendentes: 0,
    pendentesEstimado: 0,
    mes: "2026-10",
    ...overrides,
  };
}

describe("expertUsageView", () => {
  it("normal usage: used × cap with a primary bar", () => {
    const view = expertUsageView(usage());
    expect(view.state).toBe("ok");
    expect(view.percent).toBe(10);
    expect(nbsp(view.headline)).toBe("Uso do mês: R$ 10,00 de R$ 100,00");
    expect(view.barClass).toBe("bg-primary");
    expect(view.detail).toBeNull();
  });

  it("amber from 80%", () => {
    const view = expertUsageView(usage({ usado: 80, restante: 20 }));
    expect(view.state).toBe("alerta");
    expect(view.barClass).toBe("bg-warning");
  });

  it("red at 100% with the blocked explanation and next month", () => {
    const view = expertUsageView(usage({ usado: 100, restante: 0 }));
    expect(view.state).toBe("atingido");
    expect(view.percent).toBe(100);
    expect(view.barClass).toBe("bg-danger");
    expect(view.detail).toBe(
      "Teto atingido; novos envios voltam em 01/11 ou quando o admin aumentar o teto.",
    );
  });

  it("no cap", () => {
    const view = expertUsageView(usage({ teto: null, restante: null, usado: 42 }));
    expect(view.state).toBe("sem_teto");
    expect(view.percent).toBeNull();
    expect(view.detail).toBe("Sem teto definido");
    expect(nbsp(view.headline)).toBe("Uso do mês: R$ 42,00");
  });

  it("cap R$ 0 blocks everything", () => {
    const view = expertUsageView(usage({ teto: 0, restante: 0, usado: 0 }));
    expect(view.state).toBe("bloqueado");
    expect(view.headline).toBe("Envios bloqueados (teto R$ 0)");
  });
});

describe("expert cap helpers", () => {
  it("wraps December to January", () => {
    expect(nextMonthStartLabel("2026-12")).toBe("01/01");
    expect(nextMonthStartLabel("2026-03")).toBe("01/04");
  });

  it("pending text only with pending campaigns", () => {
    expect(expertPendingText(usage())).toBeNull();
    expect(nbsp(expertPendingText(usage({ pendentes: 2, pendentesEstimado: 12 })))).toBe(
      "2 campanhas aguardando aprovação · R$ 12,00 estimados",
    );
  });

  it("remaining after this send", () => {
    expect(remainingAfterSend(usage(), 30)).toBe(60);
    expect(remainingAfterSend(usage({ teto: null, restante: null }), 30)).toBeNull();
    expect(remainingAfterSend(undefined, 30)).toBeNull();
  });

  it("block reason: none within the cap, explained above it, always at cap 0", () => {
    expect(expertCapBlockReason(usage(), 90)).toBeNull();
    expect(expertCapBlockReason(usage({ teto: null, restante: null }), 10_000)).toBeNull();
    expect(nbsp(expertCapBlockReason(usage(), 95))).toContain(
      "custa cerca de R$ 95,00, mas restam R$ 90,00",
    );
    expect(expertCapBlockReason(usage({ teto: 0, restante: 0 }), 0)).toContain("bloqueados");
    expect(expertCapBlockReason(usage({ usado: 100, restante: 0 }), 0)).toContain("Teto atingido");
  });

  it("estimated cost: SMS by segments, e-mail by recipient, voice from the server", () => {
    const prices = { sms: 0.08, email: 0.01, voice_30s: 0.5 };
    expect(
      expertEstimatedCost({
        channel: "sms",
        recipients: 100,
        smsSegments: 2,
        prices,
        serverEstimate: null,
      }),
    ).toBe(16);
    expect(
      expertEstimatedCost({
        channel: "email",
        recipients: 100,
        smsSegments: 1,
        prices,
        serverEstimate: null,
      }),
    ).toBe(1);
    expect(
      expertEstimatedCost({
        channel: "voice",
        recipients: 10,
        smsSegments: 1,
        prices,
        serverEstimate: 7.5,
      }),
    ).toBe(7.5);
    expect(
      expertEstimatedCost({
        channel: "sms",
        recipients: 0,
        smsSegments: 1,
        prices,
        serverEstimate: null,
      }),
    ).toBe(0);
  });
});
