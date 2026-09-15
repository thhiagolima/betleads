import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Janela em dias que um lead "aguarda conversão" depois que o gerente manda
// mensagem. Depois disso ele sai da fila automaticamente.
const WINDOW_DAYS = 5;

// Ações de "outreach" — qualquer uma delas indica que o gerente fez contato e
// agora está aguardando o lead responder/converter.
const OUTREACH_ACOES = new Set([
  "whatsapp",
  "sms",
  "bonus",
  "gerente",
  "campanha",
  "acompanhamento",
  "copiar",
]);

// Resultados manuais que tiram o lead da fila.
const OUTCOME_ACOES = new Set(["convertido", "sem_resposta"]);

export type PendingConversionRow = {
  player_id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  alerta_tipo: string;
  sent_at: string; // timestamp do último outreach desse par (player, alerta_tipo)
  converted_auto: boolean; // true se já depositou depois do outreach
};

// Lista os leads que receberam mensagem nos últimos N dias e ainda não tiveram
// desfecho (convertido / sem_resposta) registrado manualmente. Quando o player
// faz um depósito aprovado depois do outreach, marca `converted_auto = true`
// para a UI dar destaque (e o gerente confirmar com 1 clique).
export const listPendingConversion = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: PendingConversionRow[] }> => {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
    const { data: fups, error } = await context.supabase
      .from("lead_followups")
      .select("player_id, alerta_tipo, acao, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    // Para cada par (player, alerta_tipo): guarda o último outreach + se já
    // teve outcome posterior.
    type Entry = { sent_at: string; has_outcome: boolean };
    const map = new Map<string, Entry>();
    for (const f of fups ?? []) {
      const key = `${f.player_id}:${f.alerta_tipo}`;
      const cur = map.get(key);
      if (OUTREACH_ACOES.has(f.acao as string)) {
        // novo outreach reseta o ciclo
        map.set(key, { sent_at: f.created_at, has_outcome: false });
      } else if (OUTCOME_ACOES.has(f.acao as string)) {
        if (cur) cur.has_outcome = true;
      }
    }

    const pending = Array.from(map.entries())
      .filter(([, v]) => !v.has_outcome)
      .map(([key, v]) => {
        const [player_id, alerta_tipo] = key.split(":");
        return { player_id, alerta_tipo, sent_at: v.sent_at };
      });

    if (pending.length === 0) return { rows: [] };

    const playerIds = Array.from(new Set(pending.map((p) => p.player_id)));

    const [playersRes, depsRes] = await Promise.all([
      context.supabase
        .from("players")
        .select("id, nome, telefone, email")
        .in("id", playerIds),
      context.supabase
        .from("deposits")
        .select("player_id, created_at")
        .in("player_id", playerIds)
        .eq("status", "aprovado")
        .gte("created_at", since),
    ]);
    if (playersRes.error) throw new Error(playersRes.error.message);
    if (depsRes.error) throw new Error(depsRes.error.message);

    const playerMap = new Map(
      (playersRes.data ?? []).map((p) => [p.id, p as { id: string; nome: string; telefone: string | null; email: string | null }]),
    );
    const depsByPlayer = new Map<string, string[]>();
    for (const d of depsRes.data ?? []) {
      if (!d.player_id) continue;
      const arr = depsByPlayer.get(d.player_id) ?? [];
      arr.push(d.created_at);
      depsByPlayer.set(d.player_id, arr);
    }

    const rows: PendingConversionRow[] = [];
    for (const p of pending) {
      const pl = playerMap.get(p.player_id);
      if (!pl) continue;
      const deps = depsByPlayer.get(p.player_id) ?? [];
      const converted_auto = deps.some((d) => d > p.sent_at);
      rows.push({
        player_id: p.player_id,
        nome: pl.nome,
        telefone: pl.telefone,
        email: pl.email,
        alerta_tipo: p.alerta_tipo,
        sent_at: p.sent_at,
        converted_auto,
      });
    }
    // Mais recentes primeiro.
    rows.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
    return { rows };
  });

// Conjunto de player_ids com followup pendente (sem outcome) por tipo.
// Usado pra esconder do chip de alerta correspondente quando a mensagem
// acabou de ser enviada.
export const listRecentFollowupKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ keys: string[] }> => {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
    const { data, error } = await context.supabase
      .from("lead_followups")
      .select("player_id, alerta_tipo, acao, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    type S = { has_outreach: boolean; has_outcome: boolean };
    const map = new Map<string, S>();
    for (const f of data ?? []) {
      const key = `${f.player_id}:${f.alerta_tipo}`;
      const cur = map.get(key) ?? { has_outreach: false, has_outcome: false };
      if (OUTREACH_ACOES.has(f.acao as string)) {
        cur.has_outreach = true;
        cur.has_outcome = false; // novo outreach reabre
      } else if (OUTCOME_ACOES.has(f.acao as string)) {
        cur.has_outcome = true;
      }
      map.set(key, cur);
    }
    const keys: string[] = [];
    for (const [k, v] of map) {
      if (v.has_outreach && !v.has_outcome) keys.push(k);
    }
    return { keys };
  });

export const markConversionOutcome = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { player_id: string; alerta_tipo: string; converted: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("lead_followups").insert({
      player_id: data.player_id,
      alerta_tipo: data.alerta_tipo,
      acao: data.converted ? "convertido" : "sem_resposta",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Janela em dias para visualizar leads que já tiveram desfecho marcado.
const OUTCOME_WINDOW_DAYS = 30;

export type OutcomeRow = {
  player_id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  alerta_tipo: string;
  outcome_at: string;
};

// Helper compartilhado: agrega o último `acao` por (player, alerta_tipo) nos
// últimos N dias e devolve apenas as entradas com `acao = target`.
async function listLeadsWithOutcome(
  supabase: any,
  target: "convertido" | "sem_resposta",
): Promise<{ rows: OutcomeRow[] }> {
  const since = new Date(Date.now() - OUTCOME_WINDOW_DAYS * 86400000).toISOString();
  const { data: fups, error } = await supabase
    .from("lead_followups")
    .select("player_id, alerta_tipo, acao, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  // Último estado por par (player, alerta_tipo).
  type Entry = { acao: string; at: string };
  const map = new Map<string, Entry>();
  for (const f of fups ?? []) {
    if (OUTREACH_ACOES.has(f.acao as string)) {
      // novo outreach reabre — invalida desfecho anterior
      map.set(`${f.player_id}:${f.alerta_tipo}`, { acao: "outreach", at: f.created_at });
    } else if (OUTCOME_ACOES.has(f.acao as string)) {
      map.set(`${f.player_id}:${f.alerta_tipo}`, { acao: f.acao as string, at: f.created_at });
    }
  }

  const matches = Array.from(map.entries())
    .filter(([, v]) => v.acao === target)
    .map(([key, v]) => {
      const [player_id, alerta_tipo] = key.split(":");
      return { player_id, alerta_tipo, outcome_at: v.at };
    });
  if (matches.length === 0) return { rows: [] };

  // Dedup por player_id: se o mesmo lead tem múltiplos alerta_tipo com o
  // mesmo desfecho, mantém só a entrada mais recente — evita duplicado
  // na aba Converteu / Não converteu quando o gerente marca um lead que
  // tinha mais de um alerta pendente.
  const byPlayer = new Map<string, { player_id: string; alerta_tipo: string; outcome_at: string }>();
  for (const m of matches) {
    const cur = byPlayer.get(m.player_id);
    if (!cur || cur.outcome_at < m.outcome_at) byPlayer.set(m.player_id, m);
  }
  const dedupedMatches = Array.from(byPlayer.values());
  const playerIds = Array.from(new Set(dedupedMatches.map((m) => m.player_id)));
  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, nome, telefone, email")
    .in("id", playerIds);
  if (pErr) throw new Error(pErr.message);
  type PInfo = { id: string; nome: string; telefone: string | null; email: string | null };
  const playerMap = new Map<string, PInfo>(
    (players ?? []).map((p: any) => [p.id as string, p as PInfo]),
  );

  const rows: OutcomeRow[] = [];
  for (const m of dedupedMatches) {
    const pl = playerMap.get(m.player_id);
    if (!pl) continue;
    rows.push({
      player_id: m.player_id,
      nome: pl.nome,
      telefone: pl.telefone,
      email: pl.email,
      alerta_tipo: m.alerta_tipo,
      outcome_at: m.outcome_at,
    });
  }
  rows.sort((a, b) => (a.outcome_at < b.outcome_at ? 1 : -1));
  return { rows };
}

export const listConvertedLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listLeadsWithOutcome(context.supabase, "convertido"));

export const listNotConvertedLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listLeadsWithOutcome(context.supabase, "sem_resposta"));