import { cn } from "@/lib/utils";

export type Priority = "Crítico" | "Alto" | "Médio" | "Baixo";

const styles: Record<Priority, { badge: string; border: string; dot: string }> = {
  "Crítico": {
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    border: "border-l-rose-500",
    dot: "bg-rose-400 shadow-[0_0_8px] shadow-rose-400/60",
  },
  "Alto": {
    badge: "bg-orange-500/15 text-orange-300 border-orange-500/40",
    border: "border-l-orange-500",
    dot: "bg-orange-400 shadow-[0_0_8px] shadow-orange-400/60",
  },
  "Médio": {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    border: "border-l-amber-500",
    dot: "bg-amber-400 shadow-[0_0_8px] shadow-amber-400/60",
  },
  "Baixo": {
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/40",
    border: "border-l-sky-500",
    dot: "bg-sky-400 shadow-[0_0_8px] shadow-sky-400/60",
  },
};

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const s = styles[priority];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        s.badge,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {priority}
    </span>
  );
}

export function priorityBorder(priority: Priority) {
  return styles[priority].border;
}