import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupPeriodBar } from "./group-period-bar";
import { defaultGroupPeriod, periodFromRange, periodFromShortcut } from "./period-options";

const TODAY = "2026-10-29";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-10-29 15:00 in São Paulo (UTC-3), a Thursday.
  vi.setSystemTime(new Date("2026-10-29T18:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const render = (period = defaultGroupPeriod()) =>
  renderToStaticMarkup(<GroupPeriodBar value={period} onChange={() => {}} />);

describe("GroupPeriodBar", () => {
  it("defaults to Este mês compared with the previous month to the same day", () => {
    expect(defaultGroupPeriod()).toEqual({
      shortcut: "this_month",
      preset: "month",
      range: { from: "2026-10-01", to: TODAY },
      compare: "previous",
    });
  });

  it("shows both fields with the option and its exact dates", () => {
    const html = render();
    expect(html).toContain("Período");
    expect(html).toContain("Comparar com");
    expect(html).toContain(">vs<");
    expect(html).toContain("Este mês");
    expect(html).toContain(" · 01/10 a 29/10");
    expect(html).toContain("Mês anterior");
    expect(html).toContain(" · 01/09 a 29/09");
    // Both fields are popover triggers (toggle, aria-expanded, focus return).
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    // No native month input any more.
    expect(html).not.toContain('type="month"');
  });

  it("highlights the active quick chip only", () => {
    const html = render();
    for (const label of ["Hoje", "Ontem", "7 dias", "30 dias", "Este mês", "Mês passado"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Este mês</);

    const custom = render(
      periodFromRange({ from: "2026-10-05", to: "2026-10-12" }, "previous", TODAY),
    );
    expect(custom).not.toContain('aria-pressed="true"');
    expect(custom).toContain("Personalizado");
    expect(custom).toContain("Período anterior");
  });

  it("one day shows its date, and Sem comparação shows no dates", () => {
    const html = render(periodFromShortcut("today", "none", TODAY));
    expect(html).toContain(" · 29/10");
    expect(html).toContain("Sem comparação");
    expect(html).not.toContain("28/10");
  });
});
