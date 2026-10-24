import { describe, expect, it } from "vitest";

import { buildExpertTimeline, type ExpertTimelineSources } from "./expert-lead-sheet";

function emptySources(): ExpertTimelineSources {
  return {
    deposits: [],
    withdrawals: [],
    cashbacks: [],
    sms: [],
    emails: [],
    links: [],
    contacts: [],
    followups: [],
  };
}

describe("buildExpertTimeline", () => {
  it("timeline merges sources newest first and caps at 60", () => {
    const sources = emptySources();
    for (let i = 0; i < 40; i++) {
      sources.deposits.push({
        id: `d${i}`,
        valor: 10,
        at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      });
      sources.withdrawals.push({
        id: `w${i}`,
        valor: 5,
        at: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
      });
    }
    sources.sms.push({ id: "s1", content: "oi", at: "2026-10-20T00:00:00.000Z" });

    const items = buildExpertTimeline(sources);
    expect(items).toHaveLength(60);
    expect(items[0].id).toBe("sms_casa:s1");
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].at >= items[i].at).toBe(true);
    }
    // the 40 withdrawals (2026-10-02) all beat the deposits (2026-10-01)
    expect(items.filter((i) => i.kind === "saque")).toHaveLength(40);
    expect(items.filter((i) => i.kind === "deposito")).toHaveLength(19);

    expect(buildExpertTimeline(sources, 5)).toHaveLength(5);
  });

  it("titles use the pt-BR copy", () => {
    const sources = emptySources();
    sources.deposits.push({ id: "d", valor: 50, at: "2026-10-01T00:00:00Z" });
    sources.withdrawals.push({ id: "w", valor: 20, at: "2026-10-02T00:00:00Z" });
    sources.cashbacks.push({ id: "c", valor: 5, at: "2026-10-03T00:00:00Z" });
    sources.sms.push({ id: "s", content: "Volte!", at: "2026-10-04T00:00:00Z" });
    sources.emails.push({ id: "e", subject: "Bônus para você", at: "2026-10-05T00:00:00Z" });
    sources.links.push({
      id: "l",
      oferta: "Giros grátis",
      at: "2026-10-06T00:00:00Z",
      clickedAt: "2026-10-07T00:00:00Z",
    });
    sources.contacts.push({
      id: "k",
      resultado: "prometeu_depositar",
      nota: "Amanhã",
      at: "2026-10-08T00:00:00Z",
    });
    sources.followups.push({
      id: "f",
      dueDate: "2026-10-30",
      nota: "Ligar",
      at: "2026-10-09T00:00:00Z",
    });

    const byKind = Object.fromEntries(buildExpertTimeline(sources).map((i) => [i.kind, i]));
    expect(byKind.deposito).toMatchObject({ titulo: "Depósito", valor: 50, detalhe: null });
    expect(byKind.saque).toMatchObject({ titulo: "Saque", valor: 20 });
    expect(byKind.cashback).toMatchObject({ titulo: "Cashback", valor: 5 });
    expect(byKind.sms_casa).toMatchObject({
      titulo: "SMS da casa",
      detalhe: "Volte!",
      valor: null,
    });
    expect(byKind.email_casa).toMatchObject({
      titulo: "E-mail da casa",
      detalhe: "Bônus para você",
    });
    expect(byKind.link_expert).toMatchObject({ titulo: 'Você enviou o link "Giros grátis"' });
    expect(byKind.clique).toMatchObject({
      titulo: 'Clicou no link "Giros grátis"',
      at: "2026-10-07T00:00:00Z",
    });
    expect(byKind.contato).toMatchObject({
      titulo: "Contato: Prometeu depositar",
      detalhe: "Amanhã",
    });
    expect(byKind.retorno).toMatchObject({
      titulo: "Retorno agendado para 30/10/2026",
      detalhe: "Ligar",
    });
  });

  it("link without click gives no click item", () => {
    const sources = emptySources();
    sources.links.push({ id: "l", oferta: "Oferta", at: "2026-10-06T00:00:00Z", clickedAt: null });
    expect(buildExpertTimeline(sources).map((i) => i.kind)).toEqual(["link_expert"]);
  });

  it("sms detail is truncated to 160 chars", () => {
    const sources = emptySources();
    sources.sms.push({ id: "s", content: "x".repeat(300), at: "2026-10-04T00:00:00Z" });
    const [item] = buildExpertTimeline(sources);
    expect(item.detalhe).toHaveLength(160);
  });

  it("empty sources give an empty timeline", () => {
    expect(buildExpertTimeline(emptySources())).toEqual([]);
  });
});
