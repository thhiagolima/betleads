import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brl } from "@/lib/format";
import { createCreditTopup, getTopupStatus } from "@/lib/billing/topup.functions";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, TOPUP_PACKAGES } from "@/lib/billing/topup";
import { safeHttpsUrl, safePixImageSrc } from "@/lib/billing/pix-display";

/** Statuses that stop the 3s poll (brief, ruling 2): credited, or any final Upper status. */
const FINAL_STATUSES = new Set(["EXPIRED", "CANCELLED", "FAILED"]);

type TopupResult = {
  orderId: string;
  chargeId: string;
  status: string;
  amountCents: number;
  emv: string;
  qrCodeImage: string;
  paymentUrl: string;
  expiresAt: string;
};

function formatCountdown(seconds: number) {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Buy-credits dialog for "Saldo e consumo" (brief, Task 6): package/free
 * amount selection, then the Pix QR/copy-paste with a countdown and a
 * 3s status poll. Only rendered when `canBuy` is true on the page.
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
  const [charge, setCharge] = useState<TopupResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [localExpired, setLocalExpired] = useState(false);

  const reset = () => {
    setFreeAmount("");
    setCharge(null);
    setSecondsLeft(null);
    setLocalExpired(false);
  };

  const create = useMutation({
    mutationFn: (input: { packageCode?: string; amountCents?: number }) =>
      createTopupFn({ data: { tenantId, ...input } }),
    onSuccess: (result) => {
      setCharge(result as TopupResult);
      setLocalExpired(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Countdown to `expiresAt`, ticking every second (ruling 3). At 0 the
  // dialog shows "Este Pix expirou" even before the server confirms EXPIRED.
  useEffect(() => {
    if (!charge) {
      setSecondsLeft(null);
      return;
    }
    const expiresAt = new Date(charge.expiresAt).getTime();
    const interval = setInterval(tick, 1000);
    function tick() {
      const remaining = Math.round((expiresAt - Date.now()) / 1000);
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        setLocalExpired(true);
        // Stop ticking once expired — nothing left to count down.
        clearInterval(interval);
      }
    }
    tick();
    return () => clearInterval(interval);
  }, [charge]);

  const status = useQuery({
    queryKey: ["sms-credits", "topup-status", charge?.chargeId],
    queryFn: () => getStatusFn({ data: { chargeId: charge!.chargeId } }),
    enabled: open && !!charge,
    refetchInterval: (query) => {
      const data = query.state.data as { status: string; credited: boolean } | undefined;
      if (!data) return 3000;
      if (data.credited || FINAL_STATUSES.has(data.status)) return false;
      return 3000;
    },
  });

  const credited = status.data?.credited === true;
  const serverStatus = status.data?.status ?? charge?.status ?? null;
  const expired = localExpired || (serverStatus != null && FINAL_STATUSES.has(serverStatus));

  useEffect(() => {
    if (credited) {
      qc.invalidateQueries({ queryKey: ["sms-credits"] });
    }
  }, [credited, qc]);

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const copyPix = async () => {
    if (!charge) return;
    try {
      await navigator.clipboard.writeText(charge.emv);
      toast.success("Código Pix copiado");
    } catch {
      toast.error("Não foi possível copiar o código Pix");
    }
  };

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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {!charge ? (
          <>
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
          </>
        ) : credited ? (
          <>
            <DialogHeader>
              <DialogTitle>Pagamento confirmado</DialogTitle>
              <DialogDescription className="sr-only">
                O pagamento por Pix foi confirmado e o saldo já foi atualizado.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Pagamento confirmado — {brl(charge.amountCents / 100)} adicionados ao saldo.
            </p>
            <Button type="button" className="w-full" onClick={() => handleOpenChange(false)}>
              Fechar
            </Button>
          </>
        ) : expired ? (
          <>
            <DialogHeader>
              <DialogTitle>Este Pix expirou</DialogTitle>
              <DialogDescription className="sr-only">
                O prazo para pagar este Pix acabou. Gere um novo código para continuar a compra.
              </DialogDescription>
            </DialogHeader>
            <Button type="button" className="w-full" onClick={reset}>
              Gerar outro
            </Button>
          </>
        ) : (
          (() => {
            const qrSrc = safePixImageSrc(charge.qrCodeImage);
            const paymentHref = safeHttpsUrl(charge.paymentUrl);
            return (
              <>
                <DialogHeader>
                  <DialogTitle>Pague com Pix</DialogTitle>
                  <DialogDescription>
                    {brl(charge.amountCents / 100)} — expira em{" "}
                    {formatCountdown(secondsLeft ?? 0)}
                  </DialogDescription>
                </DialogHeader>
                {qrSrc && (
                  <div className="flex justify-center">
                    <img
                      src={qrSrc}
                      alt="QR Code Pix"
                      className="h-48 w-48 rounded-md border bg-white p-2"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="buy-credits-emv">Pix Copia e Cola</Label>
                  <div className="flex gap-2">
                    <Input
                      id="buy-credits-emv"
                      readOnly
                      value={charge.emv}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Copiar código Pix"
                      onClick={copyPix}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {paymentHref && (
                  <a
                    href={paymentHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1 text-sm text-primary hover:underline"
                  >
                    Abrir página de pagamento <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </>
            );
          })()
        )}
      </DialogContent>
    </Dialog>
  );
}
