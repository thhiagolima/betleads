import { buildRecommendations, type Recommendation } from "@/lib/crm-recommendations";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Data } from "./format";

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

export function Recommendations({ data }: { data: Data }) {
  const items = buildRecommendations(data, data.holdout);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recomendações</CardTitle>
        <CardDescription>
          Regras aplicadas aos resultados do período, pelo Recuperado pelo CRM. Cada uma traz o
          número que a justifica; origens com menos de 5 jogadores convertidos não entram nas
          comparações.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nada a recomendar neste período: nenhuma origem gasta sem converter e não há dados
            suficientes para comparar eficiência.
          </p>
        ) : (
          <RecommendationList items={items} />
        )}
      </CardContent>
    </Card>
  );
}
