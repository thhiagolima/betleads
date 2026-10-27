import { describe, expect, it } from "vitest";

import { buildWhatsAppLink } from "./player-rules";

type Player = Parameters<typeof buildWhatsAppLink>[0];
type Alert = Parameters<typeof buildWhatsAppLink>[1];
const alert = { tipo: "inativo" } as unknown as Alert;
const player = (telefone: string | null) => ({ nome: "Ana", telefone }) as unknown as Player;

describe("buildWhatsAppLink", () => {
  it("adds the Brazilian country code when the phone has only DDD + number", () => {
    expect(buildWhatsAppLink(player("(11) 99999-8888"), alert)).toMatch(
      /^https:\/\/wa\.me\/5511999998888\?text=/,
    );
  });

  it("keeps a phone that already has 55", () => {
    expect(buildWhatsAppLink(player("+55 11 99999-8888"), alert)).toMatch(
      /^https:\/\/wa\.me\/5511999998888\?/,
    );
  });

  it("returns null for an invalid or missing phone", () => {
    expect(buildWhatsAppLink(player("12345"), alert)).toBeNull();
    expect(buildWhatsAppLink(player(null), alert)).toBeNull();
  });
});
