import { describe, expect, it } from "vitest";

import { crmResultsCsv } from "./crm-results-csv";
import { aggregateCrmResults, type CrmResultRow } from "./crm-results";

const row = (overrides: Partial<CrmResultRow>): CrmResultRow => ({
  metric_date: "2026-10-10",
  source_type: "journey",
  source_key: "j",
  source_id: "j",
  step_position: 0,
  player_state: "esfriando",
  sent: 0,
  failed: 0,
  cost: 0,
  recipients: 0,
  human_clicks: 0,
  direct_conversions: 0,
  direct_revenue: 0,
  influenced_players: 0,
  influenced_deposits: 0,
  influenced_revenue: 0,
  ...overrides,
});

describe("crmResultsCsv", () => {
  const results = aggregateCrmResults(
    [
      row({ sent: 10, cost: 1, influenced_players: 2, influenced_revenue: 50 }),
      row({ step_position: 1, sent: 5, cost: 0.5 }),
      row({
        source_type: "campaign",
        source_key: 'Promo "VIP"',
        source_id: null,
        step_position: -1,
        player_state: "ativo",
        sent: 4,
        cost: 0.4,
      }),
    ],
    { j: "Esfriando" },
  );
  const lines = crmResultsCsv(results, { from: "2026-10-01", to: "2026-10-10" })
    .replace("﻿", "")
    .split("\n");

  it("writes header, total, each origin and its journey steps", () => {
    expect(lines).toHaveLength(1 + 1 + 2 + 2);
    expect(lines[1]).toContain('"total","Todas as origens"');
    expect(lines.some((line) => line.includes('"jornada","Esfriando","2"'))).toBe(true);
  });

  it("matches the totals shown on screen", () => {
    expect(lines[1].split(",")[5]).toBe('"19"');
    expect(lines[1].split(",")[8]).toBe('"1.90"');
  });

  it("has one cell per header column on every line", () => {
    const cells = (line: string) => line.match(/"(?:[^"]|"")*"/g)?.length ?? 0;
    const width = cells(lines[0]);
    expect(lines.every((line) => cells(line) === width)).toBe(true);
    expect(lines[0]).toContain('"jogadores_que_voltaram_pelo_link"');
  });

  it("escapes quotes in names", () => {
    expect(lines.some((line) => line.includes('"Promo ""VIP"""'))).toBe(true);
  });

  it("names the currency of each money column (cost in BRL, revenue in the house currency)", () => {
    expect(lines[0]).toContain('"custo_brl"');
    expect(lines[0]).toContain('"recuperado_pelo_crm_brl"');
    expect(lines[0]).toContain('"custo_por_jogador_que_voltou_brl"');
  });

  it("uses the house currency for revenue and leaves the return blank outside BRL", () => {
    const ars = crmResultsCsv(results, { from: "2026-10-01", to: "2026-10-10" }, "ARS")
      .replace("﻿", "")
      .split("\n");
    const cells = (line: string): string[] => line.match(/"(?:[^"]|"")*"/g) ?? [];
    const cols = cells(ars[0]);
    expect(cols).toContain('"depositado_3d_reativacoes_ars"');
    expect(cols).toContain('"custo_brl"');
    const roi = cols.indexOf('"retorno_reativacoes"');
    const total = cells(ars[1]);
    expect(total[roi]).toBe('""');
    const brlTotal = cells(lines[1]);
    expect(brlTotal[roi]).toBe('"26.32"');
  });
});
