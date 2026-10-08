import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function checkContactFrequencyLimit(tenantId: string, playerId: string | null) {
  if (!playerId) return { allowed: true, retryAt: null, reason: null };
  const admin = supabaseAdmin as unknown as {
    rpc: (
      name: string,
      params: Record<string, string>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await admin.rpc("check_contact_frequency_limit", {
    p_tenant_id: tenantId,
    p_player_id: playerId,
  });
  if (error) throw new Error(`Não foi possível validar o limite de contato: ${error.message}`);
  const result = (Array.isArray(data) ? data[0] : undefined) as
    { allowed?: boolean; retry_at?: string | null; blocked_reason?: string | null } | undefined;
  return {
    allowed: result?.allowed !== false,
    retryAt: result?.retry_at ?? null,
    reason: result?.blocked_reason ?? null,
  };
}
