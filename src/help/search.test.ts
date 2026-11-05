import { describe, expect, it } from "vitest";
import { buildSearchIndex, normalizeSearchText, searchHelp, type SearchEntry } from "./search";
import type { HelpScreen } from "./types";

describe("searchHelp", () => {
  const idx: SearchEntry[] = [
    { kind: "item", title: "Adicionar domínio", text: "Digite um subdomínio" },
    { kind: "term", title: "GGR", text: "Perdas na casa" },
  ];

  it("ignores accents and case", () => {
    expect(searchHelp(idx, "dominio").map((r) => r.title)).toEqual(["Adicionar domínio"]);
    expect(searchHelp(idx, "ggr").map((r) => r.title)).toEqual(["GGR"]);
    expect(searchHelp(idx, "PERDAS").map((r) => r.title)).toEqual(["GGR"]);
  });

  it("returns nothing for a query shorter than 2 characters", () => {
    expect(searchHelp(idx, "g")).toEqual([]);
    expect(searchHelp(idx, "  ")).toEqual([]);
  });

  it("requires every word of the query", () => {
    expect(searchHelp(idx, "adicionar subdominio").map((r) => r.title)).toEqual([
      "Adicionar domínio",
    ]);
    expect(searchHelp(idx, "adicionar ggr")).toEqual([]);
  });

  it("ranks title matches before text-only matches", () => {
    const two: SearchEntry[] = [
      { kind: "item", title: "Enviar", text: "Usa o domínio da casa" },
      { kind: "item", title: "Domínio", text: "x" },
    ];
    expect(searchHelp(two, "dominio").map((r) => r.title)).toEqual(["Domínio", "Enviar"]);
  });
});

describe("normalizeSearchText", () => {
  it("lowercases and strips combining marks", () => {
    expect(normalizeSearchText("Ação É Já")).toBe("acao e ja");
  });
});

describe("buildSearchIndex", () => {
  const screen: HelpScreen = {
    id: "x",
    route: "/x",
    title: "Tela X",
    purpose: "p",
    roles: ["admin", "gestor"],
    sections: [
      {
        id: "s1",
        title: "Seção",
        items: [
          { label: "Para todos", what: "a" },
          { label: "Só admin", what: "b", roles: ["admin"] },
        ],
      },
    ],
    states: [],
    tours: {},
  };

  it("includes the screen items visible to the role and every glossary term", () => {
    const idx = buildSearchIndex(screen, "gestor", [{ id: "ggr", term: "GGR", short: "Perdas" }]);
    expect(idx.map((e) => `${e.kind}:${e.title}`)).toEqual(["item:Para todos", "term:GGR"]);
    expect(idx[0]).toMatchObject({ route: "/x", sectionId: "s1" });
    expect(idx[1]).toMatchObject({ termId: "ggr" });
  });

  it("works without a screen", () => {
    expect(buildSearchIndex(null, "admin", [])).toEqual([]);
  });
});
