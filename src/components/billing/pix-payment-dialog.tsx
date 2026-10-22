import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
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
import {
  shouldPollTopupStatus,
  topupView,
  type TopupStatusSnapshot,
} from "@/lib/billing/topup";
import { safeHttpsUrl, safePixImageSrc } from "@/lib/billing/pix-display";

/** The shape every Pix charge payload shares (credit top-up, invoice...). */
export type PixChargePayload = {
  chargeId: string;
  emv: string | null;
  qrCodeImage: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  amountCents: number;
};

function formatCountdown(seconds: number) {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Generic Pix payment dialog (Task 7, ruling 1): extracted from
 * `buy-credits-dialog.tsx` so a monthly-fee payment and a credit top-up
 * share one QR/Copia-e-Cola/countdown/poll/paid-review-expired
 * implementation. The caller owns creating the charge (package selection,
 * etc. — rendered as `children` while `charge` is still null) and owns the
 * status-poll function (`getStatus`) and the credited copy (`successTitle`/
 * `successText`). `onPaid` fires once, the instant `credited` turns true.
 */
export function PixPaymentDialog({
  open,
  onOpenChange,
  charge,
  getStatus,
  statusQueryKey,
  onReset,
  onPaid,
  successTitle = "Pagamento confirmado",
  successText,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the caller's own selection UI (`children`) is still showing. */
  charge: PixChargePayload | null;
  getStatus: (chargeId: string) => Promise<TopupStatusSnapshot>;
  /** React Query key for the status poll; must be stable/unique per caller. */
  statusQueryKey: unknown[];
  /** Clears `charge` on the caller's side (dialog close, or "Gerar outro"). */
  onReset: () => void;
  onPaid?: () => void;
  successTitle?: string;
  successText: string;
  /** The charge-creation UI (package picker, "Pagar mensalidade" button...), shown while `charge` is null. */
  children?: ReactNode;
}) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [localExpired, setLocalExpired] = useState(false);
  const [paidFired, setPaidFired] = useState(false);

  // Countdown to `expiresAt`, ticking every second. At 0 the dialog shows
  // "Este Pix expirou" even before the server confirms EXPIRED.
  useEffect(() => {
    setLocalExpired(false);
    setPaidFired(false);
    if (!charge?.expiresAt) {
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
        clearInterval(interval);
      }
    }
    tick();
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-key on chargeId, not the whole object
  }, [charge?.chargeId, charge?.expiresAt]);

  const status = useQuery({
    queryKey: statusQueryKey,
    queryFn: () => getStatus(charge!.chargeId),
    enabled: open && !!charge,
    refetchInterval: (query) => {
      const data = query.state.data as TopupStatusSnapshot | undefined;
      return shouldPollTopupStatus(data) ? 3000 : false;
    },
  });

  const statusData = status.data as TopupStatusSnapshot | undefined;
  const credited = statusData?.credited === true;
  const view = topupView({
    credited,
    needsReview: statusData?.needsReview === true,
    serverStatus: statusData?.status ?? null,
    localExpired,
  });

  useEffect(() => {
    if (credited && !paidFired) {
      setPaidFired(true);
      onPaid?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credited, paidFired]);

  const handleOpenChange = (next: boolean) => {
    if (!next) onReset();
    onOpenChange(next);
  };

  const copyPix = async () => {
    if (!charge?.emv) return;
    try {
      await navigator.clipboard.writeText(charge.emv);
      toast.success("Código Pix copiado");
    } catch {
      toast.error("Não foi possível copiar o código Pix");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {!charge ? (
          children
        ) : view === "credited" ? (
          <>
            <DialogHeader>
              <DialogTitle>{successTitle}</DialogTitle>
              <DialogDescription className="sr-only">{successText}</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{successText}</p>
            <Button type="button" className="w-full" onClick={() => handleOpenChange(false)}>
              Fechar
            </Button>
          </>
        ) : view === "review" ? (
          <>
            <DialogHeader>
              <DialogTitle>Pagamento em análise</DialogTitle>
              <DialogDescription className="sr-only">
                O pagamento precisa ser conferido pela equipe antes de ser confirmado.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Pagamento em análise. Fale com o suporte.
            </p>
            <Button type="button" className="w-full" onClick={() => handleOpenChange(false)}>
              Fechar
            </Button>
          </>
        ) : view === "paid_confirming" ? (
          <>
            <DialogHeader>
              <DialogTitle>Pagamento recebido</DialogTitle>
              <DialogDescription className="sr-only">
                O Pix foi pago; a confirmação acontece em instantes.
              </DialogDescription>
            </DialogHeader>
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              Pagamento recebido, confirmando…
            </p>
          </>
        ) : view === "expired" ? (
          <>
            <DialogHeader>
              <DialogTitle>Este Pix expirou</DialogTitle>
              <DialogDescription className="sr-only">
                O prazo para pagar este Pix acabou. Gere um novo código para continuar.
              </DialogDescription>
            </DialogHeader>
            <Button type="button" className="w-full" onClick={onReset}>
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
                    {brl(charge.amountCents / 100)}
                    {secondsLeft !== null && <> — expira em {formatCountdown(secondsLeft)}</>}
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
                {charge.emv && (
                  <div className="space-y-2">
                    <Label htmlFor="pix-payment-emv">Pix Copia e Cola</Label>
                    <div className="flex gap-2">
                      <Input
                        id="pix-payment-emv"
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
                )}
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
