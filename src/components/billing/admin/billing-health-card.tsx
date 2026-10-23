// PG6-03: "Saúde da cobrança" — current billing health findings (last 24 h)
// the "Testar alerta" button, and the charges waiting for review with the
// "Resolver" action (BillingReviewList). Super admin only (the admin page itself is
// gated, and both server functions re-check is_super_admin).
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, HeartPulse, RefreshCw, Siren, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adminBillingHealth, adminTestBillingAlert } from "@/lib/billing/billing-health.functions";

import { billingAlertTestMessage, billingHealthSummary } from "./billing-admin-ui";
import { BillingReviewList } from "./billing-review-list";

const BILLING_HEALTH_QUERY_KEY = ["admin", "billing", "health"];

type HealthReport = Awaited<ReturnType<typeof adminBillingHealth>>;

const TONE_CLASS = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  critical: "border-red-500/40 bg-red-500/10 text-red-300",
} as const;

export function BillingHealthCard() {
  const healthFn = useServerFn(adminBillingHealth);
  const testFn = useServerFn(adminTestBillingAlert);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: BILLING_HEALTH_QUERY_KEY,
    queryFn: () => healthFn() as Promise<HealthReport>,
  });
  const testMut = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (result) => toast.success(billingAlertTestMessage(result.channel)),
    onError: (error: Error) => toast.error(error.message),
  });

  const summary = data ? billingHealthSummary(data) : null;
  const SummaryIcon =
    summary?.tone === "critical"
      ? XCircle
      : summary?.tone === "warning"
        ? AlertTriangle
        : CheckCircle2;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-primary" />
            Saúde da cobrança
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Webhooks, cobranças pagas sem crédito, carteiras, Upper e crons (últimas 24 h).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className="h-4 w-4" />
            Atualizar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMut.mutate()}
            disabled={testMut.isPending}
          >
            <Siren className="h-4 w-4" />
            Testar alerta
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="h-12 animate-pulse rounded-md bg-muted" />
        ) : isError || !data || !summary ? (
          <p className="text-sm text-muted-foreground">Não foi possível verificar a saúde agora.</p>
        ) : (
          <>
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${TONE_CLASS[summary.tone]}`}
            >
              <SummaryIcon className="h-4 w-4 shrink-0" />
              {summary.title}
            </div>
            {data.findings.length > 0 && (
              <ul className="space-y-2">
                {data.findings.map((finding) => (
                  <li
                    key={finding.code}
                    className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-start sm:gap-3"
                  >
                    <Badge
                      variant={finding.severity === "critical" ? "destructive" : "secondary"}
                      className="w-fit shrink-0"
                    >
                      {finding.severity === "critical" ? "Crítico" : "Atenção"}
                    </Badge>
                    <div className="min-w-0">
                      <p>{finding.message}</p>
                      <p className="font-mono text-xs text-muted-foreground">{finding.code}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <BillingReviewList onResolved={() => void refetch()} />
            <p className="text-xs text-muted-foreground">
              Verificado em {new Date(data.checkedAt).toLocaleString("pt-BR")}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
