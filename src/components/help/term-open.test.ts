import { describe, expect, it } from "vitest";
import { clickLetsRadixToggle, nextTermOpen } from "./term-open";

describe("clickLetsRadixToggle", () => {
  it("teclado (Enter/Espaço, detail 0) deixa o Radix alternar; clique de ponteiro (detail >= 1) não", () => {
    expect(clickLetsRadixToggle(0)).toBe(true);
    expect(clickLetsRadixToggle(1)).toBe(false);
    expect(clickLetsRadixToggle(2)).toBe(false);
  });
});

describe("nextTermOpen", () => {
  it("mouse: hover-enter abre, e o clique seguinte mantém aberto (não fecha)", () => {
    let open = false;
    open = nextTermOpen(open, { type: "hover-enter" });
    expect(open).toBe(true);
    open = nextTermOpen(open, { type: "pointerdown", pointerType: "mouse" });
    expect(open).toBe(true);
  });

  it("mouse: clique sem hover prévio também abre", () => {
    expect(nextTermOpen(false, { type: "pointerdown", pointerType: "mouse" })).toBe(true);
  });

  it("touch: toque alterna (abre quando fechado, fecha quando aberto)", () => {
    expect(nextTermOpen(false, { type: "pointerdown", pointerType: "touch" })).toBe(true);
    expect(nextTermOpen(true, { type: "pointerdown", pointerType: "touch" })).toBe(false);
  });

  it("pen: se comporta como touch (alterna)", () => {
    expect(nextTermOpen(false, { type: "pointerdown", pointerType: "pen" })).toBe(true);
    expect(nextTermOpen(true, { type: "pointerdown", pointerType: "pen" })).toBe(false);
  });

  it("mouse: tirar o mouse (hover-leave) fecha", () => {
    expect(nextTermOpen(true, { type: "hover-leave" })).toBe(false);
  });
});
