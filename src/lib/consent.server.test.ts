import { describe, expect, it } from "vitest";

import { normalizeConsentSubject } from "./consent.server";

describe("normalizeConsentSubject", () => {
  it("normaliza e-mail sem alterar o endereco", () => {
    expect(normalizeConsentSubject("email", " Cliente@Exemplo.COM ")).toBe("cliente@exemplo.com");
  });

  it("normaliza telefone brasileiro local e internacional para o mesmo identificador", () => {
    expect(normalizeConsentSubject("sms", "(21) 98019-4445")).toBe("5521980194445");
    expect(normalizeConsentSubject("voice", "+55 21 98019-4445")).toBe("5521980194445");
  });
});
