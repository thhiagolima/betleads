import { beforeAll, describe, expect, it } from "vitest";
import { effectiveTab, helpTabLocation, resolveHelpScreen, tabSectionId } from "./resolve";
import {
  isAutoStartSuppressed,
  nextAutoStartSuppression,
  screenTourKey,
  startAutoStartSuppression,
  tourFor,
} from "./tour-logic";
import { tourKey } from "@/lib/help-progress";
import { HELP_SCREEN_LOADERS, HELP_TAB_SEARCH_PARAMS } from "./registry";
import type { HelpScreen } from "./types";

const fakeScreen: HelpScreen = {
  id: "fake",
  route: "fake",
  title: "Fake",
  purpose: "fake",
  roles: ["admin"],
  sections: [],
  states: [],
  tours: {},
};

beforeAll(() => {
  // Fictitious loaders (Task 2 brief): real articles for these routes ship
  // in later tasks, but resolveHelpScreen only needs a key in
  // HELP_SCREEN_LOADERS to match against.
  HELP_SCREEN_LOADERS["/jornadas/$journeyId"] = async () => ({ default: fakeScreen });
  HELP_SCREEN_LOADERS["/configuracoes/casa"] = async () => ({ default: fakeScreen });
});

describe("resolveHelpScreen", () => {
  it("resolve uma rota com parâmetro dinâmico", () => {
    expect(resolveHelpScreen("/jornadas/abc-123", "")).toEqual({
      route: "/jornadas/$journeyId",
      tab: null,
    });
  });

  it("resolve a aba a partir do hash", () => {
    expect(resolveHelpScreen("/configuracoes/casa", "#email")).toEqual({
      route: "/configuracoes/casa",
      tab: "email",
    });
  });

  it("devolve null para uma rota sem artigo registrado", () => {
    expect(resolveHelpScreen("/rota-inexistente", "")).toBeNull();
  });

  it("hash vazio devolve tab null", () => {
    expect(resolveHelpScreen("/configuracoes/casa", "")).toEqual({
      route: "/configuracoes/casa",
      tab: null,
    });
  });

  it("ignora barra final ao resolver", () => {
    expect(resolveHelpScreen("/configuracoes/casa/", "")).toEqual({
      route: "/configuracoes/casa",
      tab: null,
    });
  });
});

describe("effectiveTab / tabSectionId", () => {
  const step = { anchor: "x.a.b", title: "t", body: "b" };
  const tabbed: HelpScreen = {
    ...fakeScreen,
    route: "/configuracoes/casa",
    defaultTab: "casa",
    sections: [
      { id: "identidade", title: "Identidade", tab: "casa", items: [] },
      { id: "dominio-email", title: "Domínio", tab: "email", items: [] },
    ],
    tours: { casa: [step], email: [step] },
  };

  it("usa a aba da URL quando há hash, senão o defaultTab da tela", () => {
    expect(effectiveTab(tabbed, "email")).toBe("email");
    expect(effectiveTab(tabbed, null)).toBe("casa");
    expect(effectiveTab(fakeScreen, null)).toBeNull();
  });

  it("sem hash, a tela cai no tour e na chave de progresso da aba padrão (igual a #casa)", () => {
    const landing = tourFor(tabbed, effectiveTab(tabbed, null));
    const explicit = tourFor(tabbed, effectiveTab(tabbed, "casa"));
    expect(landing.steps).toHaveLength(1);
    expect(tourKey(tabbed.route, landing.tourTab)).toBe(tourKey(tabbed.route, explicit.tourTab));
    expect(tourKey(tabbed.route, landing.tourTab)).toBe("tour:/configuracoes/casa#casa");
  });

  it("tabSectionId acha a primeira seção da aba que está aparecendo", () => {
    expect(tabSectionId(tabbed, null)).toBe("identidade");
    expect(tabSectionId(tabbed, "email")).toBe("dominio-email");
    expect(tabSectionId(tabbed, "outra")).toBeNull();
    expect(tabSectionId(fakeScreen, null)).toBeNull();
  });
});

describe("abas na query string (tabSearchParam)", () => {
  it("lê a aba do parâmetro da tela e ignora o hash", () => {
    expect(resolveHelpScreen("/resultados", "", "?aba=origens")).toEqual({
      route: "/resultados",
      tab: "origens",
    });
    expect(resolveHelpScreen("/financeiro", "#painel", "tab=lancamentos&month=2026-10")).toEqual({
      route: "/financeiro",
      tab: "lancamentos",
    });
    expect(resolveHelpScreen("/rendimento/equipe/abc-123", "", "?aba=campanhas")).toEqual({
      route: "/rendimento/equipe/$expertId",
      tab: "campanhas",
    });
    // Hash only, on a query-param screen: no tab (the route ignores it).
    expect(resolveHelpScreen("/resultados", "#origens", "")).toEqual({
      route: "/resultados",
      tab: null,
    });
    // Another param name doesn't count (/financeiro uses "tab", not "aba").
    expect(resolveHelpScreen("/financeiro", "", "?aba=lancamentos")).toEqual({
      route: "/financeiro",
      tab: null,
    });
  });

  it("tela sem tabSearchParam continua lendo o hash e ignora a query", () => {
    expect(resolveHelpScreen("/configuracoes/casa", "#email", "?aba=templates")).toEqual({
      route: "/configuracoes/casa",
      tab: "email",
    });
  });

  it("helpTabLocation monta ?param=aba nas telas com tabSearchParam e #aba nas outras", () => {
    expect(helpTabLocation("/resultados", "origens").href).toBe("/resultados?aba=origens");
    expect(helpTabLocation("/financeiro", "outros-custos").href).toBe(
      "/financeiro?tab=outros-custos",
    );
    expect(helpTabLocation("/configuracoes/casa", "email").href).toBe("/configuracoes/casa#email");
    expect(helpTabLocation("/resultados", null)).toEqual({
      href: "/resultados",
      search: "",
      hash: "",
    });
  });

  it("helpTabLocation e resolveHelpScreen fazem ida e volta (busca/guias e supressão)", () => {
    const cases: Array<[string, string]> = [
      ["/resultados", "controle"],
      ["/financeiro", "configuracoes"],
      ["/configuracoes/casa", "email"],
    ];
    for (const [route, tab] of cases) {
      const loc = helpTabLocation(route, tab);
      const target = resolveHelpScreen(route, loc.hash, loc.search);
      expect(target).toEqual({ route, tab });
      // The guide's suppression targets the same place the URL resolves to
      // after navigating there, so the destination's auto-start stays off.
      const url = new URL(loc.href, "https://crm.test");
      const landed = resolveHelpScreen(url.pathname, url.hash, url.search);
      const suppression = nextAutoStartSuppression(
        startAutoStartSuppression(target!, null, 0),
        landed,
        1,
      );
      expect(isAutoStartSuppressed(suppression, landed)).toBe(true);
    }
  });

  it("a chave de progresso continua tour:<rota>#<aba>", async () => {
    const resultados = (await HELP_SCREEN_LOADERS["/resultados"]()).default;
    const origens = resolveHelpScreen("/resultados", "", "?aba=origens")!;
    const tab = effectiveTab(resultados, origens.tab);
    expect(screenTourKey(resultados, tourFor(resultados, tab).tourTab)).toBe(
      "tour:/resultados#origens",
    );
    // Landing URL (no ?aba) = the default tab, same key as ?aba=visao.
    const landing = effectiveTab(resultados, resolveHelpScreen("/resultados", "", "")!.tab);
    expect(screenTourKey(resultados, tourFor(resultados, landing).tourTab)).toBe(
      "tour:/resultados#visao",
    );

    const financeiro = (await HELP_SCREEN_LOADERS["/financeiro"]()).default;
    const lanc = effectiveTab(
      financeiro,
      resolveHelpScreen("/financeiro", "", "?tab=lancamentos")!.tab,
    );
    expect(screenTourKey(financeiro, tourFor(financeiro, lanc).tourTab)).toBe(
      "tour:/financeiro#lancamentos",
    );

    const pessoa = (await HELP_SCREEN_LOADERS["/rendimento/equipe/$expertId"]()).default;
    const camp = resolveHelpScreen("/rendimento/equipe/x", "", "?aba=campanhas")!.tab;
    const campTour = tourFor(pessoa, effectiveTab(pessoa, camp));
    expect(campTour.steps.length).toBeGreaterThan(0);
    expect(screenTourKey(pessoa, campTour.tourTab)).toBe(
      "tour:/rendimento/equipe/$expertId#campanhas",
    );
    // The Rendimento view keeps the key it always had (no tab).
    const rendTab = resolveHelpScreen("/rendimento/equipe/x", "", "")!.tab;
    const rend = tourFor(pessoa, effectiveTab(pessoa, rendTab));
    expect(screenTourKey(pessoa, rend.tourTab)).toBe("tour:/rendimento/equipe/$expertId");
  }, 20_000);

  it("HELP_TAB_SEARCH_PARAMS só lista rotas registradas", () => {
    for (const route of Object.keys(HELP_TAB_SEARCH_PARAMS)) {
      expect(HELP_SCREEN_LOADERS[route], route).toBeTruthy();
    }
  });
});
