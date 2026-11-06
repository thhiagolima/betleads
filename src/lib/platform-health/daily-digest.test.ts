import { describe, expect, it } from "vitest";

import type { Debtor } from "@/lib/billing/billing-state-summary";

import type { StoredAlert } from "./alert-lifecycle";
import { buildDailyDigest } from "./daily-digest";
import type { HouseHealthRow } from "./house-health";

function alert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "a1",
    alertKey: "job:a",
    kind: "job",
    severity: "critical",
    message: "Robô parado",
    tenantId: null,
    href: "/admin#saude",
    openedAt: "2026-11-05T12:00:00.000Z",
    lastSeenAt: "2026-11-05T12:00:00.000Z",
    seenCount: 1,
    acknowledgedAt: null,
    silencedUntil: null,
    lastNotifiedAt: null,
    ...overrides,
  };
}

function house(overrides: Partial<HouseHealthRow> = {}): HouseHealthRow {
  return {
    tenantId: "t1",
    name: "Casa A",
    moeda: "BRL",
    level: "red",
    reason: "Cadastros -60%",
    current: { registrations: 1, ftds: 0, recovered: 0, conversion: null },
    base: { registrations: 5, ftds: 1, recovered: 10, conversion: 0.2 },
    deltas: { registrationsPct: -60, ftdsPct: null, conversionPts: null, recoveredPct: null },
    worstDelta: -60,
    ...overrides,
  };
}

function debtor(overrides: Partial<Debtor> = {}): Debtor {
  return {
    tenantId: "t2",
    name: "Casa B",
    amountCents: 400000,
    daysOverdue: 5,
    bucket: "overdue",
    ...overrides,
  };
}

describe("buildDailyDigest", () => {
  it("renders the three sections with their content and the Saúde link", () => {
    const { html } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [alert()],
      houses: [house()],
      debtors: [debtor()],
      owedCents: 400000,
    });

    expect(html).toContain("Alertas abertos");
    expect(html).toContain("Robô parado");
    expect(html).toContain("Casas em vermelho/amarelo");
    expect(html).toContain("Casa A");
    expect(html).toContain("Cadastros -60%");
    expect(html).toContain("Quem está devendo");
    expect(html).toContain("Casa B");
    expect(html).toContain("Abrir a aba Saúde");
    expect(html).toContain("https://betleads.io/admin#saude");
  });

  it("shows 'Nada aqui hoje.' for every empty section", () => {
    const { html } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [],
      houses: [],
      debtors: [],
      owedCents: 0,
    });

    const occurrences = html.split("Nada aqui hoje.").length - 1;
    // Alertas abertos, Casas em vermelho/amarelo, Quem está devendo (silenciados
    // is a 4th section but has its own empty case too — it is also empty here).
    expect(occurrences).toBe(4);
  });

  it("lists silenced alerts separately, after the active ones", () => {
    const { html } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [
        alert({ alertKey: "job:a", message: "Ativo" }),
        alert({
          alertKey: "job:b",
          message: "Calado",
          silencedUntil: "2026-11-06T00:00:00.000Z",
        }),
      ],
      houses: [],
      debtors: [],
      owedCents: 0,
    });

    expect(html).toContain("Silenciados");
    const activeIdx = html.indexOf("Ativo");
    const silencedHeadingIdx = html.indexOf("Silenciados");
    const calmIdx = html.indexOf("Calado");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(calmIdx).toBeGreaterThan(silencedHeadingIdx);
  });

  it("puts critical alerts before warnings in 'Alertas abertos'", () => {
    const { html } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [
        alert({ alertKey: "warn:1", severity: "warning", message: "Aviso" }),
        alert({ alertKey: "crit:1", severity: "critical", message: "Crítico" }),
      ],
      houses: [],
      debtors: [],
      owedCents: 0,
    });

    expect(html.indexOf("Crítico")).toBeLessThan(html.indexOf("Aviso"));
  });

  it("subject counts open alerts and red houses in pt-BR", () => {
    const { subject } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [alert({ alertKey: "a" }), alert({ alertKey: "b" })],
      houses: [house({ level: "red" }), house({ tenantId: "t3", level: "yellow" })],
      debtors: [],
      owedCents: 0,
    });

    expect(subject).toBe("BetLeads — resumo de 05/11: 2 alertas, 1 casas em vermelho");
  });

  it("escapes a house name containing <script>", () => {
    const { html } = buildDailyDigest({
      day: "2026-11-05",
      openAlerts: [],
      houses: [house({ name: "<script>alert(1)</script>" })],
      debtors: [],
      owedCents: 0,
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
