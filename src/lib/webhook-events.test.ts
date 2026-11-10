import { describe, expect, it } from "vitest";

import {
  describeEventType,
  eventTransactionRef,
  shortTransactionRef,
  WEBHOOK_EVENTS,
} from "./webhook-events";

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

describe("eventTransactionRef", () => {
  it("lê o id da transação em cada formato de webhook", () => {
    // Envelope `user` (Bravabet, LaEleBet, Mega Sorte): id numérico da casa.
    expect(eventTransactionRef({ deposit: { id: 311 }, event_id: "x" })).toBe("311");
    expect(eventTransactionRef({ withdraw: { id: 378 } })).toBe("378");
    // Formato plano (777): `transaction_id`, não o `id` (que é o player).
    expect(eventTransactionRef({ id: "937789", transaction_id: "cmw99b06" })).toBe("cmw99b06");
    // Forrandobet: dentro de `data`.
    expect(eventTransactionRef({ data: { transactionId: "6af317cb" } })).toBe("6af317cb");
    // Betgreen/Pix: `subject` de payment_transaction.
    expect(eventTransactionRef({ subject: { type: "payment_transaction", id: "5c943c66" } })).toBe(
      "5c943c66",
    );
    expect(eventTransactionRef({ subject: { type: "user", id: "u1" } })).toBeNull();
    expect(eventTransactionRef(null)).toBeNull();
  });

  it("encurta ids longos para o final", () => {
    expect(shortTransactionRef("311")).toBe("#311");
    expect(shortTransactionRef("5c943c66-641d-41d9-aa80-d9d3c08eef9e")).toBe("#…8eef9e");
  });
});
