import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { betleadsHint, categoryChoices, FIXED_COST_CATEGORIES } from "@/lib/finance/categories";

import { CategoryCommand, DuplicateBetleadsNote } from "./finance-other-costs";

// No jsdom: the combobox list, the duplicate note and the typing hint are
// presentational pieces / pure helpers exercised directly here.
const categories = [...FIXED_COST_CATEGORIES, "Agência", "Servidor"];

describe("FinanceOtherCosts", () => {
  it("category select lists fixed then house categories and accepts a new name", () => {
    expect(categoryChoices(categories, "")).toEqual({ options: categories, newName: null });

    const html = renderToStaticMarkup(
      <CategoryCommand
        categories={categories}
        search=""
        onSearchChange={() => {}}
        onSelect={() => {}}
      />,
    );
    const positions = categories.map((label) => html.indexOf(`>${label}<`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(categoryChoices(categories, "  Mídia  paga ")).toEqual({
      options: [],
      newName: "Mídia paga",
    });
    const typed = renderToStaticMarkup(
      <CategoryCommand
        categories={categories}
        search="Mídia paga"
        onSearchChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(typed).toContain("Criar categoria “Mídia paga”");

    // An existing name (any case) is offered as itself, not as a new one.
    expect(categoryChoices(categories, "equipe")).toEqual({ options: ["Equipe"], newName: null });
  });

  it("the category search is capped at 60 characters", () => {
    const html = renderToStaticMarkup(
      <CategoryCommand
        categories={categories}
        search=""
        onSearchChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('maxLength="60"');
  });

  it('a suspected Betleads cost shows "parece duplicado com o custo Betleads automático" and a remove button', () => {
    const html = renderToStaticMarkup(
      <DuplicateBetleadsNote canRemove disabled={false} onRemove={() => {}} />,
    );
    expect(html).toContain("parece duplicado com o custo Betleads automático");
    expect(html).toContain("Remover");

    const readOnly = renderToStaticMarkup(
      <DuplicateBetleadsNote canRemove={false} disabled={false} onRemove={() => {}} />,
    );
    expect(readOnly).toContain("parece duplicado com o custo Betleads automático");
    expect(readOnly).not.toContain("Remover");
  });

  it('typing "SMS" in the description shows "o custo Betleads já entra sozinho"', () => {
    expect(betleadsHint("SMS", "Outros")).toBe("o custo Betleads já entra sozinho");
    expect(betleadsHint("Envio de sms outubro", "Ferramentas")).toBe(
      "o custo Betleads já entra sozinho",
    );
    expect(betleadsHint("Designer", "Equipe")).toBeNull();
    expect(betleadsHint("", "Outros")).toBeNull();
  });
});
