import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROUTE_META,
  activeMobileTab,
  activeNavKey,
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
    expect(activeNavKey("/relatorios/conversao", "")).toBe("/resultados");
  });

  it("lights the settings items that used to be pinned", () => {
    expect(activeNavKey("/consentimentos", "")).toBe("/consentimentos");
    expect(activeNavKey("/webhooks", "")).toBe("/webhooks");
    expect(activeNavKey("/plano-e-creditos", "")).toBe("/plano-e-creditos");
    expect(activeNavKey("/configuracoes", "")).toBe("/configuracoes");
  });

  it('shows "Plano e créditos" (not "Saldo e consumo") under Configurações, linking to /plano-e-creditos', () => {
    const settings = visibleSections("admin", false).find(
      (section) => section.label === "Configurações",
    );
    expect(settings).toBeDefined();
    const item = settings!.items.find(
      (entry) => entry.kind === "link" && entry.title === "Plano e créditos",
    );
    expect(item).toMatchObject({ to: "/plano-e-creditos" });
    expect(settings!.items.some((entry) => entry.kind === "link" && entry.title === "Saldo e consumo")).toBe(
      false,
    );
  });

  it("does not light Início on other pages", () => {
    expect(activeNavKey("/players", "")).toBe("/players");
    expect(activeNavKey("/", "")).toBe("/");
  });

  it("maps mobile tabs", () => {
    expect(activeMobileTab("/")).toBe("Início");
    expect(activeMobileTab("/players/1")).toBe("Jogadores");
    expect(activeMobileTab("/jornadas")).toBe("Ações");
    expect(activeMobileTab("/campanhas")).toBe("Ações");
    expect(activeMobileTab("/gamificacao")).toBe("Jogadores");
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

  it("ends with Configurações for everyone but the super admin, who also gets Administração", () => {
    expect(labels("gestor", false).at(-1)).toBe("Configurações");
    expect(labels("admin", false).at(-1)).toBe("Configurações");
    expect(labels("super_admin", true).slice(-2)).toEqual(["Configurações", "Administração"]);
  });

  it("keeps Consentimentos with the channels", () => {
    const canais = visibleSections("gestor", false).find((section) => section.label === "Canais");
    const titles = canais?.items.map((item) => item.title) ?? [];
    expect(titles.indexOf("Consentimentos")).toBe(titles.indexOf("Voz") + 1);
  });

  it("keeps parked pages out of the menu", () => {
    const titles = visibleSections("super_admin", true)
      .flatMap((section) =>
        section.items.flatMap((item) => (item.kind === "group" ? item.children : [item])),
      )
      .map((item) => item.title);
    expect(titles).not.toContain("Oportunidades");
    expect(titles).not.toContain("Experts");
  });

  it("hides IA while the role is unknown", () => {
    expect(labels(null, false)).not.toContain("IA");
  });
});
