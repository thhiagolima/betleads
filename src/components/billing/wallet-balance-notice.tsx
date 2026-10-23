import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WALLET_PAGE_LINK_LABEL, walletBalanceNotice } from "@/lib/billing/wallet-notice";
import { cn } from "@/lib/utils";

/** Empty/low balance warning for paying houses; renders nothing otherwise. */
export function WalletBalanceNotice({
  balance,
  exempt,
  smsUnitPrice,
  canBuy = false,
  threshold,
  className,
}: {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
  canBuy?: boolean;
  /** The house's low-balance threshold (`wallet_summary.low_balance_threshold`). */
  threshold?: number | null;
  className?: string;
}) {
  const notice = walletBalanceNotice({ balance, exempt, smsUnitPrice, canBuy, threshold });
  if (!notice) return null;
  return (
    <Alert
      className={cn(
        notice.kind === "empty"
          ? "border-red-500/40 bg-red-500/10 text-red-200 [&>svg]:text-red-400"
          : "border-amber-500/40 bg-amber-500/10 text-amber-100 [&>svg]:text-amber-400",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        {canBuy ? <TextWithWalletLink text={notice.text} /> : notice.text}
      </AlertDescription>
    </Alert>
  );
}

/** Renders `text` with its "Saldo e consumo" mention as a link to /plano-e-creditos. */
function TextWithWalletLink({ text }: { text: string }) {
  const index = text.lastIndexOf(WALLET_PAGE_LINK_LABEL);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <Link to="/plano-e-creditos" className="font-medium underline underline-offset-2">
        {WALLET_PAGE_LINK_LABEL}
      </Link>
      {text.slice(index + WALLET_PAGE_LINK_LABEL.length)}
    </>
  );
}
