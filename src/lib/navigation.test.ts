import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROUTE_META,
  activeMobileTab,
  activeNavKey,
  isGroupPath,
  resolveRouteMeta,
  visibleSections,
} from "./navigation";

function declaredRoutes(): string[] {
  const source = readFileSync(resolve(__dirname, "../routeTree.gen.ts"), "utf8");
  const block = source.match(/interface FileRoutesByFullPath \{([\s\S]*?)\n\}/);
  if (!block) throw new Error("FileRoutesByFullPath not found in routeTree.gen.ts");
  return [...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1]);
}

describe("route titles", () => {
  const appRoutes = declaredRoutes().filter(
    (path) => !path.startsWith("/api/") && !path.startsWith("/u/"),
  );

  it("finds the app routes in the generated tree", () => {
    expect(appRoutes.length).toBeGreaterThan(30);
  });

  it.each(appRoutes)("%s has a title and a section", (path) => {
    expect(ROUTE_META[path], `add "${path}" to ROUTE_META`).toBeDefined();
  });

  it("resolves concrete URLs with params", () => {
    expect(resolveRouteMeta("/players/abc-123").title).toBe("Detalhe do jogador");
    expect(resolveRouteMeta("/jornadas/j1/relatorio").title).toBe("Relatório da jornada");
    expect(resolveRouteMeta("/jornadas/nova").title).toBe("Nova jornada");
    expect(resolveRouteMeta("/resultados/").title).toBe("Resultados do CRM");
  });

  it("falls back to the parent route for unknown children", () => {
    expect(resolveRouteMeta("/sms/algo-novo").title).toBe("SMS");
  });
});

describe("active nav item", () => {
  it("lights exactly one item for hash tabs", () => {
    expect(activeNavKey("/email", "")).toBe("/email");
    expect(activeNavKey("/email", "#templates")).toBe("/email#templates");
    expect(activeNavKey("/ligacoes", "#audios")).toBe("/ligacoes#audios");
  });

  it("prefers the most specific path", () => {
    expect(activeNavKey("/sms/templates", "")).toBe("/sms/templates");
    expect(activeNavKey("/sms", "")).toBe("/sms");
  });

  it("maps routes kept out of the menu to their parent item", () => {
    expect(activeNavKey("/jornadas/123", "")).toBe("/automacoes");
    expect(activeNavKey("/creditos-sms", "")).toBe("/sms");
    expect(activeNavKey("/relatorios/conversao", "")).toBe("/resultados");
  });

  it("does not light Início on other pages", () => {
    expect(activeNavKey("/players", "")).toBe("/players");
    expect(activeNavKey("/", "")).toBe("/");
  });

  it("maps mobile tabs", () => {
    expect(activeMobileTab("/")).toBe("Início");
    expect(activeMobileTab("/players/1")).toBe("Jogadores");
    expect(activeMobileTab("/jornadas")).toBe("Campanhas");
    expect(activeMobileTab("/sms")).toBeNull();
  });
});

describe("visible sections", () => {
  const labels = (role: Parameters<typeof visibleSections>[0], superAdmin: boolean) =>
    visibleSections(role, superAdmin).map((section) => section.label ?? "");

  it("hides IA from gestor and member", () => {
    expect(labels("gestor", false)).not.toContain("IA");
    expect(labels("member", false)).not.toContain("IA");
  });

  it("shows IA to the house admin and the super admin", () => {
    expect(labels("admin", false)).toContain("IA");
    expect(labels("super_admin", true)).toContain("IA");
  });

  it("shows Administração only to the super admin", () => {
    expect(labels("admin", false)).not.toContain("Administração");
    expect(labels("super_admin", true)).toContain("Administração");
  });

  it("hides IA while the role is unknown", () => {
    expect(labels(null, false)).not.toContain("IA");
  });

  it("finance link visible only with can_view_finance or super admin", () => {
    const financeLinks = (
      role: Parameters<typeof visibleSections>[0],
      superAdmin: boolean,
      canViewFinance?: boolean,
    ) =>
      visibleSections(role, superAdmin, canViewFinance)
        .flatMap((section) => section.items)
        .filter((item) => item.kind === "link")
        .map((item) => item.to);

    expect(financeLinks("admin", false)).not.toContain("/financeiro");
    expect(financeLinks("admin", false, false)).not.toContain("/financeiro");
    expect(financeLinks("admin", false, true)).toContain("/financeiro");
    expect(financeLinks("gestor", false, true)).toContain("/financeiro");
    expect(financeLinks("member", false, true)).toContain("/financeiro");
    expect(financeLinks(null, false, true)).toContain("/financeiro");
    expect(financeLinks("super_admin", true, false)).toContain("/financeiro");
  });
});

describe("isGroupPath", () => {
  it("matches /grupo and every /grupo/... path", () => {
    expect(isGroupPath("/grupo")).toBe(true);
    expect(isGroupPath("/grupo/metas")).toBe(true);
    expect(isGroupPath("/grupo/casa")).toBe(true);
    expect(isGroupPath("/grupo/pessoas")).toBe(true);
  });

  it("does not match a path that merely starts with the same letters", () => {
    expect(isGroupPath("/grupos")).toBe(false);
    expect(isGroupPath("/grupo-x")).toBe(false);
    expect(isGroupPath("/")).toBe(false);
  });
});
