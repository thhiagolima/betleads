import { Badge } from "@/components/ui/badge";
import type { StatusColor } from "@/lib/history.functions";

const CLASS: Record<StatusColor, string> = {
  green: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  yellow: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  red: "bg-rose-500/15 text-rose-300 border border-rose-500/30",
  blue: "bg-sky-500/15 text-sky-300 border border-sky-500/30",
  gray: "bg-muted text-muted-foreground border border-border",
};

export function StatusBadge({
  color,
  label,
  title,
}: {
  color: StatusColor;
  label: string;
  title?: string | null;
}) {
  return (
    <Badge className={CLASS[color] + " text-[10px] font-medium"} title={title ?? undefined}>
      {label}
    </Badge>
  );
}