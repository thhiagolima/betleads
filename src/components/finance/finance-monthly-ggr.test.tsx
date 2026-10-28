import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  defaultValidThrough,
  MONTHLY_GGR_COLUMN_NOTE,
  monthlyGgrFormError,
  MonthlyGgrFields,
  monthlyGgrStatus,
} from "./finance-monthly-ggr";

// No jsdom: the form is a presentational piece plus pure helpers (default
// date, validation, status line) exercised directly here.
describe("GGR do mês", () => {
  it("defaults 'atualizado até' to yesterday, clamped into the month", () => {
    expect(defaultValidThrough("2026-10", "2026-10-24")).toBe("2026-10-23");
    // The 1st of the current month: yesterday is last month, clamp to the 1st.
    expect(defaultValidThrough("2026-10", "2026-10-01")).toBe("2026-10-01");
    // A past month: its last day.
    expect(defaultValidThrough("2026-09", "2026-10-24")).toBe("2026-09-30");
    expect(defaultValidThrough("2026-02", "2026-10-24")).toBe("2026-02-28");
  });

  it("validates the value and the date", () => {
    const today = "2026-10-24";
    const ok = { month: "2026-10", ggr: "1497.15", validThrough: "2026-10-23" };
    expect(monthlyGgrFormError(ok, today)).toBeNull();
    expect(monthlyGgrFormError({ ...ok, ggr: "-12,5" }, today)).toBeNull();
    // Empty clears the total: no date needed.
    expect(monthlyGgrFormError({ ...ok, ggr: " ", validThrough: "" }, today)).toBeNull();
    expect(monthlyGgrFormError({ ...ok, ggr: "abc" }, today)).toBe("Valor inválido");
    expect(monthlyGgrFormError({ ...ok, validThrough: "" }, today)).toBe(
      "Informe a data de atualização",
    );
    expect(monthlyGgrFormError({ ...ok, validThrough: "2026-09-30" }, today)).toBe(
      "A data deve estar dentro do mês",
    );
    expect(monthlyGgrFormError({ ...ok, validThrough: "2026-10-25" }, today)).toBe(
      "Data futura não permitida",
    );
  });

  it("status line and column note", () => {
    expect(MONTHLY_GGR_COLUMN_NOTE).toBe("usando o total do mês");
    expect(monthlyGgrStatus(null)).toBe("Sem total do mês: o GGR vem dos dias.");
    expect(monthlyGgrStatus({ ggr: 1497.15, validThrough: "2026-10-20" })).toBe(
      "Total do mês R$ 1.497,15, atualizado até 20/10.",
    );
  });

  it("renders the field, the date and the save button", () => {
    const html = renderToStaticMarkup(
      <MonthlyGgrFields
        value={{ ggr: "1497.15", validThrough: "2026-10-23" }}
        month="2026-10"
        today="2026-10-24"
        current={null}
        canEdit
        disabled={false}
        saving={false}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("GGR do mês (Perdas na casa acumulado)");
    expect(html).toContain("atualizado até");
    expect(html).toContain('value="2026-10-23"');
    expect(html).toContain('min="2026-10-01"');
    expect(html).toContain('max="2026-10-24"');
    expect(html).toContain("Salvar GGR do mês");

    const readOnly = renderToStaticMarkup(
      <MonthlyGgrFields
        value={{ ggr: "", validThrough: "" }}
        month="2026-10"
        today="2026-10-24"
        current={{ ggr: 10, validThrough: "2026-10-05" }}
        canEdit={false}
        disabled={false}
        saving={false}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    expect(readOnly).toContain("Total do mês R$ 10,00, atualizado até 05/10.");
    expect(readOnly).not.toContain("Salvar GGR do mês");
  });
});
