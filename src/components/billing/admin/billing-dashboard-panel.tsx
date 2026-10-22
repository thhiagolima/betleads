// Design section 6, item 9: "Receita mensal recorrente; recebido no mês; a receber nos
// próximos 5 dias; faturas vencidas; casas bloqueadas (por falta de pagamento e manualmente);
// pagamentos em revisão" — the 8 numbers from Task 8's `adminBillingDashboard`.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, Ban, Clock3, Lock, Snowflake, TrendingUp, Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adminBillingDashboard, type AdminBillingDashboard } from "@/lib/billing/billing-admin.functions";
import { adminBillingDashboardCards } from "./billing-admin-ui";

const ICON_BY_KEY: Record<string, typeof Wallet> = {
  mrr: TrendingUp,
  receivedThisMonth: Wallet,
  dueNext5Days: Clock3,
  overdueInvoices: AlertTriangle,
  lockedUnpaid: Lock,
  lockedManual: Ban,
  frozen: Snowflake,
  needsReview: Activity,
};

export function BillingDashboardPanel({ queryKey }: { queryKey: unknown[] }) {
  const fn = useServerFn(adminBillingDashboard);
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fn() as Promise<AdminBillingDashboard>,
  });

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Não foi possível carregar o painel agora.
        </CardContent>
      </Card>
    );
  }

  const cards = adminBillingDashboardCards(data);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = ICON_BY_KEY[card.key] ?? Wallet;
        return (
          <Card key={card.key}>
            <CardHeader className="pb-1">
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Icon className="h-4 w-4 text-primary" />
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight">{card.value}</div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
