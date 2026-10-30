import { describe, expect, it } from "vitest";
import {
  INSIGHT_FIELDS,
  accountToday,
  catalogRow,
  catalogRowsFromInsights,
  insightRow,
  syncWindow,
  syncWindows,
} from "./meta-sync-rows";

describe("AL1-02 janela no fuso da conta", () => {
  // 19/10/2026 01:30 UTC: 18/10 em Brasília, 19/10 em Lisboa, 18/10 em Nova York.
  const now = new Date("2026-10-19T01:30:00Z");

  it("hoje é o dia da conta, não o dia UTC do servidor", () => {
    expect(accountToday("America/Sao_Paulo", now)).toBe("2026-10-18");
    expect(accountToday("Europe/Lisbon", now)).toBe("2026-10-19");
    expect(accountToday("America/New_York", now)).toBe("2026-10-18");
  });

  it("fuso ausente ou inválido cai em Brasília", () => {
    expect(accountToday(null, now)).toBe("2026-10-18");
    expect(accountToday("Lugar/Inexistente", now)).toBe("2026-10-18");
  });

  it("a janela termina hoje e conta as duas pontas", () => {
    expect(syncWindow("America/Sao_Paulo", 7, now)).toEqual({
      since: "2026-10-12",
      until: "2026-10-18",
    });
    expect(syncWindow("America/Sao_Paulo", 1, now)).toEqual({
      since: "2026-10-18",
      until: "2026-10-18",
    });
  });
});

describe("D4 janela partida em blocos de 30 dias", () => {
  const now = new Date("2026-10-19T01:30:00Z"); // 18/10 em Brasília

  it("até 30 dias é um bloco só, igual ao syncWindow", () => {
    expect(syncWindows("America/Sao_Paulo", 7, now)).toEqual([
      syncWindow("America/Sao_Paulo", 7, now),
    ]);
    expect(syncWindows("America/Sao_Paulo", 30, now)).toEqual([
      syncWindow("America/Sao_Paulo", 30, now),
    ]);
  });

  it("90 dias viram 3 blocos consecutivos, do mais antigo ao mais recente", () => {
    const chunks = syncWindows("America/Sao_Paulo", 90, now);
    expect(chunks).toEqual([
      { since: "2026-07-21", until: "2026-08-19" },
      { since: "2026-08-20", until: "2026-09-18" },
      { since: "2026-09-19", until: "2026-10-18" },
    ]);
    expect(chunks[0].since).toBe(syncWindow("America/Sao_Paulo", 90, now).since);
  });

  it("o último bloco é menor quando a janela não divide por 30, no fuso da conta", () => {
    expect(syncWindows("Europe/Lisbon", 31, now)).toEqual([
      { since: "2026-09-19", until: "2026-10-18" },
      { since: "2026-10-19", until: "2026-10-19" },
    ]);
  });
});

describe("AL1-03 / AL1-07 linhas de insight", () => {
  it("pede cliques no link e a moeda da conta", () => {
    expect(INSIGHT_FIELDS.split(",")).toEqual(
      expect.arrayContaining(["inline_link_clicks", "account_currency"]),
    );
  });

  it("grava cliques no link e a moeda, com a da conta como reserva", () => {
    const row = insightRow(
      {
        date_start: "2026-10-18",
        ad_id: "1",
        ad_name: "A",
        spend: "12.5",
        impressions: "1000",
        clicks: "40",
        inline_link_clicks: "25",
      },
      "usd",
    );
    expect(row).toMatchObject({
      metric_date: "2026-10-18",
      spend: 12.5,
      impressions: 1000,
      clicks: 40,
      link_clicks: 25,
      currency: "USD",
      creative_name: "A",
    });
    expect(insightRow({ account_currency: "brl" }, "USD").currency).toBe("BRL");
    expect(insightRow({}, null).currency).toBe("BRL");
  });
});

describe("AL1-08 catálogo", () => {
  it("guarda campanha, conjunto e miniatura do criativo", () => {
    const row = catalogRow(
      "t",
      "act_1",
      {
        id: "ad1",
        name: "Video",
        effective_status: "ACTIVE",
        campaign: { id: "c1", name: "Camp" },
        adset: { id: "s1", name: "Publico" },
        creative: { id: "cr1", thumbnail_url: "https://img/1.jpg" },
      },
      "2026-10-18T00:00:00Z",
    );
    expect(row).toMatchObject({
      ad_id: "ad1",
      campaign_id: "c1",
      adset_id: "s1",
      creative_id: "cr1",
      thumbnail_url: "https://img/1.jpg",
      effective_status: "ACTIVE",
    });
  });

  it("anúncios com entrega fora da lista de ativos entram uma vez, sem os já conhecidos", () => {
    const rows = catalogRowsFromInsights(
      "t",
      "act_1",
      [
        { ad_id: "ad1", ad_name: "Ativo" },
        { ad_id: "ad2", ad_name: "Pausado", campaign_id: "c2" },
        { ad_id: "ad2", ad_name: "Pausado", campaign_id: "c2" },
        { ad_name: "sem id" },
      ],
      new Set(["ad1"]),
      "2026-10-18T00:00:00Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ad_id: "ad2", campaign_id: "c2", thumbnail_url: null });
  });
});
