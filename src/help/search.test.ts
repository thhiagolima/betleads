import { describe, expect, it } from "vitest";
import {
  buildSearchIndex,
  canOpenRoute,
  normalizeSearchText,
  searchHelp,
  STATES_SECTION_ID,
  type SearchEntry,
} from "./search";
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

  it("ranks the current screen's entries first, even text-only ones", () => {
    const mixed: SearchEntry[] = [
      { kind: "item", title: "Domínio", text: "x", route: "/b" },
      { kind: "item", title: "Enviar", text: "Usa o domínio", route: "/a" },
      { kind: "item", title: "Domínio da casa", text: "y", route: "/a" },
    ];
    expect(searchHelp(mixed, "dominio", "/a").map((r) => r.title)).toEqual([
      "Domínio da casa",
      "Enviar",
      "Domínio",
    ]);
  });
});

describe("canOpenRoute", () => {
  it("accepts plain paths, rejects param routes and virtual screens", () => {
    expect(canOpenRoute("/configuracoes/casa")).toBe(true);
    expect(canOpenRoute("/jornadas/$journeyId")).toBe(false);
    expect(canOpenRoute("onboarding")).toBe(false);
  });
});

describe("normalizeSearchText", () => {
  it("lowercases and strips combining marks", () => {
    expect(normalizeSearchText("Ação É Já")).toBe("acao e ja");
  });
});

function makeScreen(overrides: Partial<HelpScreen> = {}): HelpScreen {
  return {
    id: "x",
    route: "/x",
    title: "Tela X",
    purpose: "Para que serve a tela X.",
    roles: ["admin", "gestor"],
    sections: [
      {
        id: "s1",
        title: "Seção um",
        intro: "Introdução da seção.",
        items: [
          { label: "Para todos", what: "a" },
          { label: "Só admin", what: "b", roles: ["admin"] },
        ],
      },
    ],
    states: [],
    tours: {},
    ...overrides,
  };
}

describe("buildSearchIndex", () => {
  const screen = makeScreen();

  it("indexes title/purpose, section titles, visible items and every glossary term", () => {
    const idx = buildSearchIndex([screen], "gestor", [{ id: "ggr", term: "GGR", short: "Perdas" }]);
    expect(idx.map((e) => `${e.kind}:${e.title}`)).toEqual([
      "item:Tela X",
      "item:Seção um",
      "item:Para todos",
      "term:GGR",
    ]);
    expect(idx[2]).toMatchObject({ route: "/x", sectionId: "s1", screenTitle: "Tela X" });
    expect(idx[3]).toMatchObject({ termId: "ggr" });
  });

  it("finds the screen by its purpose", () => {
    const idx = buildSearchIndex([screen], "gestor", []);
    expect(searchHelp(idx, "para que serve")[0]).toMatchObject({ title: "Tela X", route: "/x" });
  });

  it("finds a section by its title or intro", () => {
    const idx = buildSearchIndex([screen], "gestor", []);
    expect(searchHelp(idx, "secao um").map((e) => e.title)).toEqual(["Seção um"]);
    expect(searchHelp(idx, "introducao")[0]).toMatchObject({ title: "Seção um", sectionId: "s1" });
  });

  it("finds a state, pointing at the states section", () => {
    const withState = makeScreen({
      states: [
        {
          id: "v",
          title: "Nenhum domínio",
          what: "Ainda não conectado.",
          action: "Clique em Adicionar.",
        },
      ],
    });
    const idx = buildSearchIndex([withState], "gestor", []);
    expect(searchHelp(idx, "nenhum dominio")[0]).toMatchObject({
      title: "Nenhum domínio",
      sectionId: STATES_SECTION_ID,
      route: "/x",
    });
    expect(searchHelp(idx, "clique adicionar")[0]).toMatchObject({ title: "Nenhum domínio" });
    expect(STATES_SECTION_ID).toBe("situacoes");
  });

  it("carries the section's tab for navigation", () => {
    const tabbed = makeScreen({
      sections: [
        {
          id: "e",
          title: "E-mail",
          tab: "email",
          items: [{ label: "Adicionar domínio", what: "x" }],
        },
      ],
    });
    const hit = searchHelp(buildSearchIndex([tabbed], "gestor", []), "adicionar dominio")[0];
    expect(hit).toMatchObject({ sectionId: "e", tab: "email" });
  });

  it("skips screens the role doesn't see and duplicate routes", () => {
    const adminOnly = makeScreen({ route: "/a", title: "Admin", roles: ["admin"] });
    const idx = buildSearchIndex([screen, screen, adminOnly], "gestor", []);
    expect(idx.filter((e) => e.title === "Tela X")).toHaveLength(1);
    expect(idx.some((e) => e.route === "/a")).toBe(false);
  });

  it("works with no screens", () => {
    expect(buildSearchIndex([], "admin", [])).toEqual([]);
  });

  it("a gestor on /campanhas finds the Configuração da casa items, current screen first", () => {
    const casa = makeScreen({
      route: "/configuracoes/casa",
      title: "Configuração da casa",
      sections: [
        {
          id: "dominio",
          title: "Domínio",
          tab: "email",
          items: [{ label: "Adicionar domínio", what: "Conecta o domínio." }],
        },
      ],
    });
    const campanhas = makeScreen({
      route: "/campanhas",
      title: "Campanhas",
      sections: [
        {
          id: "link",
          title: "Link",
          items: [{ label: "Link curto", what: "Usa o domínio da casa." }],
        },
      ],
    });
    const idx = buildSearchIndex([casa, campanhas], "gestor", []);
    const hits = searchHelp(idx, "dominio", "/campanhas");
    expect(hits[0]).toMatchObject({ route: "/campanhas", title: "Link curto" });
    expect(hits.slice(1).map((e) => e.title)).toEqual(["Domínio", "Adicionar domínio"]);
    expect(hits[2]).toMatchObject({
      route: "/configuracoes/casa",
      sectionId: "dominio",
      tab: "email",
    });
  });
});
