// Formatação da ficha do lead (Área do Expert): datas sempre no fuso de São
// Paulo (mesmo dia que o servidor usa em tz.ts) e a mensagem de erro das ações.
import { brtDayKey } from "@/lib/tz";

const TIME_ZONE = "America/Sao_Paulo";

/** Instante ISO -> "dd/mm". */
export function formatBrtDdMm(iso: string): string {
  const [, mm, dd] = brtDayKey(new Date(iso)).split("-");
  return `${dd}/${mm}`;
}

/** Instante ISO -> "dd/mm/aaaa". */
export function formatBrtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: TIME_ZONE });
}

/** Instante ISO -> "dd/mm/aaaa, hh:mm". */
export function formatBrtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "aaaa-mm-dd" -> "dd/mm/aaaa", sem passar por Date (não desloca o dia). */
export function formatDueDate(dueDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : dueDate;
}

/** Hoje em São Paulo, "aaaa-mm-dd" (mínimo do campo de data do retorno). */
export function brtToday(): string {
  return brtDayKey(new Date());
}

const FALLBACK_ERROR = "Não foi possível concluir agora. Tente de novo.";

/**
 * Erro de uma ação da ficha: a mensagem do servidor (já em pt-BR) como está —
 * nunca colapsada na mensagem genérica de acesso; fallback só para valores
 * que não são Error.
 */
export function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FALLBACK_ERROR;
}
