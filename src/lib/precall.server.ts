// Helpers server-only do módulo Pré-ligação WhatsApp.
// Isolado: não toca em automation.server, flows, ligações.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AudienceResult = {
  player_id: string;
  telefone_e164: string;
};

/** Resolve a lista de leads que atendem ao filtro. */
export async function resolveAudience(
  tenantId: string,
  filtroId: string,
): Promise<AudienceResult[]> {
  if (filtroId === "vip_sem_login") {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    // (vip=true OR total_depositado>=1000) AND ultimo_login < 7d AND telefone IS NOT NULL
    const { data, error } = await supabaseAdmin
      .from("players")
      .select("id, telefone, vip, total_depositado, ultimo_login")
      .eq("tenant_id", tenantId)
      .or("vip.eq.true,total_depositado.gte.1000")
      .lt("ultimo_login", cutoff)
      .not("telefone", "is", null)
      .limit(5000);
    if (error) throw new Error(`resolveAudience: ${error.message}`);
    return (data ?? [])
      .filter((p) => typeof p.telefone === "string" && p.telefone.replace(/\D/g, "").length >= 8)
      .map((p) => ({ player_id: p.id, telefone_e164: p.telefone as string }));
  }
  throw new Error(`filtro desconhecido: ${filtroId}`);
}

export function randomDelaySeconds(min: number, max: number): number {
  const lo = Math.max(5, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}