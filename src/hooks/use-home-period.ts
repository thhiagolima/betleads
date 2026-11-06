// Período do "Início" (casa e expert): o preset/intervalo do PeriodPicker e
// o que o cabeçalho mostra dele. Compartilhado por src/routes/index.tsx e
// src/routes/expert.index.tsx.
import { useState } from "react";
import { type DateRange } from "react-day-picker";

import { periodRange, type PeriodPreset } from "@/lib/home-dashboard";
import { brtDayStart } from "@/lib/tz";

export function brtDayKeyLocal(d: Date) {
  return d
    .toLocaleString("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .slice(0, 10);
}

function shortDate(date: Date) {
  return date.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
}

/** Período do PeriodPicker (padrão: 7 dias) e o que o cabeçalho mostra dele. */
export function useHomePeriod() {
  const [preset, setPreset] = useState<PeriodPreset>("7d");
  const [range, setRange] = useState<DateRange | undefined>(() => periodRange("7d"));

  const from = range?.from ?? new Date();
  const to = range?.to ?? from;
  const includesToday = brtDayStart(to).getTime() >= brtDayStart(new Date()).getTime();
  const rangeText =
    brtDayKeyLocal(from) === brtDayKeyLocal(to)
      ? shortDate(from)
      : `${shortDate(from)} a ${shortDate(to)}`;

  return {
    preset,
    range,
    from,
    to,
    includesToday,
    rangeText,
    onChange: (nextPreset: PeriodPreset, nextRange: DateRange | undefined) => {
      setPreset(nextPreset);
      setRange(nextRange);
    },
  };
}
