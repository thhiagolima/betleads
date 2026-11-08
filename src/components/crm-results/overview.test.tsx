import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type CrmMetrics, withRatios } from "@/lib/crm-results";
import type { Data } from "./format";
import { Overview } from "./overview";

vi.mock("@/hooks/use-tenant-currency", async () => {
  const { formatMoney } = await import("@/lib/currency");
  return {
    useMoney: () => ({
      currency: "BRL",
      money: (value: number | null | undefined) => formatMoney(value, "BRL"),
      symbol: "R$",
    }),
  };
});
vi.mock("@/lib/crm-recommendations", () => ({ buildRecommendations: () => [] }));

const metrics = (overrides: Partial<CrmMetrics>) =>
  withRatios({
    sent: 0,
    failed: 0,
    cost: 0,
    recipients: 0,
    humanClicks: 0,
    convertedClicks: 0,
    directConversions: 0,
    directPlayers: 0,
    directRevenue: 0,
    directActivePlayers: 0,
    directActiveRevenue: 0,
    influencedPlayers: 0,
    influencedDeposits: 0,
    influencedRevenue: 0,
    ...overrides,
  });

// The day of the screenshot that started the redesign (08/11, "Hoje").
const data = {
  from: "2026-11-08",
  to: "2026-11-08",
  days: 1,
  endOffset: 0,
  previous: {
    from: "2026-11-01",
    to: "2026-11-01",
    totals: {
      ...metrics({ sent: 59_000, cost: 3480, directPlayers: 12, directRevenue: 3600 }),
      costOnActive: 0,
    },
  },
  rolling: {
    from: "2026-11-02",
    to: "2026-11-08",
    totals: {
      ...metrics({ sent: 64_000, cost: 3800, directPlayers: 9, directRevenue: 2400 }),
      costOnActive: 0,
    },
  },
  totals: {
    ...metrics({
      sent: 4722,
      cost: 278.6,
      humanClicks: 70,
      convertedClicks: 4,
      directPlayers: 8,
      directRevenue: 2197.32,
      directActivePlayers: 32,
      directActiveRevenue: 5231.68,
      influencedPlayers: 37,
      influencedRevenue: 1811.32,
    }),
    costOnActive: 0,
  },
  sources: [],
  daily: [],
  holdout: [],
  holdoutSetup: [],
} as unknown as Data;

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .split(String.fromCharCode(160))
    .join(" ");

describe("Overview", () => {
  const text = plain(
    renderToStaticMarkup(<Overview data={data} onOpenOrigin={() => {}} onOpenProof={() => {}} />),
  );

  it("keeps the funnel on one cohort: converted clicks, not the day's players", () => {
    expect(text).toContain("4 cliques viraram depósito (5,7%, ainda pode subir)");
    expect(text).toContain("8 jogadores voltaram pelo link");
  });

  it("splits the deposits after the click into recovered and already playing", () => {
    expect(text).toContain("Depositaram depois de clicar: 40 jogadores · R$ 7.429,00");
    expect(text).toContain("Já estavam jogando R$ 5.231,68 (32)");
    expect(text).not.toContain("Fora da conta");
    expect(text).not.toContain("visão ampla");
  });

  it("shows small samples as an absolute difference against the same weekday", () => {
    expect(text).toContain("−R$ 1.402,68 vs dom 01/11");
    expect(text).not.toMatch(/[▲▼] \d+%/);
    expect(text).toContain("Foram enviados 92% menos SMS que em dom 01/11");
  });

  it("reads the return of a single day over the last 7 days", () => {
    expect(text).toContain("Cada R$ 1 em SMS trouxe");
    expect(text).toContain("R$ 0,63");
    expect(text).toContain("últimos 7 dias (02/11 a 08/11)");
  });

  it("says when there is no control group to prove the effect", () => {
    expect(text).toContain("Sem prova de efeito ainda: ative o grupo de controle nas jornadas.");
  });
});
