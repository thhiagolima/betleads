import { describe, expect, it } from "vitest";

import { toggleViewer, viewerSearchText } from "./sms-balance-panel";

describe("seletor de quem vê o aviso de saldo", () => {
  it("marca no fim e desmarca sem mexer na ordem", () => {
    expect(toggleViewer(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleViewer(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("a busca acha pelo nome, e-mail ou casa", () => {
    const text = viewerSearchText({
      userId: "u1",
      nome: "Ana Souza",
      email: "ana@casa.com",
      casas: ["PixReals", "Sorte Alta"],
    });
    expect(text).toContain("Ana Souza");
    expect(text).toContain("ana@casa.com");
    expect(text).toContain("Sorte Alta");
  });
});
