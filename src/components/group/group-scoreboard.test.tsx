import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupScoreboard, sortScoreboardRows, type ScoreboardRow } from "./group-scoreboard";

// No jsdom/testing-library in this repo (see src/components/demo-banner.test.tsx
// for the same renderToStaticMarkup pattern); clicking a header toggles state
// through `toggleSort`, which calls the exported `sortScoreboardRows` with
// direction "desc" on the first click, "asc" on the second — exercised
// directly here.
function summary(overrides: Partial<ScoreboardRow["current"]> = {}) {
  return {
    days: 1,
    pendingDays: 0,
    pendingToday: false,
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
    otherCosts: 0,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    betleadsUsage: 0,
    betleadsFee: null,
    ggrEstimated: false,
    ...overrides,
  };
}

// Deliberately NOT in cashResult-desc order already (fix round 1, item 3):
// a sort bug that leaves the input untouched would not have failed the old
// fixture, which happened to already be desc-sorted by cashResult.
const rows: ScoreboardRow[] = [
  {
    id: "c",
    nome: "Sorte da Bet",
    current: summary({ cashResult: -3500, ftds: 67 }),
    previous: summary(),
    goals: [{ metric: "ftds", direction: "gte", target: 80, value: 67, status: "yellow" }],
  },
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
];

describe("GroupScoreboard", () => {
  it("renders the goal status class on the goal's cell", () => {
    const html = renderToStaticMarkup(<GroupScoreboard rows={rows} />);

    expect(html).toContain("bg-emerald-500/15"); // Pixreals: FTDs green
    expect(html).toContain("bg-rose-500/15"); // Sorte Alta: FTDs red
    expect(html).toContain("bg-amber-500/15"); // Sorte da Bet: FTDs yellow
    expect(html).toContain("meta 100");
  });

  it("renders the variation under a cell's value", () => {
    const withPrevious: ScoreboardRow[] = [
      {
        id: "a",
        nome: "Sorte Alta",
        current: summary({ depositAmount: 1100 }),
        previous: summary({ depositAmount: 1000 }),
        goals: [],
      },
    ];

    const html = renderToStaticMarkup(<GroupScoreboard rows={withPrevious} />);

    expect(html).toContain("10,0%");
  });

  it("renders the ROI variation in percentage points", () => {
    const roiRows: ScoreboardRow[] = [
      {
        id: "a",
        nome: "Sorte Alta",
        current: summary({ roi: 0.3 }),
        previous: summary({ roi: 0.177 }),
        goals: [],
      },
    ];

    const html = renderToStaticMarkup(<GroupScoreboard rows={roiRows} />);

    expect(html).toContain("+12,3 p.p.");
    expect(html).not.toContain("69,5%");
  });

  it("an improvement from a negative previous is shown as a rise", () => {
    const negRows: ScoreboardRow[] = [
      {
        id: "a",
        nome: "Sorte Alta",
        current: summary({ cashResult: 500 }),
        previous: summary({ cashResult: -1000 }),
        goals: [],
      },
    ];

    const html = renderToStaticMarkup(<GroupScoreboard rows={negRows} />);

    expect(html).toContain("▲ 150,0%");
  });

  it("sorts descending on the first header click", () => {
    const sorted = sortScoreboardRows(rows, "cashResult", "desc");

    expect(sorted.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts ascending on the second header click", () => {
    const sorted = sortScoreboardRows(rows, "cashResult", "asc");

    expect(sorted.map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  it("always sorts rows with a null value last, in either direction", () => {
    const withNull: ScoreboardRow[] = [
      {
        id: "a",
        nome: "Sorte Alta",
        current: summary({ costPerFtd: 90 }),
        previous: summary(),
        goals: [],
      },
      {
        id: "b",
        nome: "Pixreals",
        current: summary({ costPerFtd: 60 }),
        previous: summary(),
        goals: [],
      },
      {
        id: "d",
        nome: "Casa Sem Custo",
        current: summary({ costPerFtd: null }),
        previous: summary(),
        goals: [],
      },
    ];

    expect(sortScoreboardRows(withNull, "costPerFtd", "desc").at(-1)?.id).toBe("d");
    expect(sortScoreboardRows(withNull, "costPerFtd", "asc").at(-1)?.id).toBe("d");
  });
});

describe("GroupScoreboard GGR column", () => {
  it("labels the GGR column as Perdas na casa", () => {
    const html = renderToStaticMarkup(
      <GroupScoreboard
        rows={[{ id: "a", nome: "Casa A", current: summary(), previous: summary(), goals: [] }]}
        defaultMoreColumns
      />,
    );
    expect(html).toContain("GGR (Perdas na casa)");
  });
});
