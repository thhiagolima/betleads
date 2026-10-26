import { describe, expect, it } from "vitest";
import {
  externalListBlockedVariables,
  externalListVariablesError,
  externalRecipientHash,
  parsePhoneList,
} from "./campaign-external-list";

describe("parsePhoneList", () => {
  it("reads one-per-line, comma and semicolon lists in any Brazilian format", () => {
    const r = parsePhoneList("(11) 98765-4321\n+55 21 99876 5432, 5531988887777;11 3333-4444\r\n");
    expect(r.phones).toEqual([
      "+5511987654321",
      "+5521998765432",
      "+5531988887777",
      "+551133334444",
    ]);
    expect(r.invalidCount).toBe(0);
  });

  it("ignores header and name cells, counts invalid numbers and duplicates", () => {
    const r = parsePhoneList(
      'nome;telefone\n"Ana";"11987654321"\nBeto;123\nCarla;(11) 98765-4321\nDani;0011987654321',
    );
    expect(r.phones).toEqual(["+5511987654321"]);
    expect(r.duplicates).toBe(1);
    expect(r.invalidCount).toBe(2);
    expect(r.invalid).toEqual(["123", "0011987654321"]);
  });

  it("reads a spreadsheet exported as semicolon CSV with tabs and pipes", () => {
    const r = parsePhoneList("11987654321\t21998765432|31988887777");
    expect(r.phones).toHaveLength(3);
  });
});

describe("externalListBlockedVariables", () => {
  it("accepts only house links", () => {
    expect(
      externalListBlockedVariables("Cadastre-se: {link} ou {link_login} {link_promo}"),
    ).toEqual([]);
  });

  it("blocks player variables, once each", () => {
    const blocked = externalListBlockedVariables(
      "Oi {primeiro_nome}, saldo {saldo}. {primeiro_nome}",
    );
    expect(blocked).toEqual(["primeiro_nome", "saldo"]);
    expect(externalListVariablesError(blocked)).toContain("{primeiro_nome}, {saldo}");
  });
});

describe("externalRecipientHash", () => {
  it("is stable per tenant and phone and differs across tenants", async () => {
    const a = await externalRecipientHash("t1", "+5511987654321");
    expect(a).toBe(await externalRecipientHash("t1", "+5511987654321"));
    expect(a).not.toBe(await externalRecipientHash("t2", "+5511987654321"));
    expect(a).toMatch(/^ext:[0-9a-f]{64}$/);
  });
});
