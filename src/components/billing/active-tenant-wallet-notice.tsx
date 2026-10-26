import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useActiveTenant } from "@/hooks/use-active-tenant";
import { walletNoticeInputFromPortal } from "@/lib/billing/wallet-notice";
import { getSmsCreditPortal } from "@/lib/sms-credits.functions";

import { WalletBalanceNotice } from "./wallet-balance-notice";

/**
 * Empty/low balance banner for the house chosen in the header, for pages
 * that do not already load the wallet (voice, e-mail). Shares the
 * `["sms-credits", "portal", tenantId]` query with /sms and
 * /plano-e-creditos, so it never adds a second fetch on those.
 */
export function ActiveTenantWalletNotice({ className }: { className?: string }) {
  const portalFn = useServerFn(getSmsCreditPortal);
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;
  const credits = useQuery({
    queryKey: ["sms-credits", "portal", tenantId],
    queryFn: () => portalFn({ data: { tenantId } }),
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });
  if (!credits.data) return null;
  return (
    <WalletBalanceNotice {...walletNoticeInputFromPortal(credits.data)} className={className} />
  );
}
