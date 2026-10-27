import { Badge } from "@/components/ui/badge";
import type { StatusColor } from "@/lib/history.functions";

const CLASS: Record<StatusColor, string> = {
  green: "bg-success/15 text-success border border-success/30",
  yellow: "bg-warning/15 text-warning border border-warning/30",
  red: "bg-danger/15 text-danger border border-danger/30",
  blue: "bg-info/15 text-info border border-info/30",
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
    <Badge className={CLASS[color] + " text-meta font-medium"} title={title ?? undefined}>
      {label}
    </Badge>
  );
}
