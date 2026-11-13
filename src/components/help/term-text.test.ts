import { describe, expect, it } from "vitest";
import { ROUTE_META } from "@/lib/navigation";
import { splitTermText } from "./term-text";

describe("splitTermText", () => {
  it("separa a parte do termo do resto do texto", () => {
    expect(splitTermText("Aquisição e LTV", "LTV")).toEqual({
      before: "Aquisição e ",
      match: "LTV",
      after: "",
    });
    expect(splitTermText("O LTV do mês", "LTV")).toEqual({
      before: "O ",
      match: "LTV",
      after: " do mês",
    });
  });

  it("devolve null quando a parte não está no texto", () => {
    expect(splitTermText("Aquisição", "LTV")).toBeNull();
    expect(splitTermText("Aquisição e LTV", "")).toBeNull();
  });

  it("o título de /midia-ltv em ROUTE_META contém LTV (o Term do cabeçalho aparece)", () => {
    expect(splitTermText(ROUTE_META["/midia-ltv"].title, "LTV")).not.toBeNull();
  });
});
