import { describe, expect, it } from "vitest";

import { unknownMessageVariables } from "./message-variables";

describe("message variable policy", () => {
  it("accepts catalogued variables and de-duplicates invalid ones", () => {
    expect(
      unknownMessageVariables(
        "Olá {primeiro_nome}, use {link}. {variavel_invalida} {variavel_invalida}",
        "sms",
      ),
    ).toEqual(["variavel_invalida"]);
  });

  it("enforces variables restricted by channel", () => {
    expect(unknownMessageVariables("{duracao_chamada}", "voice")).toEqual([
      "duracao_chamada",
    ]);
    expect(unknownMessageVariables("{duracao_chamada}", "sms")).toEqual([]);
  });
});
