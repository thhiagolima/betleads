import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** How long a recipient waits when the limit could not be verified. */
export const CONTACT_LIMIT_UNVERIFIED_RETRY_MS = 5 * 60_000;

export type ContactFrequencyDecision = {
  allowed: boolean;
  retryAt: string | null;
  reason: string | null;
};

/**
 * Global contact-frequency limit of the tenant for one player.
 * Fail-closed (QA-16): if the RPC errors or returns no decision, the contact
 * is NOT allowed and comes back later (`contact_limit_unverified`), the same
 * deferred path callers already use for a reached limit.
 */
export async function checkContactFrequencyLimit(
  tenantId: string,
  playerId: string | null,
): Promise<ContactFrequencyDecision> {
  if (!playerId) return { allowed: true, retryAt: null, reason: null };
  const admin = supabaseAdmin as unknown as {
    rpc: (
      name: string,
      params: Record<string, string>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const unverified = (detail: string): ContactFrequencyDecision => {
    console.warn("[contact-frequency] limit not verified; contact deferred", {
      tenantId,
      playerId,
      detail,
    });
    return {
      allowed: false,
      retryAt: new Date(Date.now() + CONTACT_LIMIT_UNVERIFIED_RETRY_MS).toISOString(),
      reason: "contact_limit_unverified",
    };
  };
  let response: Awaited<ReturnType<typeof admin.rpc>>;
  try {
    response = await admin.rpc("check_contact_frequency_limit", {
      p_tenant_id: tenantId,
      p_player_id: playerId,
    });
  } catch (error) {
    return unverified(error instanceof Error ? error.message : String(error));
  }
  if (response.error) return unverified(response.error.message);
  const result = (Array.isArray(response.data) ? response.data[0] : undefined) as
    | { allowed?: boolean; retry_at?: string | null; blocked_reason?: string | null }
    | undefined;
  if (!result || typeof result.allowed !== "boolean") return unverified("empty RPC result");
  return {
    allowed: result.allowed,
    retryAt: result.retry_at ?? null,
    reason: result.blocked_reason ?? null,
  };
}
