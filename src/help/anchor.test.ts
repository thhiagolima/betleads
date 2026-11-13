import { describe, expect, it } from "vitest";
import { firstIndexWhere, tourAnchor } from "./anchor";

describe("anchor", () => {
  it("tourAnchor devolve o atributo data-tour", () => {
    expect(tourAnchor("a.b.c")).toEqual({ "data-tour": "a.b.c" });
  });

  it("firstIndexWhere acha a primeira linha que tem o controle", () => {
    const rows = [
      { acesso: "expert" },
      { acesso: "sem_acesso" },
      { acesso: "equipe" },
      { acesso: "sem_acesso" },
    ];
    expect(firstIndexWhere(rows, (r) => r.acesso === "sem_acesso")).toBe(1);
    expect(firstIndexWhere(rows, (r) => r.acesso === "equipe")).toBe(2);
    expect(firstIndexWhere(rows, (r) => r.acesso === "expert")).toBe(0);
  });

  it("firstIndexWhere devolve -1 sem nenhuma linha com o controle (nenhum índice casa)", () => {
    expect(firstIndexWhere([{ x: 1 }], (r) => r.x === 2)).toBe(-1);
    expect(firstIndexWhere([], () => true)).toBe(-1);
  });
});
