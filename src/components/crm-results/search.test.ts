import { describe, expect, it } from "vitest";

import { TABS, validateCentralSearch } from "./search";

describe("validateCentralSearch", () => {
  it("has the three Central tabs", () => {
    expect(TABS.map((tab) => tab.key)).toEqual(["visao", "origens", "controle"]);
  });

  it("keeps retired tab keys so old links can be redirected or fall back", () => {
    expect(validateCentralSearch({ aba: "base" }).aba).toBe("base");
    expect(validateCentralSearch({ aba: "recomendacoes" }).aba).toBe("recomendacoes");
  });

  it("drops unknown tabs and periods", () => {
    expect(validateCentralSearch({ aba: "x", periodo: "2" })).toEqual({});
  });
});
