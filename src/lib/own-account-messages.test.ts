import { describe, expect, it } from "vitest";

import { tenantSafeChannelError } from "./channel-error";
import { ownAccountRefusalMessage } from "./sms.functions";

describe("recusa da conta própria no envio de teste", () => {
  it("mostra o motivo da conta da casa, sem o HTTP", () => {
    expect(ownAccountRefusalMessage("HTTP 403: Invalid token")).toBe(
      'Sua conta de SMS recusou o envio. Confira saldo e credenciais em Integrações → Canais. Resposta da sua conta: "Invalid token".',
    );
  });

  it("sem motivo, só a orientação", () => {
    expect(ownAccountRefusalMessage(null)).toBe(
      "Sua conta de SMS recusou o envio. Confira saldo e credenciais em Integrações → Canais.",
    );
  });

  it("a capa genérica deixa passar a mensagem da conta própria", () => {
    const message = ownAccountRefusalMessage("HTTP 403: Invalid token");
    expect(tenantSafeChannelError(new Error(message))).toBe(message);
  });

  it("e continua escondendo erro técnico da plataforma", () => {
    expect(tenantSafeChannelError(new Error("HTTP 403: Invalid token"))).toBe(
      "Não foi possível concluir a operação do canal. Tente novamente ou contate o suporte.",
    );
  });
});
