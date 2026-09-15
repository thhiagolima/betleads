// Helpers compartilhados para "última atividade" de um player.
//
// Última atividade = mais recente entre `ultimo_login`, `ultimo_jogo` e
// `ultimo_deposito`. Usado por todos os filtros, segmentos e gatilhos para
// não depender exclusivamente do evento `login` (que pode chegar ausente,
// atrasado ou nunca — vide ingestão da BetCode).

type ActivityFields = {
  ultimo_login?: string | null;
  ultimo_jogo?: string | null;
  ultimo_deposito?: string | null;
};

function toMs(s?: string | null): number {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Maior timestamp (ms) entre login, jogo e depósito. 0 se nunca houve atividade. */
export function lastActivityMs(p: ActivityFields): number {
  return Math.max(toMs(p.ultimo_login), toMs(p.ultimo_jogo), toMs(p.ultimo_deposito));
}

/** Dias desde a última atividade. Infinity quando o player nunca teve atividade. */
export function daysSinceActivity(p: ActivityFields): number {
  const ms = lastActivityMs(p);
  if (!ms) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - ms) / 86400000);
}

/**
 * Verdadeiro se a última atividade do player é mais recente que `sinceIso`.
 * Usado pelos dispatchers para sair do fluxo quando o lead voltou a interagir
 * (login, jogo OU depósito) depois de entrar no fluxo.
 */
export function hasActivitySince(p: ActivityFields, sinceIso: string): boolean {
  const since = new Date(sinceIso).getTime();
  if (Number.isNaN(since)) return false;
  return lastActivityMs(p) > since;
}

// =====================================================================
// Helpers para construir filtros PostgREST (supabase-js) sobre janelas
// de "última atividade". Use-os para padronizar `players-list` e
// `email-segments` (e qualquer outro segmento de player no futuro).
// =====================================================================

// Os helpers abaixo recebem um query builder do supabase-js. Tipamos como
// genérico só com os métodos que usamos para não brigar com os tipos
// gerados (Tables/PostgrestFilterBuilder).
type Filterable = {
  or: (f: string) => unknown;
  lt: (c: string, v: string) => unknown;
  gte: (c: string, v: string) => unknown;
  not: (c: string, op: string, v: unknown) => unknown;
};

/** Restringe a query a players SEM atividade nos últimos `days` dias. */
export function applyInactiveAtLeast<T extends Filterable>(q: T, daysAgoIso: string): T {
  // Requer ultimo_login antigo (mantém o comportamento original de excluir
  // players sem login) e exige que jogo/depósito também estejam antigos ou nulos.
  const a = q.lt("ultimo_login", daysAgoIso) as Filterable;
  const b = a.or(`ultimo_jogo.is.null,ultimo_jogo.lt.${daysAgoIso}`) as Filterable;
  return (b.or(`ultimo_deposito.is.null,ultimo_deposito.lt.${daysAgoIso}`) as unknown) as T;
}

/** Restringe a query a players COM atividade nos últimos `days` dias (login OU jogo OU depósito). */
export function applyActiveWithin<T extends Filterable>(q: T, daysAgoIso: string): T {
  return (q.or(
    `ultimo_login.gte.${daysAgoIso},ultimo_jogo.gte.${daysAgoIso},ultimo_deposito.gte.${daysAgoIso}`,
  ) as unknown) as T;
}

/**
 * Restringe a query a players cuja última atividade está na janela [minDays, maxDays] dias atrás.
 * `minIso` = daysAgo(minDays) (mais recente), `maxIso` = daysAgo(maxDays) (mais antigo).
 */
export function applyInactivityWindow<T extends Filterable>(
  q: T,
  minIso: string,
  maxIso: string,
): T {
  // 1) lastActivity < minIso  → todas as três colunas antigas (ou nulas)
  // 2) lastActivity >= maxIso → pelo menos uma das três é mais recente que maxIso
  return applyActiveWithin(applyInactiveAtLeast(q, minIso), maxIso);
}