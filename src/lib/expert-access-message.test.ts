import { describe, expect, it } from "vitest";

import {
  GENERIC_ACCESS_MESSAGE,
  HOUSE_UNAVAILABLE_MESSAGE,
  expertAccessErrorMessage,
} from "./expert-access-message";

describe("expertAccessErrorMessage", () => {
  it("passes the house-unavailable message through unchanged", () => {
    expect(expertAccessErrorMessage(new Error(HOUSE_UNAVAILABLE_MESSAGE))).toBe(
      HOUSE_UNAVAILABLE_MESSAGE,
    );
  });

  it("collapses the not-found/disabled message to the generic one", () => {
    expect(
      expertAccessErrorMessage(new Error("Acesso de expert não encontrado ou desativado.")),
    ).toBe(GENERIC_ACCESS_MESSAGE);
  });

  it("collapses an arbitrary Error to the generic one", () => {
    expect(expertAccessErrorMessage(new Error("algo inesperado"))).toBe(GENERIC_ACCESS_MESSAGE);
  });

  it("collapses a non-Error value to the generic one", () => {
    expect(expertAccessErrorMessage("boom")).toBe(GENERIC_ACCESS_MESSAGE);
    expect(expertAccessErrorMessage(null)).toBe(GENERIC_ACCESS_MESSAGE);
  });
});
