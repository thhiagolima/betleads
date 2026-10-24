import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupScoreboard, sortScoreboardRows, type ScoreboardRow } from "./group-scoreboard";

// No jsdom/testing-library in this repo (see src/components/demo-banner.test.tsx
// for the same renderToStaticMarkup pattern); clicking a header toggles state
// through `toggleSort`, which calls the exported `sortScoreboardRows` with
// direction "desc" on the first click — exercised directly here.
function summary(overrides: Partial<ScoreboardRow["current"]> = {}) {
  return {
    days: 1,
    pendingDays: 0,
    registrations: 0,
    ftds: 0,
    ftdDepositAmount: 0,
    depositAmount: 0,
    withdrawalAmount: 0,
    adSpend: 0,
    ggr: 0,
    net: 0,
    ggrFee: 0,
    movementFee: 0,
    otherCosts: null,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    ...overrides,
  };
}

const rows: ScoreboardRow[] = [
  {
    id: "a",
    nome: "Sorte Alta",
    current: summary({ cashResult: 9900, ftds: 41 }),
    previous: summary(),
    goals: [{ metric: "ftds", direction: "gte", target: 100, value: 41, status: "red" }],
  },
  {
    id: "b",
    nome: "Pixreals",
    current: summary({ cashResult: 4800, ftds: 104 }),
    previous: summary(),
    goals: [{ metric: "ftds", direction: "gte", target: 100, value: 104, status: "green" }],
  },
  {
    id: "c",
    nome: "Sorte da Bet",
    current: summary({ cashResult: -3500, ftds: 67 }),
    previous: summary(),
    goals: [{ metric: "ftds", direction: "gte", target: 80, value: 67, status: "yellow" }],
  },
];

describe("GroupScoreboard", () => {
  it("renders the goal status class on the goal's cell", () => {
    const html = renderToStaticMarkup(<GroupScoreboard rows={rows} />);

    expect(html).toContain("bg-emerald-500/15"); // Pixreals: FTDs green
    expect(html).toContain("bg-rose-500/15"); // Sorte Alta: FTDs red
    expect(html).toContain("bg-amber-500/15"); // Sorte da Bet: FTDs yellow
    expect(html).toContain("meta 100");
  });

  it("sorts by result desc on header click (sortScoreboardRows, direction desc on first click)", () => {
    const sorted = sortScoreboardRows(rows, "cashResult", "desc");

    expect(sorted.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});
