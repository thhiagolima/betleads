// Design section 6: "Também ficam aqui o cadastro da taxa do Pix (D11)..." — a new
// `payment_fee_settings` row (percent + fixed cents), super admin only.
import { useState } from "react";
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
import { canSubmitReason } from "./billing-admin-ui";

export function PixFeeFormCard() {
  const [feePercent, setFeePercent] = useState("0");
  const [feeFixedCents, setFeeFixedCents] = useState("0");
  const [reason, setReason] = useState("");
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

  const percentNumber = Number(feePercent);
  const fixedNumber = Number(feeFixedCents);
  const valid =
    Number.isFinite(percentNumber) &&
    percentNumber >= 0 &&
    percentNumber <= 10 &&
    Number.isFinite(fixedNumber) &&
    fixedNumber >= 0 &&
    fixedNumber <= 1000 &&
    canSubmitReason(reason);

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
            <Label>Percentual (%)</Label>
            <Input
              type="number"
              min={0}
              max={10}
              step="0.01"
              value={feePercent}
              onChange={(e) => setFeePercent(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Fixo (centavos)</Label>
            <Input
              type="number"
              min={0}
              max={1000}
              step="1"
              value={feeFixedCents}
              onChange={(e) => setFeeFixedCents(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Motivo (obrigatório, mín. 5 caracteres)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
        <Button type="button" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending ? "Salvando…" : "Salvar taxa"}
        </Button>
      </CardContent>
    </Card>
  );
}
