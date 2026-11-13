// Design section 6: "Também ficam aqui o cadastro da taxa do Pix (D11)..." — a new
// `payment_fee_settings` row (percent + fixed cents), super admin only.
//
// The fee is per gateway (`payment_fee_settings.provider`: Upper or SpacePay). The provider
// select starts on the gateway that new charges currently go to (`BILLING_PIX_PROVIDER`), and
// the fee in force for the selected gateway is shown above the inputs (`adminGetPixFees`).
import { useEffect, useId, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  adminGetPixFees,
  adminSetPixFee,
  type AdminPixFeesResult,
} from "@/lib/billing/billing-admin.functions";
import { canSubmitReason, validatePixFeeFixedCents, validatePixFeePercent } from "./billing-admin-ui";

type PixProvider = "upper" | "spacepay";

const PROVIDER_LABEL: Record<PixProvider, string> = {
  upper: "Upper",
  spacepay: "SpacePay",
};

const PIX_FEES_QUERY_KEY = ["admin", "billing", "pix-fees"];

export function PixFeeFormCard() {
  const [provider, setProvider] = useState<PixProvider | null>(null);
  const [feePercent, setFeePercent] = useState("0");
  const [feeFixedCents, setFeeFixedCents] = useState("0");
  const [reason, setReason] = useState("");
  const providerId = useId();
  const percentId = useId();
  const fixedId = useId();
  const reasonId = useId();
  const queryClient = useQueryClient();

  const getFees = useServerFn(adminGetPixFees);
  const feesQuery = useQuery({
    queryKey: PIX_FEES_QUERY_KEY,
    queryFn: () => getFees() as Promise<AdminPixFeesResult>,
  });

  // Default the select to the active gateway once it is known (never overrides a user choice).
  useEffect(() => {
    if (provider === null && feesQuery.data) setProvider(feesQuery.data.activeProvider);
  }, [provider, feesQuery.data]);

  const selected: PixProvider = provider ?? feesQuery.data?.activeProvider ?? "upper";
  const currentFee = feesQuery.data?.fees[selected] ?? null;

  const fn = useServerFn(adminSetPixFee);
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          provider: selected,
          feePercent: Number(feePercent),
          feeFixedCents: Math.round(Number(feeFixedCents)),
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      toast.success(`Taxa do Pix (${PROVIDER_LABEL[selected]}) cadastrada.`);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: PIX_FEES_QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const percentValidation = validatePixFeePercent(feePercent);
  const fixedValidation = validatePixFeeFixedCents(feeFixedCents);
  const valid = percentValidation.valid && fixedValidation.valid && canSubmitReason(reason);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Percent className="h-5 w-5 text-primary" />
          Taxa do Pix
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor={providerId}>Gateway</Label>
          <Select value={selected} onValueChange={(v) => setProvider(v as PixProvider)}>
            <SelectTrigger id={providerId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PROVIDER_LABEL) as PixProvider[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                  {feesQuery.data?.activeProvider === p ? " (ativo)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {feesQuery.isLoading
              ? "Carregando taxa atual…"
              : feesQuery.isError
                ? "Não foi possível carregar a taxa atual."
                : currentFee
                  ? `Taxa atual: ${currentFee.feePercent}% + ${currentFee.feeFixedCents} centavos.`
                  : "Nenhuma taxa cadastrada para este gateway."}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={percentId}>Percentual (%)</Label>
            <Input
              id={percentId}
              type="number"
              min={0}
              max={10}
              step="0.01"
              value={feePercent}
              onChange={(e) => setFeePercent(e.target.value)}
            />
            {!percentValidation.valid && (
              <p className="text-xs text-destructive">{percentValidation.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={fixedId}>Fixo (centavos)</Label>
            <Input
              id={fixedId}
              type="number"
              min={0}
              max={1000}
              step="1"
              value={feeFixedCents}
              onChange={(e) => setFeeFixedCents(e.target.value)}
            />
            {!fixedValidation.valid && (
              <p className="text-xs text-destructive">{fixedValidation.message}</p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={reasonId}>Motivo (obrigatório, mín. 5 caracteres)</Label>
          <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
        <Button type="button" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending ? "Salvando…" : "Salvar taxa"}
        </Button>
      </CardContent>
    </Card>
  );
}
