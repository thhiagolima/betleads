import { describe, expect, it } from "vitest";

import { detectAlerts, whatsappMessageFor, type Alerta, type PlayerLike } from "./player-rules";

const nbsp = (s: string) => s.replaceAll(String.fromCharCode(160), " ");

const idle = new Date(Date.now() - 5 * 86400000).toISOString();
const saldoParado: PlayerLike = {
  nome: "Ana Souza",
  saldo_carteira: 10000,
  total_depositado: 200,
  ultimo_login: idle,
  ultimo_jogo: idle,
  ultimo_deposito: idle,
};

describe("moeda da casa nos textos dos alertas", () => {
  it("usa BRL por padrão", () => {
    const alerta = detectAlerts(saldoParado).find((a) => a.tipo === "saldo_parado");
    expect(nbsp(alerta?.motivo ?? "")).toContain("R$ 10.000 parado em conta");
  });

  it("formata na moeda recebida (ARS em es-AR)", () => {
    const alerta = detectAlerts(saldoParado, "ARS").find((a) => a.tipo === "saldo_parado");
    const motivo = nbsp(alerta?.motivo ?? "");
    expect(motivo).toContain("$ 10.000 parado em conta");
    expect(motivo).not.toContain("R$");
  });

  it("mensagem de WhatsApp segue a moeda da casa", () => {
    const alerta = { tipo: "saldo_parado" } as Alerta;
    expect(nbsp(whatsappMessageFor(alerta, saldoParado))).toContain("tem R$ 10.000 na sua conta");
    const ars = nbsp(whatsappMessageFor(alerta, saldoParado, "ARS"));
    expect(ars).toContain("tem $ 10.000 na sua conta");
    expect(ars).not.toContain("R$");
  });
});
