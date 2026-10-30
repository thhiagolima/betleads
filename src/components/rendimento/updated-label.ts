// "Atualizado às hh:mm" do cabeçalho dos relatórios de rendimento (pessoa e
// equipe). Fora do dia de hoje em São Paulo, a hora sozinha engana: vira
// "Atualizado em dd/mm às hh:mm".
import { brtDayKey } from "@/lib/tz";

const TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});

const DAY = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
});

/** Instante ISO -> "Atualizado às hh:mm" (hoje em SP) ou "Atualizado em dd/mm às hh:mm". */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = TIME.format(at);
  return brtDayKey(at) === brtDayKey(now)
    ? `Atualizado às ${time}`
    : `Atualizado em ${DAY.format(at)} às ${time}`;
}
