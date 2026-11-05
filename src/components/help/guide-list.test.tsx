import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_SIGNALS, type Guide, type GuideSignals } from "@/help/guides";
import { GuideList } from "./guide-list";

const noop = () => {};

const adminGuide: Guide = {
  id: "g-admin",
  title: "Guia de admin",
  requiresRole: "admin",
  steps: [
    { id: "s1", title: "Passo 1", route: "/configuracoes/casa", substeps: [], signal: "shortenerAdded" },
  ],
};

const openGuide: Guide = {
  id: "g-open",
  title: "Guia aberto a todos",
  steps: [
    {
      id: "s1",
      title: "Passo 1",
      route: "/automacoes",
      substeps: ["sub a", "sub b"],
      signal: "journeySaved",
    },
    { id: "s2", title: "Passo 2", route: "/automacoes", substeps: [], signal: "journeyActive" },
  ],
};

function render(guides: Guide[], role: "admin" | "gestor" | "member" | "expert", signals: GuideSignals | null) {
  return renderToStaticMarkup(
    <GuideList guides={guides} role={role} signals={signals} onGoToStep={noop} />,
  );
}

describe("GuideList", () => {
  it('shows "só admin" for a guide requiring admin seen by a gestor', () => {
    const html = render([adminGuide], "gestor", EMPTY_SIGNALS);
    expect(html).toContain("só admin");
  });

  it("does not lock the guide for an admin", () => {
    const html = render([adminGuide], "admin", EMPTY_SIGNALS);
    expect(html).not.toContain("só admin");
  });

  it("shows progress counts when signals are available", () => {
    const html = render([openGuide], "gestor", { ...EMPTY_SIGNALS, journeySaved: true });
    expect(html).toContain("1 de 2 feitos");
  });

  it('shows "concluído ✓" when every step is done', () => {
    const html = render([openGuide], "gestor", { ...EMPTY_SIGNALS, journeyActive: true });
    expect(html).toContain("concluído ✓");
  });

  it("renders with no progress count when signals are null", () => {
    const html = render([openGuide], "gestor", null);
    expect(html).not.toContain("de 2 feitos");
    expect(html).not.toContain("concluído");
  });

  it("the guide title is always visible, collapsed by default", () => {
    const html = render([openGuide], "gestor", EMPTY_SIGNALS);
    expect(html).toContain("Guia aberto a todos");
    expect(html).not.toContain("Passo 1");
  });
});
