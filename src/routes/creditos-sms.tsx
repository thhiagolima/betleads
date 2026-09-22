import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { CreditCard, History, Package, Plus, Receipt, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { createSmsCreditCheckout, getSmsCreditPortal } from "@/lib/sms-credits.functions";
import { brl, num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/creditos-sms")({
  component: SmsCreditsPage,
});

type PackageRow = {
  id: string;
  name: string;
  credits: number;
  bonus_credits: number;
  price_cents: number;
  currency: string;
};

type OrderRow = {
  id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  status: string;
  checkout_provider: string;
  external_reference: string;
  created_at: string;
  paid_at: string | null;
};

type LedgerRow = {
  id: string;
  delta_credits: number;
  balance_after: number;
  entry_type: string;
  reason: string | null;
  reference_type: string | null;
  created_at: string;
};

function cents(value: number) {
  return brl(value / 100);
}

function fmtDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function statusBadge(status: string) {
  if (status === "paid") return <Badge className="bg-emerald-500/15 text-emerald-400">pago</Badge>;
  if (status === "pending") return <Badge variant="secondary">pendente</Badge>;
  if (status === "failed") return <Badge variant="destructive">falhou</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function SmsCreditsPage() {
  const qc = useQueryClient();
  const portalFn = useServerFn(getSmsCreditPortal);
  const checkoutFn = useServerFn(createSmsCreditCheckout);
  const [customCredits, setCustomCredits] = useState("1000");

  const { data, isLoading } = useQuery({
    queryKey: ["sms-credits", "portal"],
    queryFn: () => portalFn({ data: {} }),
  });

  const checkout = useMutation({
    mutationFn: (payload: { packageId?: string; credits?: number }) =>
      checkoutFn({ data: payload }),
    onSuccess: (result) => {
      const orderId = String((result.checkout as Record<string, unknown>)?.order_id ?? "");
      toast.success(
        orderId ? `Pedido criado: ${orderId.slice(0, 8)}` : "Pedido de créditos criado",
      );
      qc.invalidateQueries({ queryKey: ["sms-credits"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-36 animate-pulse" />
        ))}
      </div>
    );
  }

  const summary = data.summary as {
    balance_credits?: number;
    lifetime_purchased_credits?: number;
    lifetime_used_credits?: number;
    pricing?: { sale_price_per_sms?: number; low_balance_threshold?: number };
  };
  const packages = data.packages as PackageRow[];
  const orders = data.orders as OrderRow[];
  const ledger = data.ledger as LedgerRow[];
  const balance = Number(summary.balance_credits ?? 0);
  const threshold = Number(summary.pricing?.low_balance_threshold ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Créditos SMS</h2>
        <p className="text-sm text-muted-foreground">
          Compre créditos, acompanhe pedidos e veja o extrato de consumo dos envios SMS.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-primary/30 bg-card/80">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4 text-primary" />
              Saldo atual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{num(balance)}</div>
            <p className="mt-1 text-sm text-muted-foreground">créditos disponíveis</p>
            {balance <= threshold && (
              <Badge className="mt-3 bg-amber-500/15 text-amber-400">saldo baixo</Badge>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <Package className="h-4 w-4 text-primary" />
              Preço atual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {brl(Number(summary.pricing?.sale_price_per_sms ?? 0))}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">por SMS enviado</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Uso histórico
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {num(Number(summary.lifetime_used_credits ?? 0))}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">créditos consumidos desde o início</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" />
              Pacotes
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {packages.map((pkg) => (
              <Card key={pkg.id} className="bg-background/40">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{pkg.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {num(pkg.credits + pkg.bonus_credits)} créditos
                      </p>
                    </div>
                    {pkg.bonus_credits > 0 && (
                      <Badge className="bg-emerald-500/15 text-emerald-400">
                        +{num(pkg.bonus_credits)}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-4 text-2xl font-bold">{cents(pkg.price_cents)}</p>
                  <Button
                    className="mt-4 w-full gap-2"
                    onClick={() => checkout.mutate({ packageId: pkg.id })}
                    disabled={checkout.isPending}
                  >
                    <Receipt className="h-4 w-4" />
                    Gerar pedido
                  </Button>
                </CardContent>
              </Card>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              Quantidade personalizada
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customCredits">Créditos</Label>
              <Input
                id="customCredits"
                type="number"
                min={1}
                step={100}
                value={customCredits}
                onChange={(e) => setCustomCredits(e.target.value)}
              />
            </div>
            <Button
              className="w-full"
              disabled={checkout.isPending || Number(customCredits) <= 0}
              onClick={() => checkout.mutate({ credits: Number(customCredits) })}
            >
              Gerar pedido manual
            </Button>
            <p className="text-xs text-muted-foreground">
              O pedido fica pendente até confirmação do pagamento pelo superadmin ou por webhook de
              pagamento futuro.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Pedidos recentes
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pedido</TableHead>
                <TableHead>Créditos</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">{order.id.slice(0, 8)}</TableCell>
                  <TableCell>{num(order.credits)}</TableCell>
                  <TableCell>{cents(order.amount_cents)}</TableCell>
                  <TableCell>{statusBadge(order.status)}</TableCell>
                  <TableCell>{fmtDate(order.created_at)}</TableCell>
                </TableRow>
              ))}
              {orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhum pedido criado ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
                <TableHead>Tipo</TableHead>
                <TableHead>Movimento</TableHead>
                <TableHead>Saldo após</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.entry_type}</TableCell>
                  <TableCell
                    className={entry.delta_credits > 0 ? "text-emerald-400" : "text-red-400"}
                  >
                    {entry.delta_credits > 0 ? "+" : ""}
                    {num(entry.delta_credits)}
                  </TableCell>
                  <TableCell>{num(entry.balance_after)}</TableCell>
                  <TableCell>{entry.reason ?? entry.reference_type ?? "-"}</TableCell>
                  <TableCell>{fmtDate(entry.created_at)}</TableCell>
                </TableRow>
              ))}
              {ledger.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhuma movimentação ainda.
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
