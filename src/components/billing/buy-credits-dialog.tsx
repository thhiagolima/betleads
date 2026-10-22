import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brl } from "@/lib/format";
import { createCreditTopup, getTopupStatus } from "@/lib/billing/topup.functions";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, TOPUP_PACKAGES } from "@/lib/billing/topup";
import { PixPaymentDialog, type PixChargePayload } from "./pix-payment-dialog";

/**
 * Buy-credits dialog for "Plano e créditos" (brief, Task 6/7): package/free
 * amount selection (this file), then the generic Pix QR/copy-paste/poll
 * screens from `PixPaymentDialog` (ruling 1). Only rendered when `canBuy` is
 * true on the page.
 */
export function BuyCreditsDialog({
  open,
  onOpenChange,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string | null;
}) {
  const qc = useQueryClient();
  const createTopupFn = useServerFn(createCreditTopup);
  const getStatusFn = useServerFn(getTopupStatus);

  const [freeAmount, setFreeAmount] = useState("");
  const [charge, setCharge] = useState<PixChargePayload | null>(null);

  const reset = () => {
    setFreeAmount("");
    setCharge(null);
  };

  const create = useMutation({
    mutationFn: (input: { packageCode?: string; amountCents?: number }) =>
      createTopupFn({ data: { tenantId, ...input } }),
    onSuccess: (result) => setCharge(result as PixChargePayload),
    onError: (error: Error) => toast.error(error.message),
  });

  const freeAmountCents = useMemo(() => {
    const normalized = freeAmount.replace(/\./g, "").replace(",", ".").trim();
    const value = Number(normalized);
    if (!normalized || !Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }, [freeAmount]);

  const freeAmountError = useMemo(() => {
    if (!freeAmount.trim()) return null;
    if (freeAmountCents === null) return "Valor inválido";
    if (freeAmountCents < MIN_TOPUP_CENTS) return "Valor mínimo de compra: R$ 100,00";
    if (freeAmountCents > MAX_TOPUP_CENTS) return "Valor máximo de compra: R$ 50.000,00";
    return null;
  }, [freeAmount, freeAmountCents]);

  const canSubmitFreeAmount = freeAmountCents !== null && freeAmountError === null;

  return (
    <PixPaymentDialog
      open={open}
      onOpenChange={onOpenChange}
      charge={charge}
      onReset={reset}
      getStatus={(chargeId) => getStatusFn({ data: { chargeId } })}
      statusQueryKey={["sms-credits", "topup-status", charge?.chargeId]}
      onPaid={() => qc.invalidateQueries({ queryKey: ["sms-credits"] })}
      successTitle="Pagamento confirmado"
      successText={
        charge ? `Pagamento confirmado — ${brl(charge.amountCents / 100)} adicionados ao saldo.` : ""
      }
    >
      <DialogHeader>
        <DialogTitle>Comprar créditos</DialogTitle>
        <DialogDescription>
          Escolha um pacote ou informe outro valor. O pagamento é por Pix.
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-2">
        {TOPUP_PACKAGES.map((pkg) => (
          <Button
            key={pkg.code}
            type="button"
            variant="outline"
            disabled={create.isPending}
            onClick={() => create.mutate({ packageCode: pkg.code })}
          >
            {brl(pkg.amountCents / 100)}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <Label htmlFor="buy-credits-free-amount">Outro valor (R$, mínimo 100)</Label>
        <Input
          id="buy-credits-free-amount"
          inputMode="decimal"
          placeholder="Ex.: 150,00"
          value={freeAmount}
          onChange={(event) => setFreeAmount(event.target.value)}
          disabled={create.isPending}
        />
        {freeAmountError && <p className="text-xs text-destructive">{freeAmountError}</p>}
      </div>
      <Button
        type="button"
        className="w-full"
        disabled={!canSubmitFreeAmount || create.isPending}
        onClick={() => {
          if (freeAmountCents === null) return;
          create.mutate({ amountCents: freeAmountCents });
        }}
      >
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Gerar Pix
      </Button>
    </PixPaymentDialog>
  );
}
