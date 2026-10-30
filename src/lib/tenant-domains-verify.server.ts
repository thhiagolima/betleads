// Periodic DNS verification job (Task 6): re-checks tenant_domains rows that
// are due for a check (per isDomainDueForCheck) by calling refreshTenantDomain.
// Demo tenants are excluded and removed domains are never selected. Exported
// as a plain function so the cron route can stay a thin auth+call wrapper and
// this loop can be unit-tested with mocks.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isDomainDueForCheck, type DomainKind, type DomainStatus } from "@/lib/house-config";
import { refreshTenantDomain } from "@/lib/tenant-domains.server";
import {
  DEFAULT_INFOBIP_ACCOUNT_ID,
  ProviderAccountUnavailableError,
  resolveInfobipAccount,
} from "@/lib/provider-accounts.server";

const MAX_DOMAINS_PER_RUN = 50;

type CandidateRow = {
  id: string;
  tenant_id: string;
  kind: DomainKind;
  status: DomainStatus;
  created_at: string;
  last_checked_at: string | null;
  provider_account_id: string | null;
};

/**
 * An e-mail domain registered in another Infobip account than the house's
 * current one is due now: refreshTenantDomain moves it to the current account.
 */
async function inOtherEmailAccount(row: CandidateRow): Promise<boolean> {
  if (row.kind !== "email") return false;
  try {
    const current = await resolveInfobipAccount(row.tenant_id, "email");
    return (row.provider_account_id ?? DEFAULT_INFOBIP_ACCOUNT_ID) !== current.id;
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return false;
    throw error;
  }
}

export type TenantDomainVerificationResult = {
  checked: number;
  verified: number;
  failed: number;
};

export async function runTenantDomainVerification(
  now: Date = new Date(),
): Promise<TenantDomainVerificationResult> {
  // `tenants.is_demo` is not in the generated Supabase types yet; follow the
  // established cast-to-any pattern (see tenant-access.server.ts).
  const { data, error } = await (supabaseAdmin as any)
    .from("tenant_domains")
    .select(
      "id,tenant_id,kind,status,created_at,last_checked_at,provider_account_id,tenants!inner(is_demo)",
    )
    .is("removed_at", null)
    .eq("tenants.is_demo", false)
    .order("last_checked_at", { ascending: true, nullsFirst: true });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as CandidateRow[];
  const due: CandidateRow[] = [];
  for (const row of rows) {
    if (due.length >= MAX_DOMAINS_PER_RUN) break;
    if (isDomainDueForCheck(row, now) || (await inOtherEmailAccount(row))) due.push(row);
  }

  let checked = 0;
  let verified = 0;
  let failed = 0;

  for (const row of due) {
    checked++;
    try {
      const requestVerify = row.kind === "email" && row.status !== "verified";
      const result = await refreshTenantDomain(row.id, { requestVerify });
      if (result.status === "verified") {
        verified++;
      } else if (result.status === "failed") {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { checked, verified, failed };
}
