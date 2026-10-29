import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  sortTenantProfitRows,
  TenantProfitTable,
  type TenantProfitRow,
} from "./tenant-profit-table";
import { summary } from "./test-fixtures";

// No jsdom: a header click calls sortTenantProfitRows (desc first, asc on the
// second click), exercised directly here.
const rows: TenantProfitRow[] = [
  {
    id: "a",
    nome: "Bravabet",
    current: summary({ cashResult: 88300, adSpend: 63000, roi: 1.4 }),
    previous: summary({ cashResult: 96000 }),
    margin: 0.25,
    sendCost: 1500,
  },
  {
    id: "b",
    nome: "Casa X",
    current: summary({ cashResult: -7000, adSpend: 14600, roi: null }),
    previous: summary({ cashResult: 0 }),
    margin: null,
    sendCost: 0,
  },
  {
    id: "c",
    nome: "Forrandobet",
    current: summary({ cashResult: 121000, adSpend: 52600, roi: 2.3 }),
    previous: summary({ cashResult: 93077 }),
    margin: 0.4,
    sendCost: 2400.5,
  },
];

describe("TenantProfitTable", () => {
  it("renders Casa, Lucro líquido, Margem, ROI, Anúncios, Envios and Δ lucro, n.a. for nulls", () => {
    const html = renderToStaticMarkup(<TenantProfitTable rows={rows} />);

    const headers = ["Casa", "Lucro líquido", "Margem", "ROI", "Anúncios", "Envios", "Δ lucro"];
    const positions = headers.map((header) => html.indexOf(`>${header}</button>`));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain("25,0%"); // Bravabet margin
    expect(html).toContain("R$ 2.400,50"); // Forrandobet envios
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("-R$ 7.000,00");
    expect(html).toContain("▼ 8,0%"); // Bravabet 88300 vs 96000
    expect(html).toContain("n.a."); // Casa X: ROI null and Δ over a zero previous
  });

  it("sorts by profit, nulls last, desc then asc", () => {
    expect(sortTenantProfitRows(rows, "cashResult", "desc").map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(sortTenantProfitRows(rows, "cashResult", "asc").map((row) => row.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(sortTenantProfitRows(rows, "roi", "asc").at(-1)?.id).toBe("b");
    expect(sortTenantProfitRows(rows, "profitChange", "desc").map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sorts by margin (nulls last) and by envios", () => {
    expect(sortTenantProfitRows(rows, "margin", "desc").map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(sortTenantProfitRows(rows, "sendCost", "asc").map((row) => row.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by house name", () => {
    expect(sortTenantProfitRows(rows, "nome", "desc").map((row) => row.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});
