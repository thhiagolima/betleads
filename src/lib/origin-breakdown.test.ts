import { describe, expect, it } from "vitest";
import {
  buildOriginBreakdown,
  canLabel,
  canRule,
  delta,
  originPlayersCsv,
  perSignupWindow,
  previousRange,
  REFERRAL_KEY,
  buildUtmLink,
  coverageLevel,
  META_UTM_PRESET,
  nextGroup,
  originCsv,
  pathFilters,
  rowDisplay,
  shortId,
} from "./origin-breakdown";

const RAW = {
  period: { from: "2026-11-01", to: "2026-11-07" },
  group: "campaign",
  totals: { signups: "10", ftd: 4, ftdValue: "200.5", deposits: 900, withdrawals: 100, net: 800 },
  coverage: { signups: 10, withUtm: 6, affiliateOnly: 1, clickOnly: 1, noOrigin: 2 },
  noOrigin: { signups: 2, ftd: 1, ftdValue: 10, deposits: 50, withdrawals: 0 },
  crm: { signups: 3 },
  canEdit: true,
  totalRows: 3,
  rows: [
    {
      key: "120250280510370075",
      raw: "120250280510370075",
      channel: "meta",
      metaName: "CBO Novembro",
      signups: 5,
      ftd: 2,
      ftdValue: 100,
      deposits: 600,
      withdrawals: 50,
    },
    {
      key: "=cmd",
      raw: "=cmd",
      channel: "outros",
      metaName: null,
      signups: 1,
      ftd: 0,
      ftdValue: 0,
      deposits: 0,
      withdrawals: 0,
    },
  ],
  others: { count: 1, signups: 2, ftd: 1, ftdValue: 5, deposits: 10, withdrawals: 0 },
  daily: [{ date: "2026-11-01", signups: "3", withOrigin: 2, ftd: 1 }],
};

describe("buildOriginBreakdown", () => {
  it("converte numeric em number e tolera campos ausentes", () => {
    const b = buildOriginBreakdown(RAW);
    expect(b.totals.signups).toBe(10);
    expect(b.totals.ftdValue).toBe(200.5);
    expect(b.daily[0].signups).toBe(3);
    expect(b.group).toBe("campaign");

    const empty = buildOriginBreakdown(null);
    expect(empty.rows).toEqual([]);
    expect(empty.group).toBe("channel");
    expect(empty.coverage.signups).toBe(0);
  });
});

describe("rowDisplay", () => {
  it("canal tem nome nosso", () => {
    expect(rowDisplay("channel", { key: "afiliados", raw: "afiliados", metaName: null }).name).toBe(
      "Afiliados e indicação",
    );
    expect(rowDisplay("channel", { key: "novo", raw: "novo", metaName: null }).name).toBe("novo");
  });

  it("ID da Meta: nome do catálogo, ou ID abreviado sem nome", () => {
    expect(
      rowDisplay("campaign", {
        key: "120250280510370075",
        raw: "120250280510370075",
        metaName: "CBO",
      }),
    ).toEqual({ name: "CBO", detail: "120250280510370075", unnamedId: false, source: "meta" });
    expect(
      rowDisplay("campaign", {
        key: "120250280510370075",
        raw: "120250280510370075",
        metaName: null,
      }),
    ).toEqual({ name: "1202…0075", detail: "120250280510370075", unnamedId: true, source: null });
  });

  it("valor vazio e texto comum", () => {
    expect(rowDisplay("term", { key: null, raw: null, metaName: null }).name).toBe(
      "(sem conjunto)",
    );
    expect(
      rowDisplay("campaign", { key: "cbo la ele", raw: "CBO LA ELE", metaName: null }).name,
    ).toBe("CBO LA ELE");
  });

  it("shortId só abrevia IDs longos", () => {
    expect(shortId("12345")).toBe("12345");
    expect(shortId("120250280510370075")).toBe("1202…0075");
  });
});

describe("drill-down", () => {
  it("segue canal → fonte → meio → campanha → conjunto → anúncio", () => {
    expect(nextGroup("channel", "meta")).toBe("source");
    expect(nextGroup("source", "ig")).toBe("medium");
    expect(nextGroup("medium", "paid")).toBe("campaign");
    expect(nextGroup("campaign", "x")).toBe("term");
    expect(nextGroup("term", "x")).toBe("content");
    expect(nextGroup("content", "x")).toBeNull();
  });

  it("afiliados abre por afiliado; só clique da Meta não abre", () => {
    expect(nextGroup("channel", "afiliados")).toBe("affiliate");
    expect(nextGroup("channel", "meta_sem_campanha")).toBeNull();
    expect(nextGroup("affiliate", "abc")).toBeNull();
  });

  it("o caminho vira filtros, com null para valor vazio", () => {
    expect(
      pathFilters([
        { group: "channel", key: "meta", name: "Meta" },
        { group: "source", key: null, name: "(sem fonte)" },
      ]),
    ).toEqual({ channel: "meta", source: null });
  });
});

describe("coverageLevel", () => {
  const c = (signups: number, noOrigin: number) => ({
    signups,
    noOrigin,
    withUtm: 0,
    affiliateOnly: 0,
    clickOnly: 0,
  });
  it("classifica a cobertura", () => {
    expect(coverageLevel(c(0, 0)).level).toBe("empty");
    expect(coverageLevel(c(10, 10)).level).toBe("none");
    expect(coverageLevel(c(100, 90)).level).toBe("low");
    expect(coverageLevel(c(100, 50)).level).toBe("partial");
    expect(coverageLevel(c(100, 10)).level).toBe("good");
  });
});

describe("originCsv", () => {
  it("uma linha por valor, mais outros e sem origem, com fórmula neutralizada", () => {
    const b = buildOriginBreakdown(RAW);
    const csv = originCsv(b, [{ group: "channel", key: "meta", name: "Meta" }], "BRL").split("\n");
    expect(csv[0]).toContain('"deposito_liquido_brl"');
    expect(csv).toHaveLength(5);
    expect(csv[1]).toContain('"Canal: Meta"');
    expect(csv[1]).toContain('"120250280510370075","CBO Novembro"');
    expect(csv[1]).toContain('"550.00"');
    // Sem cadastro maduro: janelas vazias.
    expect(csv[1].endsWith('"",""')).toBe(true);
    expect(csv[2]).toContain(`"'=cmd"`);
    expect(csv[3]).toContain('"Outros 1"');
    expect(csv[4]).toContain('"Sem origem informada"');
  });
});

describe("buildUtmLink", () => {
  it("monta o link e mantém as macros da Meta", () => {
    expect(
      buildUtmLink("https://casa.com/cadastro?ref=1", {
        source: "kwai",
        medium: "paid",
        campaign: "black nov",
      }),
    ).toBe(
      "https://casa.com/cadastro?ref=1&utm_source=kwai&utm_medium=paid&utm_campaign=black+nov",
    );
    const meta = buildUtmLink("https://casa.com", META_UTM_PRESET);
    expect(meta).toContain("utm_campaign={{campaign.id}}");
    expect(meta).toContain("utm_content={{ad.id}}");
  });

  it("recusa URL inválida ou que não é http", () => {
    expect(buildUtmLink("casa.com", { source: "a", medium: "b", campaign: "c" })).toBeNull();
    expect(
      buildUtmLink("javascript:alert(1)", { source: "a", medium: "b", campaign: "c" }),
    ).toBeNull();
  });
});

describe("U2/U3", () => {
  it("apelido vence o nome da Meta; indicação tem nome próprio", () => {
    expect(
      rowDisplay("campaign", { key: "1202", raw: "1202", metaName: "CBO", label: "Pasteleiro" }),
    ).toEqual({ name: "Pasteleiro", detail: "1202", unnamedId: false, source: "label" });
    expect(
      rowDisplay("affiliate", { key: REFERRAL_KEY, raw: REFERRAL_KEY, metaName: null }).name,
    ).toBe("Indicação entre jogadores");
    expect(rowDisplay("affiliate", { key: "aff9", raw: "AFF9", metaName: "Fulano" }).source).toBe(
      "expert",
    );
  });

  it("o que pode ganhar nome e regra", () => {
    expect(canLabel("channel", "meta")).toBe(false);
    expect(canLabel("campaign", null)).toBe(false);
    expect(canLabel("affiliate", REFERRAL_KEY)).toBe(false);
    expect(canLabel("content", "x")).toBe(true);
    expect(canRule("source", "kwai")).toBe(true);
    expect(canRule("term", "x")).toBe(false);
  });

  it("janelas de 7/30 dias só com coorte madura", () => {
    const m = { signups: 10, ftd: 0, ftdValue: 0, deposits: 0, withdrawals: 0 };
    expect(perSignupWindow({ ...m, mature7: 4, net7: 100, mature30: 0, net30: 0 }, 7)).toBe(25);
    expect(perSignupWindow({ ...m, mature7: 4, net7: 100, mature30: 0, net30: 0 }, 30)).toBeNull();
  });

  it("período anterior de mesmo tamanho e variação", () => {
    expect(previousRange("2026-11-08", "2026-11-14")).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(previousRange("2026-11-01", "2026-11-01")).toEqual({
      from: "2026-10-31",
      to: "2026-10-31",
    });
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
    expect(delta(110, 100)).toBeCloseTo(0.1);
    expect(delta(5, 0)).toBeNull();
    expect(delta(-50, -100)).toBeCloseTo(0.5);
  });

  it("CSV de jogadores com todas as UTMs", () => {
    const csv = originPlayersCsv(
      [
        {
          id: "p1",
          nome: "=Ana",
          createdAt: "2026-11-01T12:00:00Z",
          channel: "afiliados",
          source: null,
          medium: null,
          campaign: null,
          term: null,
          content: null,
          affiliate: "AFF9",
          referral: null,
          expert: "Fulano",
          ftd: true,
          ftdValue: 50,
          deposits: 150,
          withdrawals: 30,
        },
      ],
      "BRL",
    ).split("\n");
    expect(csv[0]).toContain('"deposito_liquido_brl"');
    expect(csv[1]).toContain(`"'=Ana"`);
    expect(csv[1]).toContain('"Afiliados e indicação"');
    expect(csv[1]).toContain('"sim","50.00","150.00","30.00","120.00"');
  });
});
