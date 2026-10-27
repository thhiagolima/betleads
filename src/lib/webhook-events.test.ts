import { describe, expect, it } from "vitest";

import { describeEventType, WEBHOOK_EVENTS } from "./webhook-events";

describe("describeEventType", () => {
  it("usa o rótulo do webhook para cada slug gravado em events.tipo", () => {
    for (const event of WEBHOOK_EVENTS) {
      expect(describeEventType(event.slug).label).toBe(event.label);
    }
    expect(describeEventType("deposito-aprovado")).toEqual({
      label: "Depósito Aprovado",
      categoria: "Depósito",
      failed: false,
    });
    expect(describeEventType("saque-falhou").failed).toBe(true);
  });

  it("mantém os tipos antigos", () => {
    expect(describeEventType("deposito").label).toBe("Depósito");
    expect(describeEventType("bet").label).toBe("Aposta");
  });

  it("tipo desconhecido vira Evento, nunca Login", () => {
    expect(describeEventType("pix-gerado")).toEqual({
      label: "Evento",
      categoria: null,
      failed: false,
    });
    expect(describeEventType(null).label).toBe("Evento");
  });
});
