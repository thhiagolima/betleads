import { describe, expect, it } from "vitest";

import { maskDocumentsDeep, maskPayerDocument } from "./payer";

describe("maskPayerDocument", () => {
  it("masks an 11-digit CPF, keeping only digits 4-9 visible", () => {
    expect(maskPayerDocument("123.456.789-09")).toBe("***.456.789-**");
  });

  it("masks a 14-digit CNPJ, keeping only digits 3-8 visible", () => {
    expect(maskPayerDocument("12345678000199")).toBe("**.345.678/****-**");
  });

  it("masks any other digit count fully", () => {
    expect(maskPayerDocument("123")).toBe("***");
  });

  it("returns null for null", () => {
    expect(maskPayerDocument(null)).toBeNull();
  });

  it("strips non-digit characters before counting (plain digits, no punctuation)", () => {
    expect(maskPayerDocument("12345678909")).toBe("***.456.789-**");
  });

  it("masks an empty string fully", () => {
    expect(maskPayerDocument("")).toBe("***");
  });
});

describe("maskDocumentsDeep", () => {
  it("masks every `document` key at any depth, inside nested objects and arrays", () => {
    const input = {
      id: "evt-1",
      payer: { name: "Fulano", document: "123.456.789-09" },
      data: {
        payer: { Document: "12345678000199" },
        payments: [
          { payer: { DOCUMENT: "123.456.789-09" } },
          [{ deep: { document: "98765432100" } }],
        ],
      },
    };
    const { value, masked } = maskDocumentsDeep(input);
    const out = value as {
      payer: Record<string, unknown>;
      data: { payer: Record<string, unknown>; payments: Array<{ payer: Record<string, unknown> }> };
    };
    const serialized = JSON.stringify(value);

    expect(masked).toBe(4);
    expect(serialized).not.toContain("123.456.789-09");
    expect(serialized).not.toContain("12345678000199");
    expect(serialized).not.toContain("98765432100");
    expect(out.payer.document).toBe("***.456.789-**");
    expect(out.data.payer.Document).toBe("**.345.678/****-**");
    expect(out.data.payments[0].payer.DOCUMENT).toBe("***.456.789-**");
    expect(serialized).toContain('"document":"***.654.321-**"');
    // The input itself is never mutated.
    expect(input.payer.document).toBe("123.456.789-09");
  });

  it("replaces a non-string document value with null", () => {
    const { value, masked } = maskDocumentsDeep({
      payer: { document: 12345678909 },
      list: [{ document: { number: "123.456.789-09" } }],
    });
    expect(masked).toBe(2);
    expect(value).toEqual({ payer: { document: null }, list: [{ document: null }] });
  });

  it("leaves a payload with no document key unchanged and reports 0", () => {
    const input = { a: 1, b: [1, "x", null, { c: true }], d: null };
    const { value, masked } = maskDocumentsDeep(input);
    expect(masked).toBe(0);
    expect(value).toEqual(input);
  });

  it("passes primitives and null through", () => {
    expect(maskDocumentsDeep(null)).toEqual({ value: null, masked: 0 });
    expect(maskDocumentsDeep("x")).toEqual({ value: "x", masked: 0 });
  });
});
