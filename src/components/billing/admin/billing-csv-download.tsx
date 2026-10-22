// Design section 6, item 12: monthly report (CSV), per house, with the formulas from
// controller ruling 5 (receita_bruta = mensalidade + consumo; receita_liquida = receita_bruta
// - custo_fornecedor - taxa_pix; margem = %).
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Download, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminBillingMonthlyCsv } from "@/lib/billing/billing-admin.functions";

function currentYyyyMm() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function downloadCsv(month: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cobranca-${month}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function BillingCsvDownloadCard() {
  const [month, setMonth] = useState(currentYyyyMm());
  const fn = useServerFn(adminBillingMonthlyCsv);
  const mut = useMutation({
    mutationFn: () => fn({ data: { month } }) as Promise<string>,
    onSuccess: (csv) => {
      downloadCsv(month, csv);
      toast.success("Relatório baixado.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-primary" />
          Relatório mensal (CSV)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Por casa: mensalidade paga, créditos comprados, consumo por canal, custo do
          fornecedor, taxa do Pix, receita líquida e margem. Casas isentas aparecem à parte, ao
          fim do arquivo.
        </p>
        <p className="text-xs text-muted-foreground">
          <strong>receita_bruta</strong> = mensalidade + consumo · <strong>receita_liquida</strong> =
          receita_bruta − custo_fornecedor − taxa_pix · <strong>margem</strong> = % (receita_liquida ÷
          receita_bruta)
        </p>
        <div className="flex items-end gap-2">
          <div className="space-y-2">
            <Label htmlFor="billing-csv-month">Mês</Label>
            <Input
              id="billing-csv-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
          <Button type="button" disabled={mut.isPending || !month} onClick={() => mut.mutate()}>
            <Download className="mr-2 h-4 w-4" />
            {mut.isPending ? "Gerando…" : "Baixar CSV"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
