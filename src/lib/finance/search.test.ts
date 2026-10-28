import { describe, expect, it } from "vitest";

import { launchPendingSearch, parseFinanceSearch } from "./search";

describe("parseFinanceSearch", () => {
  it("keeps valid tab, month and dia", () => {
    expect(parseFinanceSearch({ tab: "lancamentos", month: "2026-10", dia: "2026-10-12" })).toEqual(
      { tab: "lancamentos", month: "2026-10", dia: "2026-10-12" },
    );
  });

  it("drops unknown tabs and malformed dates (the default tab is Painel)", () => {
    expect(parseFinanceSearch({})).toEqual({});
    expect(parseFinanceSearch({ tab: "mes", month: "2026-1", dia: "12/10/2026" })).toEqual({});
    expect(parseFinanceSearch({ tab: 3, month: 202610 })).toEqual({});
  });

  it("restricts tabs to the allowed list", () => {
    expect(parseFinanceSearch({ tab: "configuracoes" }, ["painel", "lancamentos"])).toEqual({});
    expect(parseFinanceSearch({ tab: "painel" }, ["painel", "lancamentos"])).toEqual({
      tab: "painel",
    });
  });
});

describe("launchPendingSearch", () => {
  it("opens Lançamentos on the month of the date, focused on that day", () => {
    expect(launchPendingSearch("2026-09-28")).toEqual({
      tab: "lancamentos",
      month: "2026-09",
      dia: "2026-09-28",
    });
  });
});
