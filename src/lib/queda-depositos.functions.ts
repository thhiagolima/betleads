import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Retorna os IDs dos players que disparam o gatilho "Queda de depósitos".
// Faz a agregação direto no Postgres pra ser determinístico e não depender
// do client baixar 20k+ depósitos.
export const getQuedaDepositosPlayerIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ids: string[] }> => {
    const now = Date.now();
    const iso7 = new Date(now - 7 * 86400000).toISOString();
    const iso14 = new Date(now - 14 * 86400000).toISOString();
    const iso30 = new Date(now - 30 * 86400000).toISOString();
    const iso60 = new Date(now - 60 * 86400000).toISOString();

    // Pega todos os depósitos aprovados dos últimos 60 dias e agrega em memória.
    // (sem RPC; mantém a leitura simples e respeita RLS)
    const PAGE = 1000;
    type Row = { player_id: string | null; valor: number | string | null; created_at: string };
    const all: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await context.supabase
        .from("deposits")
        .select("player_id,valor,created_at")
        .eq("status", "aprovado")
        .gte("created_at", iso60)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Row[];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }

    const dep7 = new Map<string, number>();
    const dep714 = new Map<string, number>();
    const dep30 = new Map<string, number>();
    const dep3060 = new Map<string, number>();
    for (const d of all) {
      if (!d.player_id) continue;
      const v = Number(d.valor ?? 0);
      if (!v) continue;
      const k = d.player_id;
      const c = d.created_at;
      if (c >= iso30) dep30.set(k, (dep30.get(k) ?? 0) + v);
      else dep3060.set(k, (dep3060.get(k) ?? 0) + v);
      if (c >= iso7) dep7.set(k, (dep7.get(k) ?? 0) + v);
      else if (c >= iso14) dep714.set(k, (dep714.get(k) ?? 0) + v);
    }

    const keys = new Set<string>([
      ...dep7.keys(),
      ...dep714.keys(),
      ...dep30.keys(),
      ...dep3060.keys(),
    ]);
    const ids: string[] = [];
    for (const k of keys) {
      const d30 = dep30.get(k) ?? 0;
      const d3060 = dep3060.get(k) ?? 0;
      const d7 = dep7.get(k) ?? 0;
      const d714 = dep714.get(k) ?? 0;
      // Regra A: queda 30d vs 30-60d (base ≥ R$ 200)
      const ruleA = d3060 >= 200 && d30 < d3060 * 0.5;
      // Regra B (fallback): queda 7d vs 7-14d (base ≥ R$ 100)
      const ruleB = !ruleA && d714 >= 100 && d7 < d714 * 0.5;
      if (ruleA || ruleB) ids.push(k);
    }
    return { ids };
  });