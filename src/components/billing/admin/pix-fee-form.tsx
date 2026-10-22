// Design section 6: "Também ficam aqui o cadastro da taxa do Pix (D11)..." — a new
// `payment_fee_settings` row (percent + fixed cents), super admin only.
//
// m4 (fix round 1): there is no existing read for `payment_fee_settings` (it's an
// `insert`-only, superadmin-only table — see the comment on `adminSetPixFeeFor` in
// billing-admin.functions.ts), so there's nothing to show as "the current fee" without adding
// server code just for that — out of scope for this fix round, per the ruling.
import { useId, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adminSetPixFee } from "@/lib/billing/billing-admin.functions";
import { canSubmitReason, validatePixFeeFixedCents, validatePixFeePercent } from "./billing-admin-ui";

export function PixFeeFormCard() {
  const [feePercent, setFeePercent] = useState("0");
  const [feeFixedCents, setFeeFixedCents] = useState("0");
  const [reason, setReason] = useState("");
  const percentId = useId();
  const fixedId = useId();
  const reasonId = useId();
  const fn = useServerFn(adminSetPixFee);
  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          feePercent: Number(feePercent),
          feeFixedCents: Math.round(Number(feeFixedCents)),
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      toast.success("Taxa do Pix cadastrada.");
      setReason("");
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
          Taxa do Pix (Upper)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
