import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Calcula no Postgres quais players disparam cada gatilho de alerta
// (alto_potencial, player_reativado, sequencia_depositos, login_sem_deposito,
// frequencia_caindo). Logins vêm da tabela events (tipo='login') — a tabela
// sessions não é mais alimentada.
export const getAlertPlayerIdsByTipo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ byTipo: Record<string, string[]> }> => {
    const { data, error } = await context.supabase.rpc("get_players_alert_ids");
    if (error) throw new Error(error.message);
    const byTipo: Record<string, string[]> = {};
    for (const row of (data ?? []) as { tipo: string; player_id: string }[]) {
      (byTipo[row.tipo] ??= []).push(row.player_id);
    }
    return { byTipo };
  });