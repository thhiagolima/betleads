import { describe, expect, it } from "vitest";
import {
  externalListBlockedVariables,
  externalListVariablesError,
  externalRecipientHash,
  parseEmailList,
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

describe("parseEmailList", () => {
  it("reads one-per-line, comma, semicolon and space separated lists", () => {
    const r = parseEmailList(
      "ana@exemplo.com\nBeto@Exemplo.com.br, carla@x.io;dani@y.com eva@z.net\r\n",
    );
    expect(r.emails).toEqual([
      "ana@exemplo.com",
      "beto@exemplo.com.br",
      "carla@x.io",
      "dani@y.com",
      "eva@z.net",
    ]);
    expect(r.invalidCount).toBe(0);
  });

  it("strips quotes, angle brackets and mailto:", () => {
    const r = parseEmailList('"ana@exemplo.com";<beto@exemplo.com>\nmailto:carla@exemplo.com');
    expect(r.emails).toEqual(["ana@exemplo.com", "beto@exemplo.com", "carla@exemplo.com"]);
  });

  it("ignores header and name cells, counts invalid addresses and duplicates", () => {
    const r = parseEmailList(
      "nome;email\nAna;ana@exemplo.com\nBeto;beto@\nCarla;ANA@exemplo.com\nDani;dani@@x.com\nEva;eva..x@y.com",
    );
    expect(r.emails).toEqual(["ana@exemplo.com"]);
    expect(r.duplicates).toBe(1);
    expect(r.invalidCount).toBe(3);
    expect(r.invalid).toEqual(["beto@", "dani@@x.com", "eva..x@y.com"]);
  });

  it("reads tabs and pipes and rejects addresses longer than 255 characters", () => {
    const long = `${"a".repeat(250)}@x.com`;
    const r = parseEmailList(`ana@x.com\tbeto@y.com|${long}`);
    expect(r.emails).toEqual(["ana@x.com", "beto@y.com"]);
    expect(r.invalidCount).toBe(1);
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
