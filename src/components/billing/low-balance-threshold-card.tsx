import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setLowBalanceThreshold } from "@/lib/billing/billing.functions";
import { effectiveLowBalanceThreshold, parseThresholdInput } from "@/lib/billing/wallet-notice";
import { brl } from "@/lib/format";

function thresholdInputText(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Low-balance threshold of the house (PG3 Task 8): below it the house sees
 * the low-balance banner and its admins/gestores get one e-mail a day.
 * Editable by the house payers (admin, owner, gestor) and the superadmin
 * (`canEdit`); read-only text for everyone else.
 */
export function LowBalanceThresholdCard({
  tenantId,
  threshold,
  canEdit,
}: {
  tenantId: string | null;
  threshold: number | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const setFn = useServerFn(setLowBalanceThreshold);
  const current = effectiveLowBalanceThreshold(threshold);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? thresholdInputText(current);
  const parsed = parseThresholdInput(text);

  const mutation = useMutation({
    mutationFn: (value: number) => setFn({ data: { tenantId, value } }),
    onSuccess: async () => {
      setDraft(null);
      toast.success("Limite de saldo baixo salvo.");
      await qc.invalidateQueries({ queryKey: ["sms-credits"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellRing className="h-4 w-4 text-primary" />
          Alerta de saldo baixo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {current > 0
            ? `Quando o saldo ficar abaixo de ${brl(current)}, mostramos um aviso e mandamos um e-mail por dia para os administradores e gestores da casa.`
            : "Alerta desligado: só avisamos quando o saldo acabar."}
        </p>
        {canEdit ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (parsed != null) mutation.mutate(parsed);
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="low-balance-threshold">Avisar abaixo de (R$)</Label>
              <Input
                id="low-balance-threshold"
                inputMode="decimal"
                className="w-40"
                value={text}
                onChange={(event) => setDraft(event.target.value)}
                aria-invalid={parsed == null}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={parsed == null || parsed === current || mutation.isPending}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Salvar
            </Button>
            {parsed == null && (
              <p className="w-full text-xs text-red-400">
                Informe um valor entre R$ 0 e R$ 100.000 (0 desliga o alerta).
              </p>
            )}
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
