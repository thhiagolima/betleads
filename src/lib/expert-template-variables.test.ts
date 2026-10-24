import { describe, expect, it } from "vitest";

import {
  EXPERT_SUPPORTED_VARIABLE_KEYS,
  EXPERT_UNSUPPORTED_VARIABLE_KEYS,
  unsupportedExpertVariables,
  unsupportedVariablesMessage,
} from "./expert-template-variables";
import { buildPlayerVariables } from "./template-vars.server";

describe("expert template variables", () => {
  it("supported + unsupported cover every key buildPlayerVariables fills (besides {link})", () => {
    const keys = Object.keys(buildPlayerVariables({})).filter((k) => k !== "link");
    const listed = [...EXPERT_SUPPORTED_VARIABLE_KEYS, ...EXPERT_UNSUPPORTED_VARIABLE_KEYS];
    expect(new Set(listed)).toEqual(new Set(keys));
    expect(listed.length).toBe(new Set(listed).size);
  });

  it("supported list includes the expert name and excludes sensitive keys", () => {
    expect(EXPERT_SUPPORTED_VARIABLE_KEYS).toContain("expert");
    expect(EXPERT_SUPPORTED_VARIABLE_KEYS).toContain("nome_expert");
    for (const key of ["email", "saldo", "saldo_atual", "status_lead"]) {
      expect(EXPERT_SUPPORTED_VARIABLE_KEYS).not.toContain(key);
    }
  });

  it("finds unsupported tokens once, in order, ignoring {link}", () => {
    expect(
      unsupportedExpertVariables("{nome} {saldo} {link} {email} {saldo} {duracao_chamada}"),
    ).toEqual(["{saldo}", "{email}", "{duracao_chamada}"]);
    expect(unsupportedExpertVariables("Oi {primeiro_nome}, aqui é {expert}: {link}")).toEqual([]);
  });

  it("house links depend on the house having a site URL", () => {
    expect(unsupportedExpertVariables("{link_login} {link_bonus}")).toEqual([]);
    expect(
      unsupportedExpertVariables("{link_login} {link_bonus}", { houseHasSite: false }),
    ).toEqual(["{link_login}", "{link_bonus}"]);
  });

  it("builds the pt-BR blocking message", () => {
    expect(unsupportedVariablesMessage(["{saldo}", "{email}"])).toBe(
      "Este modelo usa variáveis que o expert não pode preencher: {saldo}, {email}. Edite o texto.",
    );
  });
});
