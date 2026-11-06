import { beforeAll, describe, expect, it } from "vitest";
import { effectiveTab, resolveHelpScreen, tabSectionId } from "./resolve";
import { tourFor } from "./tour-logic";
import { tourKey } from "@/lib/help-progress";
import { HELP_SCREEN_LOADERS } from "./registry";
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
