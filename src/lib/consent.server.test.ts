import { describe, expect, it } from "vitest";

import { normalizeConsentSubject, resolveVoiceFrequencyPolicy } from "./consent.server";

describe("normalizeConsentSubject", () => {
  it("normaliza e-mail sem alterar o endereco", () => {
    expect(normalizeConsentSubject("email", " Cliente@Exemplo.COM ")).toBe("cliente@exemplo.com");
  });

  it("normaliza telefone brasileiro local e internacional para o mesmo identificador", () => {
    expect(normalizeConsentSubject("sms", "(21) 98019-4445")).toBe("5521980194445");
    expect(normalizeConsentSubject("voice", "+55 21 98019-4445")).toBe("5521980194445");
  });

  it("aplica limite de voz seguro quando a tenant ainda não possui política", () => {
    expect(resolveVoiceFrequencyPolicy(null)).toEqual({
      enabled: true,
      cooldown_hours: 24,
      rolling_24h_limit: 1,
    });
  });
});
