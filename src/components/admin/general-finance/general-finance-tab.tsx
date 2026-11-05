// Task 4 — super admin "Financeiro geral" tab: wires Task 3's
// `adminGeneralFinance` loader to the monthly cards, billing-state cards,
// debtors list, movements line and per-house table. No auto-refresh (the
// month picker is the only thing that changes the query key).
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, CircleAlert, Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { DataCard } from "@/components/ui-premium/data-card";
import { brl } from "@/lib/format";
import { formatCentsBRL } from "@/components/billing/admin/billing-admin-ui";
import { currentYyyyMmBrt, downloadCsv } from "@/components/billing/admin/billing-csv-download";
import { adminBillingMonthlyCsv } from "@/lib/billing/billing-admin.functions";
import { adminGeneralFinance } from "@/lib/billing/general-finance.functions";
import type { GeneralFinance } from "@/lib/billing/general-finance.server";
import { BUCKET_LABELS, type BillingBucket } from "@/lib/billing/billing-state-summary";

import { BillingStateCards } from "./billing-state-cards";
import { GeneralFinanceTable } from "./general-finance-table";

/** "2026-11" -> "2026-10" (delta = -1) or "2026-12" (delta = +1), across year boundaries. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function marginHint(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de margem`;
}

export function GeneralFinanceTab() {
  const [month, setMonth] = useState(currentYyyyMmBrt());
  const [selectedBucket, setSelectedBucket] = useState<BillingBucket | null>(null);

  const fn = useServerFn(adminGeneralFinance);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-general-finance", month],
    queryFn: () => fn({ data: { month } }),
  });

  const csvFn = useServerFn(adminBillingMonthlyCsv);
  const csvMut = useMutation({
    mutationFn: () => csvFn({ data: { month } }) as Promise<string>,
    onSuccess: (csv) => {
      downloadCsv(month, csv);
      toast.success("Relatório baixado.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function selectBucket(bucket: BillingBucket) {
    setSelectedBucket((current) => (current === bucket ? null : bucket));
  }

  const monthSelector = (
    <div className="flex flex-wrap items-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Mês anterior"
        onClick={() => setMonth((current) => shiftMonth(current, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="w-40"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Próximo mês"
        onClick={() => setMonth((current) => shiftMonth(current, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button type="button" disabled={csvMut.isPending} onClick={() => csvMut.mutate()}>
        <Download className="mr-2 h-4 w-4" />
        {csvMut.isPending ? "Gerando…" : "Baixar CSV"}
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {monthSelector}
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card/80" />
        <div className="h-28 animate-pulse rounded-2xl border border-border bg-card/80" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        {monthSelector}
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          Não foi possível carregar o financeiro geral.
        </div>
      </div>
    );
  }

  const finance = data as GeneralFinance;
  const { totals, states, houses } = finance;
  const consumoVendido = totals.consumoSms + totals.consumoVoz + totals.consumoEmail;
  const filteredHouses = selectedBucket
    ? houses.filter((h) => h.bucket === selectedBucket)
    : houses;
  const movementParts: string[] = [];
  if (states.movements.newPaying.length > 0) {
    movementParts.push(`Novas pagantes no mês: ${states.movements.newPaying.join(", ")}`);
  }
  if (states.movements.lost.length > 0) {
    movementParts.push(
      `Perdidas (bloqueadas/congeladas sem pagar): ${states.movements.lost.join(", ")}`,
    );
  }

  return (
    <div className="space-y-4">
      {isError && (
        <p className="flex items-center gap-2 text-xs text-warning" role="status">
          <CircleAlert className="size-3.5" />
          Falha ao atualizar — mostrando dados carregados anteriormente
        </p>
      )}
      {monthSelector}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Mensalidades recebidas" value={brl(totals.mensalidadeReais)} />
        <MetricCard label="Recargas recebidas" value={brl(totals.topupReais)} />
        <MetricCard label="Consumo vendido" value={brl(consumoVendido)} />
        <MetricCard
          label="Custo Short Brasil"
          value={brl(totals.shortBrasil.amount)}
          hint={
            totals.shortBrasil.missingCostUnits > 0
              ? `${totals.shortBrasil.missingCostUnits} unidades sem custo cadastrado`
              : undefined
          }
        />
        <MetricCard
          label="Custo Infobip"
          value={brl(totals.infobip.amount)}
          hint={
            totals.infobip.missingCostUnits > 0
              ? `${totals.infobip.missingCostUnits} unidades sem custo cadastrado`
              : undefined
          }
        />
        <MetricCard label="Taxa Pix" value={brl(totals.taxaPixReais)} />
        <MetricCard
          label="Margem"
          value={brl(totals.receitaLiquida)}
          hint={marginHint(totals.margemPct)}
        />
      </div>

      <BillingStateCards
        counts={states.counts}
        owedCents={states.owedCents}
        selectedBucket={selectedBucket}
        onSelectBucket={selectBucket}
      />

      <DataCard title="Quem está devendo">
        {states.debtors.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguém devendo.</p>
        ) : (
          <ul className="space-y-2">
            {states.debtors.map((debtor) => (
              <li
                key={debtor.tenantId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="font-medium">{debtor.name}</span>
                <span className="tabular-nums">{formatCentsBRL(debtor.amountCents)}</span>
                <span className="text-muted-foreground">
                  {debtor.daysOverdue != null
                    ? `${debtor.daysOverdue} dias de atraso`
                    : BUCKET_LABELS[debtor.bucket]}
                </span>
                <a href="/admin#faturamento" className="text-primary hover:underline">
                  Ver em Faturamento
                </a>
              </li>
            ))}
          </ul>
        )}
      </DataCard>

      {movementParts.length > 0 && (
        <p className="text-sm text-muted-foreground">{movementParts.join(" · ")}</p>
      )}

      <GeneralFinanceTable houses={filteredHouses} />

      <p className="text-xs text-muted-foreground">
        Custos de fornecedor estimados: unidades × tarifa cadastrada. SMS → Short Brasil; voz e
        e-mail → Infobip.
      </p>
    </div>
  );
}
