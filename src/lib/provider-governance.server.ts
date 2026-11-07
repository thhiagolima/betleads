import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Provider infrastructure is platform-owned. Keep this assertion next to every
 * server function that reads or mutates credentials, routes or callbacks.
 */
export async function assertSuperAdmin(userId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error("Não foi possível validar a permissão da plataforma.");
  if (!data) throw new Error("Acesso restrito à administração da plataforma.");
}

export type TenantChannelHealth = {
  available: boolean;
  canSend: boolean;
  lastUpdated: string;
  status: "available" | "attention" | "unavailable";
  /** Task 13: o canal usa a conta própria da casa (nunca o nome do
   * provedor) — a UI troca a mensagem genérica de indisponibilidade por uma
   * que aponta para Integrações -> Canais quando isto é true. */
  ownAccount: boolean;
};

/** Public-safe projection. Never add vendor names, endpoints or raw errors. */
export function tenantChannelHealth(available: boolean, ownAccount = false): TenantChannelHealth {
  return {
    available,
    canSend: available,
    lastUpdated: new Date().toISOString(),
    status: available ? "available" : "unavailable",
    ownAccount,
  };
}
