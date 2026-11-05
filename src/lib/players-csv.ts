// CSV da lista de Jogadores (C-06). Função pura: recebe as linhas do filtro
// inteiro e as faixas de nível configuradas, devolve o texto do arquivo.
import { neutralizeCsvFormula } from "@/lib/csv-safe";
import { DEFAULT_CURRENCY, toTenantCurrency, type TenantCurrency } from "@/lib/currency";
import {
  DEFAULT_LEVEL_THRESHOLDS,
  LEVEL_LABEL,
  levelForTotal,
  type LevelThresholds,
} from "@/lib/player-level";

export type PlayersCsvRow = {
  nome: string | null;
  telefone: string | null;
  email: string | null;
  player_external_id: string | null;
  origem: string | null;
  expert: string | null;
  status: string | null;
  vip: boolean | null;
  ultimo_login: string | null;
  ultimo_jogo: string | null;
  ultimo_deposito: string | null;
  total_depositado: number | null;
  total_sacado: number | null;
  saldo_carteira: number | null;
  saldo_bonus: number | null;
  tags: string[] | null;
};

/** Colunas de valor da casa: o número sai cru e o cabeçalho leva o código da moeda. */
const MONEY_HEADERS = ["Total depositado", "Total sacado", "Saldo", "Lucro"] as const;

/** Cabeçalhos do CSV; as colunas de valor dizem a moeda da casa ("Saldo (ARS)"). */
export function playersCsvHeaders(currency: TenantCurrency = DEFAULT_CURRENCY): string[] {
  const code = toTenantCurrency(currency);
  return [
    "Nome",
    "Telefone",
    "E-mail",
    "ID externo",
    "Origem",
    "Expert",
    "Status",
    "VIP",
    "Nível",
    "Último login",
    "Último jogo",
    "Último depósito",
    ...MONEY_HEADERS.map((header) => `${header} (${code})`),
    "Tags",
  ];
}

export const PLAYERS_CSV_HEADERS = playersCsvHeaders(DEFAULT_CURRENCY);

function escapeCsv(value: unknown) {
  const text = neutralizeCsvFormula(value);
  return /[",\n;\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function playersCsv(
  rows: PlayersCsvRow[],
  thresholds: LevelThresholds = DEFAULT_LEVEL_THRESHOLDS,
  currency: TenantCurrency = DEFAULT_CURRENCY,
): string {
  const lines = [playersCsvHeaders(currency).map(escapeCsv).join(",")];
  for (const p of rows) {
    const depositado = Number(p.total_depositado ?? 0);
    const sacado = Number(p.total_sacado ?? 0);
    const saldo = Number(p.saldo_carteira ?? 0) + Number(p.saldo_bonus ?? 0);
    lines.push(
      [
        p.nome,
        p.telefone,
        p.email,
        p.player_external_id,
        p.origem,
        p.expert,
        p.status,
        p.vip ? "sim" : "não",
        LEVEL_LABEL[levelForTotal(depositado, thresholds)],
        p.ultimo_login,
        p.ultimo_jogo,
        p.ultimo_deposito,
        depositado,
        sacado,
        saldo,
        depositado - sacado,
        (p.tags ?? []).join("|"),
      ]
        .map(escapeCsv)
        .join(","),
    );
  }
  return lines.join("\n");
}
