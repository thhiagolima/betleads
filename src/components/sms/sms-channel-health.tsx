import { Link } from "@tanstack/react-router";
import { CreditCard, RefreshCw } from "lucide-react";

import { MetricCard } from "@/components/ui-premium/metric-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type SmsHealthMetric = { label: string; value: string; hint: string };

export function SmsChannelHealth({
  configured,
  balance,
  queue,
  deliveryRate,
  metrics,
  onRefresh,
  onOpenHistory,
}: {
  configured: boolean;
  balance: string;
  queue: number;
  deliveryRate: number;
  metrics: SmsHealthMetric[];
  onRefresh: () => void;
  onOpenHistory: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge
            className={
              configured ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
            }
          >
            {configured ? "Canal ativo" : "Canal indisponível"}
          </Badge>
          <span className="text-sm text-muted-foreground">
            Status e desempenho do seu canal de SMS
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Atualizar
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/creditos-sms">
              <CreditCard className="mr-2 h-3.5 w-3.5" />
              {balance} créditos
            </Link>
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((item) => (
          <MetricCard
            key={item.label}
            label={item.label}
            value={item.value}
            hint={item.hint}
            className="py-3"
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
        <Card className="border-border/70 bg-card/70">
          <CardHeader>
            <CardTitle className="text-base">Saúde do canal</CardTitle>
            <CardDescription>
              Confira a disponibilidade e se as entregas seguem dentro do esperado.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <HealthValue
              label="Disponibilidade"
              value={configured ? "Disponível" : "Indisponível"}
            />
            <HealthValue label="Taxa de entrega" value={`${deliveryRate}%`} />
            <HealthValue label="Fila atual" value={`${queue} campanha${queue === 1 ? "" : "s"}`} />
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/70">
          <CardHeader>
            <CardTitle className="text-base">Ações de envio</CardTitle>
            <CardDescription>
              Crie ações no hub de campanhas e gerencie automações fora do canal.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/campanhas">Abrir campanhas</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/automacoes/sms">Gerenciar fluxos</Link>
            </Button>
            <Button variant="outline" onClick={onOpenHistory}>
              Ver histórico
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className="border-border/70 bg-card/70">
        <CardHeader>
          <CardTitle className="text-base">Relatório de SMS</CardTitle>
          <CardDescription>
            Consulte todos os envios, entregas, respostas e falhas em um único histórico.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onOpenHistory}>
            Abrir histórico completo
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function HealthValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
