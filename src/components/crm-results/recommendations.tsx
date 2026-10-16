import { buildRecommendations, type Recommendation } from "@/lib/crm-recommendations";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Data } from "./format";

const SEVERITY_STYLE = {
  acao: {
    label: "Ação",
    className: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  },
  atencao: {
    label: "Atenção",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  oportunidade: {
    label: "Oportunidade",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
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
        <CardTitle className="text-base">Recomendações</CardTitle>
        <CardDescription>
          Regras aplicadas aos resultados do período, pela conversão por clique. Cada uma traz o
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
