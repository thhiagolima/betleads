import { describe, expect, it } from "vitest";
import {
  countRawDataTourUsages,
  extractTermIds,
  extractTourAnchorCalls,
  isTestFile,
} from "./coverage-scan";

describe("coverage-scan", () => {
  it("extractTourAnchorCalls acha um ou mais ids", () => {
    const src = 'const a = tourAnchor("casa.email.dns-table");\nconst b = tourAnchor("casa.email.remover");';
    expect(extractTourAnchorCalls(src)).toEqual(["casa.email.dns-table", "casa.email.remover"]);
  });

  it("extractTourAnchorCalls devolve lista vazia sem ocorrências", () => {
    expect(extractTourAnchorCalls("const x = 1;")).toEqual([]);
  });

  it("countRawDataTourUsages conta o atributo cru, não a chamada do helper", () => {
    expect(countRawDataTourUsages('<div data-tour="x" />')).toBe(1);
    expect(countRawDataTourUsages('tourAnchor("x")')).toBe(0);
  });

  it("extractTermIds acha ids de <Term id>", () => {
    const src = '<Term id="ggr">GGR</Term> e <Term id="net">Net</Term>';
    expect(extractTermIds(src)).toEqual(["ggr", "net"]);
  });

  it("isTestFile reconhece *.test.* e ignora o resto", () => {
    expect(isTestFile("resolve.test.ts")).toBe(true);
    expect(isTestFile("-coverage.test.ts")).toBe(true);
    expect(isTestFile("resolve.ts")).toBe(false);
  });
});
