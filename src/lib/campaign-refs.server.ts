// Validation of the optional references a campaign stores (short domain,
// e-mail sender). Shared by the SMS and e-mail campaign server functions.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * `short_domain_id` for a new campaign. The id must be a non-removed shortener
 * of this tenant (no cross-tenant reference is stored); verification is
 * checked again at send time by resolveShortenerDomain, which falls back to
 * the house default. Omitted when not chosen, so the insert keeps working on a
 * database without the column.
 */
export async function campaignShortDomainColumn(
  tenantId: string,
  shortDomainId: string | null | undefined,
): Promise<{ short_domain_id?: string }> {
  if (!shortDomainId) return {};
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id,removed_at")
    .eq("id", shortDomainId)
    .eq("tenant_id", tenantId)
    .eq("kind", "shortener")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.removed_at)
    throw new Error("Domínio do encurtador indisponível para esta conta");
  return { short_domain_id: shortDomainId };
}

/** Throws unless `senderId` is an `email_senders` row of this tenant. */
export async function assertTenantEmailSender(tenantId: string, senderId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("email_senders")
    .select("id")
    .eq("id", senderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Selecione um remetente de e-mail desta conta.");
}

/**
 * `sender_id` for an e-mail campaign: omitted when not provided (an update
 * keeps the stored value), null clears it, an id must belong to the tenant.
 * Domain verification is checked at send time by resolveSender.
 */
export async function campaignSenderColumn(
  tenantId: string,
  senderId: string | null | undefined,
): Promise<{ sender_id?: string | null }> {
  if (senderId === undefined) return {};
  if (senderId === null) return { sender_id: null };
  await assertTenantEmailSender(tenantId, senderId);
  return { sender_id: senderId };
}
