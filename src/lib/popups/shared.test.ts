import { describe, expect, it } from "vitest";

import { EMPTY_POPUP_DRAFT, normalizePagePattern, validatePopupDraft, type PopupDraft } from "./shared";

const base: PopupDraft = { ...EMPTY_POPUP_DRAFT, nome: "Bônus", titulo: "Ganhe 100%" };

function error(draft: Partial<PopupDraft>) {
  const result = validatePopupDraft({ ...base, ...draft });
  return result.ok ? null : result.error;
}

describe("normalizePagePattern", () => {
  it.each([
    ["/", "/"],
    ["cassino", "/cassino"],
    ["/cassino/", "/cassino"],
    ["https://casa.bet/promocoes?x=1#a", "/promocoes"],
    ["/cassino/*", "/cassino/*"],
    ["/cassino*", "/cassino/*"],
    ["*", "/*"],
    ["//a//b", "/a/b"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizePagePattern(raw)).toBe(expected);
  });

  it("drops blanks and paths with spaces", () => {
    expect(normalizePagePattern("  ")).toBeNull();
    expect(normalizePagePattern("/a b")).toBeNull();
  });
});

describe("validatePopupDraft", () => {
  it("accepts a minimal popup and trims/empties fields", () => {
    const result = validatePopupDraft({ ...base, nome: "  Bônus ", texto: "  ", botaoLabel: "", botaoUrl: "" });
    expect(result).toMatchObject({ ok: true, draft: { nome: "Bônus", texto: null, botaoLabel: null, botaoUrl: null } });
  });

  it("needs a name and a title or image", () => {
    expect(error({ nome: " " })).toMatch(/nome/);
    expect(error({ titulo: null })).toMatch(/título ou uma imagem/);
    expect(error({ titulo: null, imageUrl: "https://cdn.casa.bet/a.png" })).toBeNull();
  });

  it("only accepts https links and images", () => {
    expect(error({ imageUrl: "http://x.com/a.png" })).toMatch(/https/);
    expect(error({ botaoLabel: "Ir", botaoUrl: "javascript:alert(1)" })).toMatch(/https/);
    expect(error({ botaoLabel: "Ir", botaoUrl: "https://casa.bet/deposito" })).toBeNull();
  });

  it("needs the button label and link together", () => {
    expect(error({ botaoLabel: "Ir" })).toMatch(/botão/);
    expect(error({ botaoUrl: "https://casa.bet" })).toMatch(/botão/);
  });

  it("needs criteria for the CRM audience and drops it for the others", () => {
    expect(error({ audienceKind: "filtro" })).toMatch(/público/);
    const kept = validatePopupDraft({ ...base, audienceKind: "logados", audienceCriteria: { a: 1 }, audienceLabel: "x" });
    expect(kept).toMatchObject({ ok: true, draft: { audienceCriteria: null, audienceLabel: null } });
  });

  it("normalizes and dedupes pages, and needs one for incluir/excluir", () => {
    expect(error({ paginasModo: "incluir", paginas: ["", " "] })).toMatch(/página/);
    const result = validatePopupDraft({ ...base, paginasModo: "excluir", paginas: ["/cassino/", "cassino", "/esportes*"] });
    expect(result).toMatchObject({ ok: true, draft: { paginas: ["/cassino", "/esportes/*"] } });
    const todas = validatePopupDraft({ ...base, paginasModo: "todas", paginas: ["/x"] });
    expect(todas).toMatchObject({ ok: true, draft: { paginas: [] } });
  });

  it("checks ranges and the period", () => {
    expect(error({ prioridade: 1001 })).toMatch(/prioridade/);
    expect(error({ atrasoSegundos: 121 })).toMatch(/segundos/);
    expect(error({ frequencia: "n_dias", frequenciaDias: null })).toMatch(/dias/);
    expect(error({ frequencia: "n_dias", frequenciaDias: 7 })).toBeNull();
    expect(error({ startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-19T00:00:00Z" })).toMatch(/fim/);
  });
});
