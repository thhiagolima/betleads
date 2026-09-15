// Helpers para trabalhar com o fuso America/Sao_Paulo (BRT, UTC-3 fixo).
// O Brasil não observa horário de verão desde 2019, então usamos offset fixo.
// Usado por dashboards e contadores para que "hoje" signifique o dia do
// calendário em Brasília, e não a meia-noite UTC.

const BRT_OFFSET_MIN = -180; // -03:00 em minutos

function brtParts(d: Date): { y: number; m: number; day: number } {
  // Desloca o instante UTC para "wall clock" de Brasília somando o offset.
  const shifted = new Date(d.getTime() + BRT_OFFSET_MIN * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 00:00 BRT de um dia YYYY-MM-DD, retornado como instante UTC. */
export function parseBrtDayStart(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  // 00:00 BRT = 03:00 UTC do mesmo dia
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 3, 0, 0, 0));
}

/** 23:59:59.999 BRT de um dia YYYY-MM-DD, retornado como instante UTC. */
export function parseBrtDayEnd(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  // 23:59:59.999 BRT = 02:59:59.999 UTC do dia seguinte
  return new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1, 2, 59, 59, 999));
}

/** Início do dia BRT que contém o instante `at` (default: agora). */
export function brtDayStart(at: Date = new Date()): Date {
  const { y, m, day } = brtParts(at);
  return new Date(Date.UTC(y, m - 1, day, 3, 0, 0, 0));
}

/** Fim (23:59:59.999) do dia BRT que contém o instante `at` (default: agora). */
export function brtDayEnd(at: Date = new Date()): Date {
  const { y, m, day } = brtParts(at);
  return new Date(Date.UTC(y, m - 1, day + 1, 2, 59, 59, 999));
}

/** YYYY-MM-DD do dia BRT que contém o instante `at`. */
export function brtDayKey(at: Date): string {
  const { y, m, day } = brtParts(at);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}