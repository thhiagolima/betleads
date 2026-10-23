import type { Recommendation } from "@/lib/crm-recommendations";
import { Badge } from "@/components/ui/badge";

const SEVERITY_STYLE = {
  acao: {
    label: "Ação",
    className: "border-danger/40 bg-danger/10 text-danger",
  },
  atencao: {
    label: "Atenção",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  oportunidade: {
    label: "Oportunidade",
    className: "border-success/40 bg-success/10 text-success",
  },
} as const;

export function RecommendationList({ items }: { items: Recommendation[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.title} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={SEVERITY_STYLE[item.severity].className}>
              {SEVERITY_STYLE[item.severity].label}
            </Badge>
            <span className="font-medium">{item.title}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}
