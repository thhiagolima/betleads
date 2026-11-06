import { describe, expect, it } from "vitest";
import { AUTO_TOURS_OFF_KEY, rowsToProgressMap, tourKey } from "@/lib/help-progress";

describe("help-progress", () => {
  it("tourKey com e sem aba", () => {
    expect(tourKey("/configuracoes/casa")).toBe("tour:/configuracoes/casa");
    expect(tourKey("/configuracoes/casa", "email")).toBe("tour:/configuracoes/casa#email");
  });

  it("tourKey com aba null/undefined se comporta como sem aba", () => {
    expect(tourKey("/configuracoes/casa", null)).toBe("tour:/configuracoes/casa");
    expect(tourKey("/configuracoes/casa", undefined)).toBe("tour:/configuracoes/casa");
  });

  it("rowsToProgressMap ignora status inválido", () => {
    expect(rowsToProgressMap([{ key: "a", status: "done" }, { key: "b", status: "x" }])).toEqual({ a: "done" });
  });

  it("rowsToProgressMap aceita todos os status válidos", () => {
    expect(
      rowsToProgressMap([
        { key: "a", status: "done" },
        { key: "b", status: "skipped" },
        { key: "c", status: "off" },
      ]),
    ).toEqual({ a: "done", b: "skipped", c: "off" });
  });

  it("rowsToProgressMap com lista vazia devolve objeto vazio", () => {
    expect(rowsToProgressMap([])).toEqual({});
  });

  it("AUTO_TOURS_OFF_KEY tem o valor combinado", () => {
    expect(AUTO_TOURS_OFF_KEY).toBe("prefs:auto-tours");
  });
});
