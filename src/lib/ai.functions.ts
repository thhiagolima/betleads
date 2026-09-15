import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!;
  const key =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function buildContext(sb: ReturnType<typeof getSupabase>) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = today.toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [players, deps, withd, events] = await Promise.all([
    sb.from("players").select("*").limit(300),
    sb.from("deposits").select("*").gte("created_at", sevenDaysAgo).limit(500),
    sb.from("withdrawals").select("*").gte("created_at", sevenDaysAgo).limit(500),
    sb.from("events").select("*").gte("created_at", sevenDaysAgo).limit(500),
  ]);

  const compactPlayers = (players.data ?? []).map((p) => ({
    id: p.id,
    nome: p.nome,
    status: p.status,
    vip: p.vip,
    risco: p.risco,
    origem: p.origem,
    expert: p.expert,
    total_depositado: Number(p.total_depositado),
    total_sacado: Number(p.total_sacado),
    lucro: Number(p.total_depositado) - Number(p.total_sacado),
    ultimo_login: p.ultimo_login,
    ultimo_jogo: p.ultimo_jogo,
    ultimo_deposito: p.ultimo_deposito,
    ftd: !!p.ftd_em,
    tags: p.tags,
  }));

  return {
    hoje: iso,
    total_players: compactPlayers.length,
    players: compactPlayers,
    depositos_7d: deps.data ?? [],
    saques_7d: withd.data ?? [],
    eventos_7d: events.data ?? [],
  };
}

export const askAi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { pergunta: string }) =>
    z.object({ pergunta: z.string().min(1).max(500) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      return { resposta: "LOVABLE_API_KEY não configurada.", error: true };
    }
    // Use o client autenticado (RLS aplicada) — garante isolamento por tenant.
    const ctx = await buildContext(context.supabase as any);
    const gateway = createLovableAiGatewayProvider(apiKey);

    const system = `Você é a inteligência analítica da BETLEADS, plataforma de monitoramento de players de uma casa de aposta.
Responda em português brasileiro, de forma direta e prática.
Use markdown para organizar a resposta: títulos, listas e tabelas quando fizer sentido.
SEMPRE base sua resposta nos dados JSON fornecidos abaixo (não invente).
Quando listar players, mostre nome + métricas relevantes. Inclua valores em R$.
Se não houver dados suficientes, diga claramente.

DADOS (data de referência: ${ctx.hoje}):
${JSON.stringify(ctx).slice(0, 60000)}`;

    try {
      const { text } = await generateText({
        model: gateway("google/gemini-3-flash-preview"),
        system,
        prompt: data.pergunta,
      });

      // log
      await getSupabase().from("ai_logs").insert({
        pergunta: data.pergunta,
        resposta: text,
        modelo: "google/gemini-3-flash-preview",
      });

      return { resposta: text, error: false };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("429"))
        return { resposta: "Limite de uso atingido. Tente novamente em instantes.", error: true };
      if (msg.includes("402"))
        return {
          resposta: "Créditos de IA esgotados. Adicione créditos no workspace.",
          error: true,
        };
      return { resposta: `Erro ao consultar a IA: ${msg}`, error: true };
    }
  });
