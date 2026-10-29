import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { betleadsHint, categoryChoices, FIXED_COST_CATEGORIES } from "@/lib/finance/categories";

import {
  CategoryCommand,
  CostDateLabel,
  CostDateRepeatFields,
  CostValueLabel,
  DuplicateBetleadsNote,
  RepeatDeleteChoices,
  asksRepeatChoice,
  deleteToast,
  isSkippedCost,
  costDateBounds,
  defaultCostDate,
  isCostDateAllowed,
} from "./finance-other-costs";

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

  it("the date defaults to today inside the current month and to the last day of a past month", () => {
    expect(defaultCostDate("2026-10", "2026-10-24")).toBe("2026-10-24");
    expect(defaultCostDate("2026-09", "2026-10-24")).toBe("2026-09-30");
    expect(defaultCostDate("2026-02", "2026-10-24")).toBe("2026-02-28");
    // A future month has no allowed day.
    expect(defaultCostDate("2026-11", "2026-10-24")).toBeNull();
  });

  it("the date stays inside the viewed month and not after today", () => {
    expect(costDateBounds("2026-10", "2026-10-24")).toEqual({
      min: "2026-10-01",
      max: "2026-10-24",
    });
    expect(costDateBounds("2026-09", "2026-10-24")).toEqual({
      min: "2026-09-01",
      max: "2026-09-30",
    });
    expect(costDateBounds("2026-11", "2026-10-24")).toBeNull();
    expect(isCostDateAllowed("2026-10-24", "2026-10", "2026-10-24")).toBe(true);
    expect(isCostDateAllowed("2026-10-25", "2026-10", "2026-10-24")).toBe(false);
    expect(isCostDateAllowed("2026-09-30", "2026-10", "2026-10-24")).toBe(false);
    expect(isCostDateAllowed("", "2026-10", "2026-10-24")).toBe(false);
  });

  it('the form has a date field (min/max) and a "Repetir todo mês" toggle, off by default', () => {
    const html = renderToStaticMarkup(
      <CostDateRepeatFields
        month="2026-10"
        today="2026-10-24"
        costDate="2026-10-24"
        repeatMonthly={false}
        disabled={false}
        onCostDateChange={() => {}}
        onRepeatChange={() => {}}
      />,
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('min="2026-10-01"');
    expect(html).toContain('max="2026-10-24"');
    expect(html).toContain('value="2026-10-24"');
    expect(html).toContain("Repetir todo mês");
    expect(html).toContain('aria-checked="false"');

    const on = renderToStaticMarkup(
      <CostDateRepeatFields
        month="2026-10"
        today="2026-10-24"
        costDate="2026-10-05"
        repeatMonthly
        disabled={false}
        onCostDateChange={() => {}}
        onRepeatChange={() => {}}
      />,
    );
    expect(on).toContain('aria-checked="true"');
  });

  it("the Data column shows dd/mm and marks a repeating cost", () => {
    const once = renderToStaticMarkup(
      <CostDateLabel costDate="2026-10-05" repeatMonthly={false} />,
    );
    expect(once).toContain("05/10");
    expect(once).not.toContain("todo mês");

    const monthly = renderToStaticMarkup(<CostDateLabel costDate="2026-10-05" repeatMonthly />);
    expect(monthly).toContain("05/10");
    expect(monthly).toContain("todo mês");
  });

  it("deleting a repeating row asks: only this month, or end the repetition", () => {
    expect(asksRepeatChoice({ repeatMonthly: true })).toBe(true);
    expect(asksRepeatChoice({ repeatMonthly: false })).toBe(false);

    const html = renderToStaticMarkup(
      <RepeatDeleteChoices disabled={false} onSkipMonth={() => {}} onEndSeries={() => {}} />,
    );
    expect(html).toContain("Excluir só este mês (continua nos próximos)");
    expect(html).toContain("Encerrar a repetição");

    expect(deleteToast("end_series")).toBe("Repetição encerrada");
    expect(deleteToast("skip_month")).toBe("Mês pulado");
    expect(deleteToast("delete")).toBe("Custo removido");
  });

  it('a skipped month (repeating, valor 0) shows "pulado neste mês" instead of the value', () => {
    expect(isSkippedCost({ repeatMonthly: true, valor: 0 })).toBe(true);
    expect(isSkippedCost({ repeatMonthly: true, valor: 10 })).toBe(false);
    expect(isSkippedCost({ repeatMonthly: false, valor: 0 })).toBe(false);

    const skipped = renderToStaticMarkup(<CostValueLabel valor={0} skipped />);
    expect(skipped).toContain("pulado neste mês");
    const normal = renderToStaticMarkup(<CostValueLabel valor={1500} skipped={false} />);
    expect(normal).not.toContain("pulado");
    expect(normal).toContain("1.500,00");
  });
});
