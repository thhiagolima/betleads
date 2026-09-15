import { cn } from "@/lib/utils";

export type Status = "online" | "offline" | "pending" | "error" | "success" | "ai";

const styles: Record<Status, string> = {
  online: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  offline: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40",
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  ai: "bg-violet-500/15 text-violet-300 border-violet-500/40",
};

const dotStyles: Record<Status, string> = {
  online: "bg-emerald-400 pulse-realtime",
  offline: "bg-zinc-400",
  pending: "bg-amber-400",
  error: "bg-rose-400",
  success: "bg-emerald-400",
  ai: "bg-violet-400",
};

export function StatusBadge({
  status,
  label,
  className,
  showDot = true,
}: {
  status: Status;
  label: string;
  className?: string;
  showDot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        styles[status],
        className,
      )}
    >
      {showDot && <span className={cn("h-1.5 w-1.5 rounded-full", dotStyles[status])} />}
      {label}
    </span>
  );
}