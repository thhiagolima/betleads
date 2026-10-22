import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { walletBalanceNotice } from "@/lib/billing/wallet-notice";
import { cn } from "@/lib/utils";

/** Empty/low balance warning for paying houses; renders nothing otherwise. */
export function WalletBalanceNotice({
  balance,
  exempt,
  smsUnitPrice,
  className,
}: {
  balance: number;
  exempt: boolean;
  smsUnitPrice: number | null;
  className?: string;
}) {
  const notice = walletBalanceNotice({ balance, exempt, smsUnitPrice });
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
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  );
}
