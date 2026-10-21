import { describe, expect, it } from "vitest";

import { PLAYERS_CSV_HEADERS, playersCsv, type PlayersCsvRow } from "./players-csv";

const row = (overrides: Partial<PlayersCsvRow>): PlayersCsvRow => ({
  nome: "Ana",
  telefone: "11999990000",
  email: null,
  player_external_id: "ext-1",
  origem: null,
  expert: null,
  status: "ativo",
  vip: false,
  ultimo_login: null,
  ultimo_jogo: null,
  ultimo_deposito: null,
  total_depositado: 0,
  total_sacado: 0,
  saldo_carteira: 0,
  saldo_bonus: 0,
  tags: [],
  ...overrides,
});

describe("playersCsv", () => {
  it("escreve cabeçalhos em pt-BR e uma linha por jogador", () => {
    const csv = playersCsv([row({}), row({ nome: "Bia" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(PLAYERS_CSV_HEADERS.join(","));
    expect(lines[0]).toContain("Último depósito");
    expect(lines).toHaveLength(3);
  });

  it("calcula saldo, lucro e nível pelas faixas recebidas", () => {
    const csv = playersCsv(
      [
        row({
          total_depositado: 600,
          total_sacado: 100,
          saldo_carteira: 10,
          saldo_bonus: 5,
          vip: true,
        }),
      ],
      { bronze: 10, silver: 200, gold: 1000, diamond: 2000, black: 5000 },
    );
    const cells = csv.split("\n")[1].split(",");
    const at = (header: string) => cells[PLAYERS_CSV_HEADERS.indexOf(header)];
    expect(at("Nível")).toBe("Prata");
    expect(at("VIP")).toBe("sim");
    expect(at("Saldo")).toBe("15");
    expect(at("Lucro")).toBe("500");
  });

  it("escapa vírgula e aspas", () => {
    const csv = playersCsv([row({ nome: 'Ana "A", Silva' })]);
    expect(csv.split("\n")[1].startsWith('"Ana ""A"", Silva"')).toBe(true);
  });
});

describe("CSV formula injection", () => {
  it("neutralizes text that a spreadsheet would run as a formula", async () => {
    const { neutralizeCsvFormula } = await import("./csv-safe");
    expect(neutralizeCsvFormula('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(neutralizeCsvFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeCsvFormula("Ana")).toBe("Ana");
    expect(neutralizeCsvFormula(-12.5)).toBe("-12.5");
    expect(neutralizeCsvFormula(null)).toBe("");
  });
});
