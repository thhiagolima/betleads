import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CreditCard, History, ShieldCheck, Wallet } from "lucide-react";

import { getSmsCreditPortal } from "@/lib/sms-credits.functions";
import { billingItemLabel, brl, ledgerAmountTone, num, walletEntryTypeLabel } from "@/lib/format";
import {
  type BillingItem,
  CurrentPricesCard,
  MonthUsageCard,
  type WalletMonthUsageRow,
  type WalletPriceRow,
} from "@/components/billing/wallet-usage-panels";
import { WalletBalanceNotice } from "@/components/billing/wallet-balance-notice";
import { BuyCreditsDialog } from "@/components/billing/buy-credits-dialog";
import { Button } from "@/components/ui/button";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/creditos-sms")({
  component: SaldoConsumoPage,
});

type LedgerRow = {
  id: string;
  entry_type: string;
  item: BillingItem | null;
  units: number | null;
  unit_price: number | null;
  amount: number;
  balance_after: number;
  reference_type: string | null;
  reason: string | null;
  created_at: string;
};

function fmtDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function SaldoConsumoPage() {
  const isDemo = useIsDemoTenant();
  const portalFn = useServerFn(getSmsCreditPortal);
  // The house is chosen only in the header; this page follows it.
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;
  const [buyOpen, setBuyOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sms-credits", "portal", tenantId],
    queryFn: () => portalFn({ data: { tenantId } }),
    enabled: !!tenantId,
  });

  if (isLoading || tenant.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-36 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Não foi possível carregar o saldo agora. Tente novamente em instantes.
        </CardContent>
      </Card>
    );
  }

  const summary = data.summary as {
    balance?: number;
    lifetime_purchased?: number;
    lifetime_used?: number;
    exempt?: boolean;
    month_usage?: WalletMonthUsageRow[];
    prices?: Partial<Record<BillingItem, WalletPriceRow>>;
  };
  const ledger = (data.ledger ?? []) as LedgerRow[];
  const balance = Number(summary.balance ?? 0);
  const prices = summary.prices ?? {};
  const monthUsage = summary.month_usage ?? [];
  const canBuy = Boolean((data as { canBuy?: boolean }).canBuy);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Saldo e consumo</h2>
          {summary.exempt && (
            <Badge className="bg-emerald-500/15 text-emerald-400">Isenta</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Saldo disponível, consumo do mês por canal e extrato de movimentações.
        </p>
      </div>

      <WalletBalanceNotice
        balance={balance}
        exempt={Boolean(summary.exempt)}
        smsUnitPrice={prices.sms?.unit_price == null ? null : Number(prices.sms.unit_price)}
        canBuy={canBuy}
      />

      <BuyCreditsDialog open={buyOpen} onOpenChange={setBuyOpen} tenantId={tenantId} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-primary/30 bg-card/80">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="h-4 w-4 text-primary" />
              Saldo atual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{brl(balance)}</div>
            <p className="mt-1 text-sm text-muted-foreground">disponível para consumo</p>
            {canBuy && (
              <Button
                type="button"
                size="sm"
                className="mt-3"
                onClick={() => setBuyOpen(true)}
              >
                <CreditCard className="mr-2 h-3.5 w-3.5" />
                Comprar créditos
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Comprado
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{brl(Number(summary.lifetime_purchased ?? 0))}</div>
            <p className="mt-1 text-sm text-muted-foreground">total histórico</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="h-4 w-4 text-primary" />
              Consumido
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{brl(Number(summary.lifetime_used ?? 0))}</div>
            <p className="mt-1 text-sm text-muted-foreground">desde o início</p>
          </CardContent>
        </Card>
      </div>

      <MonthUsageCard monthUsage={monthUsage} prices={prices} />

      <CurrentPricesCard prices={prices} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            Extrato
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead className="text-right">Unidades</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Saldo depois</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{fmtDate(entry.created_at)}</TableCell>
                  <TableCell>
                    <div className="font-medium">{walletEntryTypeLabel(entry.entry_type)}</div>
                    <div className="max-w-56 truncate text-xs text-muted-foreground">
                      {entry.reason ?? entry.reference_type ?? "-"}
                    </div>
                  </TableCell>
                  <TableCell>{billingItemLabel(entry.item)}</TableCell>
                  <TableCell className="text-right">
                    {entry.units == null ? "-" : num(Number(entry.units))}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${ledgerAmountTone(Number(entry.amount))}`}
                  >
                    {Number(entry.amount) > 0 ? "+" : ""}
                    {brl(Number(entry.amount))}
                  </TableCell>
                  <TableCell className="text-right">{brl(Number(entry.balance_after))}</TableCell>
                </TableRow>
              ))}
              {ledger.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    {isDemo ? DEMO_EMPTY_STATE_TEXT : "Nenhuma movimentação ainda."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
