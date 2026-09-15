import { useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { type DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type DashboardRange = { from: Date; to: Date };

function fmt(d: Date) {
  return d.toLocaleDateString("pt-BR");
}

export function DashboardDateRangePicker({
  range,
  onChange,
}: {
  range: DashboardRange;
  onChange: (r: DashboardRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const value: DateRange = { from: range.from, to: range.to };
  const sameDay = range.from.toDateString() === range.to.toDateString();

  const setPreset = (days: number) => {
    const end = new Date();
    const start = new Date(Date.now() - (days - 1) * 86400000);
    onChange({ from: start, to: end });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 text-xs">
          <CalendarIcon className="h-3.5 w-3.5" />
          {sameDay ? fmt(range.from) : `${fmt(range.from)} - ${fmt(range.to)}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0 pointer-events-auto">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPreset(1)}>
              Hoje
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreset(7)}>
              7 dias
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreset(30)}>
              30 dias
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreset(90)}>
              90 dias
            </Button>
          </div>
        </div>
        <Calendar
          mode="range"
          selected={value}
          onSelect={(r) => {
            if (r?.from) {
              onChange({ from: r.from, to: r.to ?? r.from });
            }
          }}
          numberOfMonths={2}
          initialFocus
          className="pointer-events-auto"
        />
      </PopoverContent>
    </Popover>
  );
}

export function defaultTodayRange(): DashboardRange {
  const today = new Date();
  return { from: today, to: today };
}

/** Converte para YYYY-MM-DD em horário local (não UTC) para serializar na queryKey. */
export function rangeToKey(r: DashboardRange) {
  const k = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: k(r.from), to: k(r.to) };
}