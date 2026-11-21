// Saldo da Short Brasil lido do painel (a API não tem consulta de saldo).
// Regras puras, sem acesso ao banco: o servidor (sms-balance.server.ts) busca
// as leituras e chama estas funções; a barra e o painel do admin importam os
// tipos. Não importar nada `*.server.ts` aqui.

export const BALANCE_CHECK_INTERVAL_MINUTES = 15;
export const DEFAULT_LOW_THRESHOLD = 1000;
export const MAX_BALANCE_VIEWERS = 30;
/** Leitura mais velha que isso não vale como saldo atual (robô parado ou painel fora). */
export const BALANCE_STALE_AFTER_MS = 3 * BALANCE_CHECK_INTERVAL_MINUTES * 60_000;

export type BalanceCheckResult = "ok" | "login_failed" | "read_failed" | "error";

export type BalanceCheckRow = {
  checked_at: string;
  result: BalanceCheckResult;
  shortcode_sms: number | null;
  error: string | null;
};

/** empty = zero ou negativo; low = até o limite; unknown = sem leitura recente. */
export type BalanceLevel = "ok" | "low" | "empty" | "unknown";

export type BalanceStatus = {
  level: BalanceLevel;
  /** Saldo da última leitura que deu certo (pode ser negativo). */
  balance: number | null;
  /** Hora dessa leitura. */
  balanceAt: string | null;
  threshold: number;
  /** Desde quando as leituras seguidas mostram saldo zerado. */
  emptySince: string | null;
  lastCheckAt: string | null;
  /** Erro da última leitura quando ela falhou. */
  lastError: string | null;
  /** Nenhuma leitura deu certo nos últimos BALANCE_STALE_AFTER_MS. */
  unreadable: boolean;
};

/**
 * Saldo de SMS shortcode na resposta do painel (chamada Sajax
 * `atualiza_box_shortcode` de rev-transferir.php), que traz um trecho de HTML
 * como `SALDO DISPONÍVEL: -27 SMS(s)`. null quando o texto não aparece.
 */
export function parseShortcodeBalance(body: string): number | null {
  const match = /SALDO\s+DISPON\S*VEL\s*:?\s*(-?\s*[\d.]+)\s*SMS/i.exec(body);
  if (!match) return null;
  // Ponto é separador de milhar no painel ("12.345"); SMS é sempre inteiro.
  const value = Number(match[1].replace(/[\s.]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** `rows` do mais novo para o mais velho. */
export function computeBalanceStatus(
  rows: BalanceCheckRow[],
  threshold: number,
  now: Date,
): BalanceStatus {
  const status: BalanceStatus = {
    level: "unknown",
    balance: null,
    balanceAt: null,
    threshold,
    emptySince: null,
    lastCheckAt: rows[0]?.checked_at ?? null,
    lastError: rows[0] && rows[0].result !== "ok" ? rows[0].error : null,
    unreadable: false,
  };
  const nowMs = now.getTime();
  const read = rows.filter((row) => row.result === "ok" && row.shortcode_sms != null);
  const latest = read[0];
  const fresh = latest && nowMs - new Date(latest.checked_at).getTime() <= BALANCE_STALE_AFTER_MS;
  // Só acusa "não consigo ler" depois de um tempo: uma falha isolada do painel não é aviso.
  status.unreadable =
    rows.length > 0 && rows[0].result !== "ok" && !fresh &&
    nowMs - new Date(rows[rows.length - 1].checked_at).getTime() > BALANCE_STALE_AFTER_MS;
  if (!latest || !fresh) return status;

  const balance = latest.shortcode_sms as number;
  status.balance = balance;
  status.balanceAt = latest.checked_at;
  if (balance <= 0) {
    status.level = "empty";
    for (const row of read) {
      if ((row.shortcode_sms as number) > 0) break;
      status.emptySince = row.checked_at;
    }
  } else if (balance <= threshold) {
    status.level = "low";
  } else {
    status.level = "ok";
  }
  return status;
}

/** Usuário do CRM que pode ser escolhido para ver o aviso (super admin já vê sempre). */
export type BalanceUserOption = { userId: string; email: string; nome: string; casas: string[] };

export type BalanceBannerKind = "empty" | "low" | "unreadable";

/** Barra do topo (null = nada a avisar). */
export function balanceBanner(status: BalanceStatus): BalanceBannerKind | null {
  if (status.level === "empty") return "empty";
  if (status.level === "low") return "low";
  if (status.unreadable) return "unreadable";
  return null;
}
