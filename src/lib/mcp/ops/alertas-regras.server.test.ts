// MCP do grupo §5.9: each alert rule on its own, at and around its threshold.
import { describe, expect, it } from "vitest";

import {
  CONSUMO_MEDIO_DIAS,
  FALHA_LIMITE,
  JANELA_CAMPANHAS_DIAS,
  JORNADA_PARADA_HORAS,
  ordenarAlertas,
  regraCampanha,
  regraIntegracaoParada,
  regraJornadaParada,
  regraSaldo,
  regraStatusCasa,
  regraTetoExpert,
  type Alerta,
} from "./alertas-regras.server";

const casa = { id: "t1", nome: "Casa Um" };
const FALHA = new Set(["falhou", "failed"]);

describe("thresholds", () => {
  it("are the spec's numbers", () => {
    expect(FALHA_LIMITE).toBe(0.2);
    expect(JORNADA_PARADA_HORAS).toBe(48);
    expect(CONSUMO_MEDIO_DIAS).toBe(3);
    expect(JANELA_CAMPANHAS_DIAS).toBe(7);
  });
});

describe("regraStatusCasa", () => {
  it("active house without lock: nothing", () => {
    expect(regraStatusCasa(casa, { status: "active", bloqueadaPorCobranca: false })).toEqual([]);
    expect(regraStatusCasa(casa, { status: null, bloqueadaPorCobranca: false })).toEqual([]);
  });

  it("suspended, canceled and billing lock are alta", () => {
    expect(regraStatusCasa(casa, { status: "suspended", bloqueadaPorCobranca: false })).toEqual([
      expect.objectContaining({ tipo: "casa_suspensa", gravidade: "alta" }),
    ]);
    for (const status of ["canceled", "cancelled"]) {
      expect(regraStatusCasa(casa, { status, bloqueadaPorCobranca: false })[0]).toMatchObject({
        tipo: "casa_cancelada",
        gravidade: "alta",
      });
    }
    const both = regraStatusCasa(casa, { status: "suspended", bloqueadaPorCobranca: true });
    expect(both.map((a) => a.tipo)).toEqual(["casa_suspensa", "bloqueio_cobranca"]);
    expect(both.every((a) => a.gravidade === "alta")).toBe(true);
  });
});

describe("regraSaldo", () => {
  it("no consumption: never alerts, even with zero balance", () => {
    expect(regraSaldo(casa, { saldo: 0, consumoMedioDiario: 0 })).toBeNull();
  });

  it("balance equal to the average is not low", () => {
    expect(regraSaldo(casa, { saldo: 10, consumoMedioDiario: 10 })).toBeNull();
  });

  it("just below the average is media", () => {
    expect(regraSaldo(casa, { saldo: 9.99, consumoMedioDiario: 10 })).toMatchObject({
      tipo: "saldo_baixo",
      gravidade: "media",
    });
  });

  it("zero or negative is alta", () => {
    expect(regraSaldo(casa, { saldo: 0, consumoMedioDiario: 1 })).toMatchObject({
      tipo: "saldo_zerado",
      gravidade: "alta",
    });
    expect(regraSaldo(casa, { saldo: -2, consumoMedioDiario: 1 })?.tipo).toBe("saldo_zerado");
  });

  it("money in pt-BR", () => {
    expect(regraSaldo(casa, { saldo: 5, consumoMedioDiario: 12.5 })?.mensagem).toContain(
      "R$ 12,50",
    );
  });
});

describe("regraCampanha", () => {
  const camp = (total: number | null, falhas: number | null, status = "enviado") => ({
    canal: "sms",
    id: "c1",
    nome: "Promo",
    status,
    total,
    falhas,
  });

  it("failed status alerts regardless of counts", () => {
    expect(regraCampanha(casa, camp(0, 0, "falhou"), FALHA)).toMatchObject({
      tipo: "campanha_com_falha",
      gravidade: "media",
      ref: { tipo: "campanha", id: "c1", canal: "sms" },
    });
  });

  it("exactly 20% does not alert; above does", () => {
    expect(regraCampanha(casa, camp(100, 20), FALHA)).toBeNull();
    expect(regraCampanha(casa, camp(100, 21), FALHA)?.mensagem).toContain("21%");
    expect(regraCampanha(casa, camp(1000, 201), FALHA)?.mensagem).toContain("20,1%");
  });

  it("no total or null counts: no ratio alert", () => {
    expect(regraCampanha(casa, camp(0, 5), FALHA)).toBeNull();
    expect(regraCampanha(casa, camp(null, null), FALHA)).toBeNull();
  });
});

describe("regraJornadaParada", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();

  it("never sent: no alert", () => {
    expect(regraJornadaParada(casa, { id: "j", nome: "J", ultimoEnvioEm: null }, now)).toBeNull();
  });

  it("sent within 48 h: no alert", () => {
    expect(
      regraJornadaParada(casa, { id: "j", nome: "J", ultimoEnvioEm: at(47.99) }, now),
    ).toBeNull();
  });

  it("last send exactly 48 h ago or older: media", () => {
    expect(
      regraJornadaParada(casa, { id: "j", nome: "J", ultimoEnvioEm: at(48) }, now),
    ).toMatchObject({
      tipo: "jornada_sem_envio",
      gravidade: "media",
      ref: { tipo: "jornada", id: "j" },
    });
    expect(
      regraJornadaParada(casa, { id: "j", nome: "J", ultimoEnvioEm: at(100) }, now)?.mensagem,
    ).toContain("100 h");
  });
});

describe("regraTetoExpert", () => {
  it("is media with the expert ref", () => {
    expect(regraTetoExpert(casa, { id: "e1", nome: " Ana " })).toEqual({
      casa,
      tipo: "teto_expert",
      gravidade: "media",
      mensagem: 'Expert "Ana" atingiu o teto mensal de envios.',
      ref: { tipo: "expert", id: "e1" },
    });
  });
});

describe("regraIntegracaoParada", () => {
  it("no rows (both days missing) is alta", () => {
    expect(regraIntegracaoParada(casa, [])).toMatchObject({
      tipo: "integracao_parada",
      gravidade: "alta",
    });
  });

  it("zeros on both days is alta", () => {
    expect(
      regraIntegracaoParada(casa, [
        { cadastros: 0, depositos: 0 },
        { cadastros: 0, depositos: 0 },
      ]),
    ).not.toBeNull();
  });

  it("one signup or one deposit on any day: no alert", () => {
    expect(regraIntegracaoParada(casa, [{ cadastros: 1, depositos: 0 }])).toBeNull();
    expect(
      regraIntegracaoParada(casa, [
        { cadastros: 0, depositos: 0 },
        { cadastros: 0, depositos: 1 },
      ]),
    ).toBeNull();
  });
});

describe("ordenarAlertas", () => {
  it("alta first, then house name, then tipo", () => {
    const a = (nome: string, gravidade: Alerta["gravidade"], tipo: Alerta["tipo"]): Alerta => ({
      casa: { id: nome, nome },
      tipo,
      gravidade,
      mensagem: "",
    });
    const sorted = ordenarAlertas([
      a("Beta", "media", "teto_expert"),
      a("Beta", "alta", "saldo_zerado"),
      a("Alfa", "media", "jornada_sem_envio"),
      a("Alfa", "media", "campanha_com_falha"),
      a("Zeta", "alta", "casa_suspensa"),
    ]);
    expect(sorted.map((x) => `${x.gravidade}:${x.casa.nome}:${x.tipo}`)).toEqual([
      "alta:Beta:saldo_zerado",
      "alta:Zeta:casa_suspensa",
      "media:Alfa:campanha_com_falha",
      "media:Alfa:jornada_sem_envio",
      "media:Beta:teto_expert",
    ]);
  });
});
