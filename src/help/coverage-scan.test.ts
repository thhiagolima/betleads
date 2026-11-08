import { describe, expect, it } from "vitest";
import {
  countRawDataTourUsages,
  extractTermIds,
  extractTourAnchorCalls,
  findAnchorWrappedPeriodPicker,
  findTermInsideChipLabel,
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
  it("findAnchorWrappedPeriodPicker acha a âncora numa div em volta do seletor de período", () => {
    const wrapped = `<div {...tourAnchor("rendimento.header.periodo")}>
              <CentralPeriodPicker value={period} onChange={setPeriod} />
            </div>`;
    expect(findAnchorWrappedPeriodPicker(wrapped)).toEqual(["rendimento.header.periodo"]);
    const direct = `<CentralPeriodPicker value={period} {...tourAnchor("equipe.periodo")} />`;
    expect(findAnchorWrappedPeriodPicker(direct)).toEqual([]);
  });

  it("findTermInsideChipLabel acha <Term> dentro do label={…} de um *Chip", () => {
    const src = `
      <RuleChip
        label={
          <>
            Gerou <Term id="pix-gerado-pago">PIX</Term> e não pagou
          </>
        }
        onClick={() => setActivity("pixUnpaid", true)}
      />
      <FilterChip label={<Term id="ftd">FTD</Term>} active />`;
    expect(findTermInsideChipLabel(src)).toEqual(["RuleChip", "FilterChip"]);
  });

  it("findTermInsideChipLabel ignora label de texto, Term fora do chip e outros componentes", () => {
    const src = `
      <RuleGroup title="Pendências" help={<><Term id="pix-gerado-pago">PIX</Term> em aberto</>}>
        <RuleChip label="Gerou PIX e não pagou" onClick={() => go({ a: 1 })} />
        <RuleChip label={count > 1 ? "Vários" : "Um"} count={count} />
      </RuleGroup>
      <Field label={<Term id="ggr">GGR</Term>} />`;
    expect(findTermInsideChipLabel(src)).toEqual([]);
  });
});
