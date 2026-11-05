// Variáveis do script de voz: {saldo} e {total_depositado} saem na moeda da casa.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { buildVariables, renderCallScript } from "./calls.server";

const nbsp = (s: string) => s.replaceAll(String.fromCharCode(160), " ");
const lead = { nome: "Ana Souza", saldo_carteira: 10000, total_depositado: 1234.5 };

describe("variáveis de ligação na moeda da casa", () => {
  it("usa BRL por padrão", () => {
    const vars = buildVariables(lead);
    expect(nbsp(vars.saldo)).toBe("R$ 10.000,00");
    expect(nbsp(vars.total_depositado)).toBe("R$ 1.234,50");
  });

  it("formata em ARS (es-AR) quando a casa é argentina", () => {
    const vars = buildVariables(lead, "ARS");
    expect(nbsp(vars.saldo)).toBe("$ 10.000,00");
    expect(nbsp(renderCallScript("Oi {primeiro_nome}, saldo {saldo}", lead, "ARS"))).toBe(
      "Oi Ana, saldo $ 10.000,00",
    );
  });

  it("saldo ausente vira zero na moeda", () => {
    expect(nbsp(buildVariables({ nome: "Bia" }, "ARS").saldo)).toBe("$ 0,00");
  });
});
