import { beforeAll, describe, expect, it } from "vitest";
import { resolveHelpScreen } from "./resolve";
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
