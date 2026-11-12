import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
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
import { Term } from "@/components/help/term";

/** The shape every Pix charge payload shares (credit top-up, invoice...). */
export type PixChargePayload = {
  chargeId: string;
  emv: string | null;
  qrCodeImage: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  amountCents: number;
  /**
   * Gateway status at creation time (e.g. "ACTIVE"). Optional — only the
   * credit top-up's `createCreditTopup` returns it today; `createInvoicePayment`
   * doesn't. Used only as a fallback before the first status poll resolves.
   */
  status?: string;
};

function formatCountdown(seconds: number) {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Whole seconds until `expiresAt` (negative once past), or null without a valid date. */
export function secondsUntil(expiresAt: string | null | undefined, nowMs = Date.now()) {
  if (!expiresAt) return null;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.round((at - nowMs) / 1000);
}

/**
 * Generic Pix payment dialog (Task 7, ruling 1): extracted from
 * `buy-credits-dialog.tsx` so a monthly-fee payment and a credit top-up
 * share one QR/Copia-e-Cola/countdown/poll/paid-review-expired
 * implementation. The caller owns creating the charge (package selection,
 * etc. — rendered as `children` while `charge` is still null) and owns the
 * status-poll function (`getStatus`) and the credited copy (`successTitle`/
 * `successText`). `onPaid` fires once, the instant `credited` turns true.
 *
 * Expiry: SpacePay QR codes may last only ~5 min (Upper's 1 h–7 d), so the
 * countdown ("Expira em 4:32") is always visible, and once it hits zero the
 * QR/Copia-e-Cola are hidden behind "Este Pix expirou" + "Gerar novo Pix",
 * which calls `onRegenerate` (the caller re-runs its own charge creation).
 * The status poll keeps running after local expiry, so a late PAID still
 * wins over the expired screen (`topupView` ranks PAID first).
 */
export function PixPaymentDialog({
  open,
  onOpenChange,
  charge,
  getStatus,
  statusQueryKey,
  onReset,
  onPaid,
  onRegenerate,
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
  /**
   * "Gerar novo Pix" on the expired screen: re-runs the same server call that
   * created this charge and must end with the caller setting the new `charge`.
   * Without it the button falls back to `onReset` (back to `children`).
   */
  onRegenerate?: () => Promise<unknown> | void;
  successTitle?: string;
  successText: string;
  /** The charge-creation UI (package picker, "Pagar mensalidade" button...), shown while `charge` is null. */
  children?: ReactNode;
}) {
  // Seeded from `expiresAt` so the first paint already shows the countdown
  // (or the expired screen) instead of waiting for the first tick.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(() =>
    secondsUntil(charge?.expiresAt),
  );
  const [localExpired, setLocalExpired] = useState(() => {
    const left = secondsUntil(charge?.expiresAt);
    return left !== null && left <= 0;
  });
  const [paidFired, setPaidFired] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Bumped on every regenerate so the countdown restarts even if the server
  // hands back the same charge (same id/expiresAt).
  const [regenNonce, setRegenNonce] = useState(0);

  // Countdown to `expiresAt`, ticking every second. At 0 the dialog shows
  // "Este Pix expirou" even before the server confirms EXPIRED.
  useEffect(() => {
    setLocalExpired(false);
    setPaidFired(false);
    if (secondsUntil(charge?.expiresAt) === null) {
      setSecondsLeft(null);
      return;
    }
    const interval = setInterval(tick, 1000);
    function tick() {
      const remaining = secondsUntil(charge?.expiresAt) ?? 0;
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        setLocalExpired(true);
        clearInterval(interval);
      }
    }
    tick();
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-key on chargeId, not the whole object
  }, [charge?.chargeId, charge?.expiresAt, regenNonce]);

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
    // Fix round 1: fall back to the just-created charge's own `status`
    // (ACTIVE) while the first status poll hasn't resolved yet — without
    // it, the very first render after a charge is created briefly treats
    // `serverStatus: null` as "not PAID, not final" (fine) but loses the
    // charge's initial status on any render in between the create
    // mutation settling and the first poll response landing.
    serverStatus: statusData?.status ?? charge?.status ?? null,
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

  const regenerate = async () => {
    if (!onRegenerate) {
      onReset();
      return;
    }
    setRegenerating(true);
    try {
      await onRegenerate();
      setRegenNonce((n) => n + 1);
    } catch {
      // The caller reports its own error (toast); stay on the expired screen.
    } finally {
      setRegenerating(false);
    }
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
              <DialogDescription>
                O prazo para pagar este Pix acabou. Não pague o código antigo — gere um novo para
                continuar ({brl(charge.amountCents / 100)}).
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              className="w-full"
              onClick={() => void regenerate()}
              disabled={regenerating}
            >
              {regenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Gerar novo Pix
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
                  <DialogDescription>{brl(charge.amountCents / 100)}</DialogDescription>
                </DialogHeader>
                {secondsLeft !== null && (
                  <p
                    className={`flex items-center justify-center gap-1.5 text-sm font-medium tabular-nums ${
                      secondsLeft <= 60 ? "text-amber-500" : "text-muted-foreground"
                    }`}
                    aria-live="off"
                    data-testid="pix-countdown"
                  >
                    <Clock className="h-4 w-4" />
                    Expira em {formatCountdown(secondsLeft)}
                  </p>
                )}
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
                    <Label htmlFor="pix-payment-emv">
                      <Term id="pix-copia-cola">Pix Copia e Cola</Term>
                    </Label>
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
