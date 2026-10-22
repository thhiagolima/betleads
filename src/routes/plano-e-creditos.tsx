import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CreditCard, FileText, History, Printer, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";

import { getSmsCreditPortal } from "@/lib/sms-credits.functions";
import { getInvoiceReceipt, getPlanOverview, payInvoice } from "@/lib/billing/billing.functions";
import { getTopupStatus } from "@/lib/billing/topup.functions";
import { invoicePaidSuccessText, planStatusBadge } from "@/lib/billing/billing-view";
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
import { PixPaymentDialog, type PixChargePayload } from "@/components/billing/pix-payment-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export const Route = createFileRoute("/plano-e-creditos")({
  component: PlanoECreditosPage,
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

type InvoiceDTO = {
  id: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountCents: number;
  discountCents: number;
  status: "open" | "paid" | "canceled";
  paidAt: string | null;
  paidVia: "pix" | "manual" | "full_discount" | null;
};

type PlanOverview = {
  state: string;
  plan: { name: string; priceCents: number; discountedCents: number; discountLabel: string | null } | null;
  exempt: boolean;
  currentPeriod: { start: string; end: string } | null;
  nextDueDate: string | null;
  openInvoice: InvoiceDTO | null;
  invoices: InvoiceDTO[];
  canPay: boolean;
  canBuyCredits: boolean;
};

function fmtDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function fmtDay(value: string | null) {
  if (!value) return "-";
  const [, m, d] = value.split("-");
  return `${d}/${m}`;
}

const INVOICE_STATUS_LABEL: Record<InvoiceDTO["status"], string> = {
  open: "Em aberto",
  paid: "Paga",
  canceled: "Cancelada",
};

const PAID_VIA_LABEL: Record<NonNullable<InvoiceDTO["paidVia"]>, string> = {
  pix: "Pix",
  manual: "Pagamento registrado pelo suporte",
  full_discount: "Desconto integral",
};

function invoiceStatusText(invoice: InvoiceDTO): string {
  if (invoice.status === "paid") return `Paga em ${fmtDay(invoice.paidAt?.slice(0, 10) ?? null)}`;
  return INVOICE_STATUS_LABEL[invoice.status];
}

function PlanoECreditosPage() {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const portalFn = useServerFn(getSmsCreditPortal);
  const planOverviewFn = useServerFn(getPlanOverview);
  const payInvoiceFn = useServerFn(payInvoice);
  const receiptFn = useServerFn(getInvoiceReceipt);
  const getStatusFn = useServerFn(getTopupStatus);

  // The house is chosen only in the header; this page follows it.
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;
  const [buyOpen, setBuyOpen] = useState(false);
  const [payCharge, setPayCharge] = useState<PixChargePayload | null>(null);
  const [paySuccessText, setPaySuccessText] = useState("Mensalidade paga.");
  const [receiptInvoiceId, setReceiptInvoiceId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sms-credits", "portal", tenantId],
    queryFn: () => portalFn({ data: { tenantId } }),
    enabled: !!tenantId,
  });

  const planOverview = useQuery({
    queryKey: ["plan-overview", tenantId],
    queryFn: () => planOverviewFn({ data: { tenantId } }) as Promise<PlanOverview>,
    enabled: !!tenantId,
  });

  const receipt = useQuery({
    queryKey: ["invoice-receipt", receiptInvoiceId],
    queryFn: () => receiptFn({ data: { tenantId, invoiceId: receiptInvoiceId! } }),
    enabled: !!receiptInvoiceId && !!tenantId,
  });

  const payMutation = useMutation({
    mutationFn: (invoiceId: string) => payInvoiceFn({ data: { tenantId, invoiceId } }),
    onSuccess: (result) => setPayCharge(result as PixChargePayload),
    onError: (error: Error) => toast.error(error.message),
  });

  const handleInvoicePaid = async () => {
    qc.invalidateQueries({ queryKey: ["current-tenant-access-status"] });
    // Documented choice (ruling 2): read the new next_due_date from
    // getPlanOverview after payment (a fresh fetch) rather than from the
    // status-poll result, so the success copy always matches the server's
    // own `billing_settle_invoice` rule for where the new cycle lands.
    const fresh = await qc.fetchQuery({
      queryKey: ["plan-overview", tenantId],
      queryFn: () => planOverviewFn({ data: { tenantId } }) as Promise<PlanOverview>,
    });
    qc.setQueryData(["plan-overview", tenantId], fresh);
    if (fresh.nextDueDate) {
      setPaySuccessText(invoicePaidSuccessText(fresh.nextDueDate));
    }
  };

  if (isLoading || tenant.isLoading || planOverview.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-36 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError || !data || planOverview.isError || !planOverview.data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Não foi possível carregar os dados de cobrança agora. Tente novamente em instantes.
        </CardContent>
      </Card>
    );
  }

  const overview = planOverview.data;
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

  const badge = planStatusBadge({
    state: overview.state as Parameters<typeof planStatusBadge>[0]["state"],
    today: new Date().toISOString().slice(0, 10),
    invoice: overview.openInvoice
      ? { amountCents: overview.openInvoice.amountCents, dueDate: overview.openInvoice.dueDate }
      : null,
    nextDueDate: overview.nextDueDate,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Plano e créditos</h2>
        <p className="text-sm text-muted-foreground">
          Mensalidade do plano, faturas, saldo de créditos e extrato de movimentações.
        </p>
      </div>

      {/* Bloco 1: Mensalidade */}
      <Card className="border-primary/30 bg-card/80">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="h-4 w-4 text-primary" />
            Mensalidade
            <Badge variant="outline">{badge}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {overview.exempt ? (
            <p className="text-sm text-muted-foreground">Plano interno — isento.</p>
          ) : (
            <>
              <div>
                <div className="text-xl font-semibold">
                  {overview.plan?.name ?? "Plano CRM"} —{" "}
                  {overview.plan && overview.plan.discountLabel ? (
                    <>
                      <span className="mr-2 text-muted-foreground line-through">
                        {brl(overview.plan.priceCents / 100)}
                      </span>
                      {brl(overview.plan.discountedCents / 100)}/mês
                    </>
                  ) : (
                    `${brl((overview.plan?.priceCents ?? 0) / 100)}/mês`
                  )}
                </div>
                {overview.currentPeriod && (
                  <p className="text-xs text-muted-foreground">
                    Período atual: {fmtDay(overview.currentPeriod.start)} a{" "}
                    {fmtDay(overview.currentPeriod.end)}
                  </p>
                )}
              </div>
              {overview.openInvoice && overview.canPay && (
                <Button
                  type="button"
                  size="sm"
                  disabled={payMutation.isPending}
                  onClick={() => overview.openInvoice && payMutation.mutate(overview.openInvoice.id)}
                >
                  <CreditCard className="mr-2 h-3.5 w-3.5" />
                  Pagar mensalidade (Pix)
                </Button>
              )}
              {overview.openInvoice && !overview.canPay && (
                <p className="text-xs text-muted-foreground">
                  Peça ao administrador da casa para pagar a mensalidade.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <PixPaymentDialog
        open={!!payCharge}
        onOpenChange={(next) => {
          if (!next) setPayCharge(null);
        }}
        charge={payCharge}
        onReset={() => setPayCharge(null)}
        getStatus={(chargeId) => getStatusFn({ data: { chargeId } })}
        statusQueryKey={["billing", "invoice-status", payCharge?.chargeId]}
        onPaid={handleInvoicePaid}
        successTitle="Mensalidade paga"
        successText={paySuccessText}
      />

      {/* Bloco 2: Saldo de uso */}
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
            <p className="mt-1 text-sm text-muted-foreground">
              disponível para consumo — créditos não expiram
            </p>
            {canBuy ? (
              <Button
                type="button"
                size="sm"
                className="mt-3"
                onClick={() => setBuyOpen(true)}
              >
                <CreditCard className="mr-2 h-3.5 w-3.5" />
                Comprar créditos (Pix)
              </Button>
            ) : (
              !overview.canBuyCredits && (
                <Button type="button" size="sm" className="mt-3" disabled>
                  Disponível depois de pagar a mensalidade
                </Button>
              )
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

      {/* Bloco 3: Faturas (ruling 6 — escondido quando não há nenhuma) */}
      {overview.invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              Faturas
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Período</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      {fmtDay(invoice.periodStart)} a {fmtDay(invoice.periodEnd)}
                    </TableCell>
                    <TableCell>{fmtDay(invoice.dueDate)}</TableCell>
                    <TableCell className="text-right">
                      {invoice.discountCents > 0 && (
                        <div className="text-xs text-muted-foreground line-through">
                          {brl((invoice.amountCents + invoice.discountCents) / 100)}
                        </div>
                      )}
                      {brl(invoice.amountCents / 100)}
                    </TableCell>
                    <TableCell>{invoiceStatusText(invoice)}</TableCell>
                    <TableCell className="text-right">
                      {invoice.status === "open" && overview.canPay && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={payMutation.isPending}
                          onClick={() => payMutation.mutate(invoice.id)}
                        >
                          Pagar
                        </Button>
                      )}
                      {invoice.status === "paid" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setReceiptInvoiceId(invoice.id)}
                        >
                          Comprovante
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!receiptInvoiceId}
        onOpenChange={(next) => {
          if (!next) setReceiptInvoiceId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Comprovante de pagamento</DialogTitle>
            <DialogDescription className="sr-only">
              Dados do pagamento da mensalidade: data, valor, descrição e identificador do Pix.
            </DialogDescription>
          </DialogHeader>
          {receipt.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : receipt.isError || !receipt.data ? (
            <p className="text-sm text-muted-foreground">Não foi possível carregar o comprovante.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">Descrição: </span>
                {receipt.data.description}
              </p>
              <p>
                <span className="text-muted-foreground">Data do pagamento: </span>
                {fmtDate(receipt.data.paidAt)}
              </p>
              <p>
                <span className="text-muted-foreground">Valor: </span>
                {brl(receipt.data.amountCents / 100)}
              </p>
              <p>
                <span className="text-muted-foreground">Forma de pagamento: </span>
                {receipt.data.paidVia ? PAID_VIA_LABEL[receipt.data.paidVia] : "-"}
              </p>
              {receipt.data.endToEndOrExternalId && (
                <p>
                  <span className="text-muted-foreground">Identificador do Pix: </span>
                  <span className="font-mono text-xs">{receipt.data.endToEndOrExternalId}</span>
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => window.print()}
              >
                <Printer className="mr-2 h-3.5 w-3.5" />
                Imprimir
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Bloco 4: Consumo do mês e extrato */}
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
