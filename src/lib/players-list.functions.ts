import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  applyActiveWithin,
  applyInactiveAtLeast,
  applyInactivityWindow,
} from "./player-activity";

// Colunas usadas pela tabela /players. Mantenha em sincronia com o tipo Player no route.
const COLS =
  "id,nome,telefone,email,player_external_id,origem,expert,status,ultimo_login,ultimo_jogo,ultimo_deposito,total_depositado,total_sacado,saldo_carteira,saldo_bonus,tags,vip,risco,created_at,ftd_em,last_cashback_paid_at,last_cashback_amount,total_cashback_paid";

export type PlayerRow = {
  id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  player_external_id: string | null;
  origem: string | null;
  expert: string | null;
  status: string;
  ultimo_login: string | null;
  ultimo_jogo: string | null;
  ultimo_deposito: string | null;
  total_depositado: number;
  total_sacado: number;
  saldo_carteira: number;
  saldo_bonus: number;
  tags: string[];
  vip: boolean;
  risco: string;
  created_at: string;
  ftd_em: string | null;
  last_cashback_paid_at: string | null;
  last_cashback_amount: number | null;
  total_cashback_paid: number | null;
};

type Input = {
  page: number;
  pageSize: number;
  filter: string;
  search: string;
  sortKey:
    | "ultimo_login"
    | "ultimo_jogo"
    | "total_depositado"
    | "total_sacado"
    | "ultimo_deposito"
    | "saldo"
    | "lucro"
    | "status"
    | "origem"
    | null;
  sortDir: "asc" | "desc";
  // IDs pré-calculados (filtros de alerta vindos de outras server-fns).
  // Quando presente, a listagem é restrita a esse conjunto.
  idsIn?: string[] | null;
  // Filtro por intervalo de datas em coluna específica (created_at ou ftd_em).
  // dateFrom/dateTo são ISO em UTC (calculados no client a partir de BRT).
  dateField?: "created_at" | "ftd_em" | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

// PostgREST `or()` espera valores escapados: vírgulas/parênteses quebram a query.
function sanitizeSearch(s: string) {
  return s.replace(/[\\%,()*]/g, " ").trim();
}

const ISO = (d: number) => new Date(d).toISOString();

export const getPlayersPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Input) => data)
  .handler(async ({ data, context }): Promise<{ rows: PlayerRow[]; total: number }> => {
    const { page, pageSize, filter, search, sortKey, sortDir, idsIn, dateField, dateFrom, dateTo } = data;
    const supabase = context.supabase;

    // Helper para aplicar filtros de janela / regra no PostgREST builder.
    const now = Date.now();
    const daysAgo = (n: number) => ISO(now - n * 86400000);
    const todayStart = (() => {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      return t.toISOString();
    })();
    // Início do dia em BRT (America/Sao_Paulo) expresso em UTC.
    const todayStartBrt = (() => {
      const now = new Date();
      const brt = new Date(now.getTime() - 3 * 3600 * 1000);
      const y = brt.getUTCFullYear(), m = brt.getUTCMonth(), d = brt.getUTCDate();
      return new Date(Date.UTC(y, m, d) + 3 * 3600 * 1000).toISOString();
    })();

    // Para sort saldo/lucro precisamos calcular em JS (não há expressão arbitrária no .order()).
    const computeClient = sortKey === "saldo" || sortKey === "lucro";

    let q = supabase.from("players").select(COLS, { count: "exact" });

    // 1) Restrição por IDs (alerta) — vem primeiro pra cortar volume.
    if (idsIn) {
      if (idsIn.length === 0) return { rows: [], total: 0 };
      q = q.in("id", idsIn);
    }

    // 2) Busca textual.
    const s = sanitizeSearch(search);
    if (s) {
      const term = `%${s}%`;
      q = q.or(
        `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
      );
    }

    // 3) Filtros de janela / regra.
    switch (filter) {
      case "recorrentes":
        q = applyActiveWithin(q, daysAgo(4));
        break;
      case "ativo":
        q = q.not("ftd_em", "is", null);
        break;
      case "em_risco":
        q = applyInactiveAtLeast(q, daysAgo(7));
        break;
      case "risco_5_7":
        q = applyInactivityWindow(q, daysAgo(5), daysAgo(7));
        break;
      case "vip":
        q = q.or(`vip.eq.true,total_depositado.gte.1000`);
        break;
      case "vip_em_risco":
        q = applyInactiveAtLeast(
          q.or(`vip.eq.true,total_depositado.gte.1000`),
          daysAgo(7),
        );
        break;
      case "quase_vip":
        q = q.eq("vip", false).gte("total_depositado", 700).lt("total_depositado", 1000);
        break;
      case "leads_quentes":
        q = applyActiveWithin(q, daysAgo(4)).gte("ultimo_deposito", daysAgo(7));
        break;
      case "com_saldo":
        // saldo_carteira + saldo_bonus > 0 → usa OR sobre cada coluna positiva (próximo o suficiente, pega o relevante)
        q = applyActiveWithin(
          q.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`),
          daysAgo(60),
        );
        break;
      case "deposito_hoje":
        q = q.gte("ultimo_deposito", todayStart);
        break;
      case "ftd_hoje":
        q = q.gte("ftd_em", todayStartBrt);
        break;
      case "nao_converteram":
        q = q.is("ftd_em", null);
        break;
      case "risco_inicial":
        q = applyInactivityWindow(q, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null);
        break;
      case "risco_moderado":
        q = applyInactivityWindow(q, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null);
        break;
      case "risco_alto":
        q = applyInactivityWindow(q, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null);
        break;
      case "quase_perdido":
        q = applyInactivityWindow(q, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null);
        break;
      case "recuperacao_dificil":
        q = applyInactivityWindow(q, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null);
        break;
      case "perdidos":
        q = applyInactiveAtLeast(q, daysAgo(60)).not("ftd_em", "is", null);
        break;
      case "cashback_pago_hoje":
        q = q.gte("last_cashback_paid_at", todayStartBrt);
        break;
      // "todos" e quaisquer filtros desconhecidos não restringem nada.
      default:
        break;
    }

    // 4) Range de datas (independente dos chips).
    if (dateField && dateFrom && dateTo) {
      q = q.gte(dateField, dateFrom).lte(dateField, dateTo);
      if (dateField === "ftd_em") q = q.not("ftd_em", "is", null);
    }

    // Caminho rápido: ordenação em coluna direta + range no servidor.
    if (!computeClient) {
      const orderCol =
        sortKey === "ultimo_login" ? "ultimo_login"
        : sortKey === "ultimo_jogo" ? "ultimo_jogo"
        : sortKey === "total_depositado" ? "total_depositado"
        : sortKey === "total_sacado" ? "total_sacado"
        : sortKey === "ultimo_deposito" ? "ultimo_deposito"
        : sortKey === "status" ? "status"
        : sortKey === "origem" ? "origem"
        : "ultimo_login";
      const ascending = sortDir === "asc";
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data: rows, count, error } = await q
        .order(orderCol, { ascending, nullsFirst: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      return { rows: (rows ?? []) as unknown as PlayerRow[], total: count ?? 0 };
    }

    // Caminho com sort em saldo/lucro: traz todos os IDs do filtro (cols mínimas),
    // ordena em JS, fatia a página, e busca as linhas completas só dela.
    type Slim = {
      id: string;
      total_depositado: number;
      total_sacado: number;
      saldo_carteira: number;
      saldo_bonus: number;
    };
    // Reaproveita a mesma query, mas projeta só as colunas de cálculo.
    // (Refaz por simplicidade — PostgREST não permite trocar select depois.)
    let slim = supabase
      .from("players")
      .select("id,total_depositado,total_sacado,saldo_carteira,saldo_bonus", { count: "exact" });
    if (idsIn) slim = slim.in("id", idsIn);
    if (s) {
      const term = `%${s}%`;
      slim = slim.or(
        `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
      );
    }
    // duplica o switch acima — pequeno custo de manutenção em troca de simplicidade
    switch (filter) {
      case "recorrentes": slim = applyActiveWithin(slim, daysAgo(4)); break;
      case "ativo": slim = slim.not("ftd_em", "is", null); break;
      case "em_risco": slim = applyInactiveAtLeast(slim, daysAgo(7)); break;
      case "risco_5_7": slim = applyInactivityWindow(slim, daysAgo(5), daysAgo(7)); break;
      case "vip": slim = slim.or(`vip.eq.true,total_depositado.gte.1000`); break;
      case "vip_em_risco": slim = applyInactiveAtLeast(slim.or(`vip.eq.true,total_depositado.gte.1000`), daysAgo(7)); break;
      case "quase_vip": slim = slim.eq("vip", false).gte("total_depositado", 700).lt("total_depositado", 1000); break;
      case "leads_quentes": slim = applyActiveWithin(slim, daysAgo(4)).gte("ultimo_deposito", daysAgo(7)); break;
      case "com_saldo": slim = applyActiveWithin(slim.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`), daysAgo(60)); break;
      case "deposito_hoje": slim = slim.gte("ultimo_deposito", todayStart); break;
      case "ftd_hoje": slim = slim.gte("ftd_em", todayStartBrt); break;
      case "nao_converteram": slim = slim.is("ftd_em", null); break;
      case "risco_inicial": slim = applyInactivityWindow(slim, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null); break;
      case "risco_moderado": slim = applyInactivityWindow(slim, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null); break;
      case "risco_alto": slim = applyInactivityWindow(slim, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null); break;
      case "quase_perdido": slim = applyInactivityWindow(slim, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null); break;
      case "recuperacao_dificil": slim = applyInactivityWindow(slim, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null); break;
      case "perdidos": slim = applyInactiveAtLeast(slim, daysAgo(60)).not("ftd_em", "is", null); break;
      case "cashback_pago_hoje": slim = slim.gte("last_cashback_paid_at", todayStartBrt); break;
      default: break;
    }
    if (dateField && dateFrom && dateTo) {
      slim = slim.gte(dateField, dateFrom).lte(dateField, dateTo);
      if (dateField === "ftd_em") slim = slim.not("ftd_em", "is", null);
    }

    // Pagina até 20k pra cobrir tenants grandes; o conjunto vem só com 5 cols numéricas (≈ 60 bytes/linha).
    const PAGE = 1000;
    const all: Slim[] = [];
    let total = 0;
    for (let from = 0; ; from += PAGE) {
      const { data: chunk, count, error } = await slim.range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (chunk ?? []) as unknown as Slim[];
      all.push(...batch);
      if (count != null) total = count;
      if (batch.length < PAGE) break;
      if (all.length >= 20000) break;
    }
    const dir = sortDir === "asc" ? 1 : -1;
    all.sort((a, b) => {
      const va = sortKey === "saldo"
        ? Number(a.saldo_carteira ?? 0) + Number(a.saldo_bonus ?? 0)
        : Number(a.total_depositado ?? 0) - Number(a.total_sacado ?? 0);
      const vb = sortKey === "saldo"
        ? Number(b.saldo_carteira ?? 0) + Number(b.saldo_bonus ?? 0)
        : Number(b.total_depositado ?? 0) - Number(b.total_sacado ?? 0);
      return (va - vb) * dir;
    });
    const fromIdx = (page - 1) * pageSize;
    const pageIds = all.slice(fromIdx, fromIdx + pageSize).map((r) => r.id);
    if (pageIds.length === 0) return { rows: [], total: total || all.length };
    const { data: rows, error: rowsErr } = await supabase
      .from("players")
      .select(COLS)
      .in("id", pageIds);
    if (rowsErr) throw new Error(rowsErr.message);
    // re-ordena conforme pageIds
    const byId = new Map((rows ?? []).map((r) => [(r as { id: string }).id, r]));
    const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean) as unknown as PlayerRow[];
    return { rows: ordered, total: total || all.length };
  });

// Retorna TODOS os player_external_id que casam com o filtro+search+idsIn atuais.
// Usado pra "Copiar IDs do filtro" — não pagina e não traz colunas extras.
type IdsInput = {
  filter: string;
  search: string;
  idsIn?: string[] | null;
  dateField?: "created_at" | "ftd_em" | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export const getPlayersFilteredExternalIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: IdsInput) => data)
  .handler(async ({ data, context }): Promise<{ ids: string[]; missing: number; total: number }> => {
    const { filter, search, idsIn, dateField, dateFrom, dateTo } = data;
    const supabase = context.supabase;
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString();
    const todayStart = (() => {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      return t.toISOString();
    })();

    let q = supabase.from("players").select("player_external_id", { count: "exact" });
    const todayStartBrt = (() => {
      const now = new Date();
      const brt = new Date(now.getTime() - 3 * 3600 * 1000);
      const y = brt.getUTCFullYear(), m = brt.getUTCMonth(), d = brt.getUTCDate();
      return new Date(Date.UTC(y, m, d) + 3 * 3600 * 1000).toISOString();
    })();

    if (idsIn) {
      if (idsIn.length === 0) return { ids: [], missing: 0, total: 0 };
      q = q.in("id", idsIn);
    }

    const s = sanitizeSearch(search);
    if (s) {
      const term = `%${s}%`;
      q = q.or(
        `nome.ilike.${term},telefone.ilike.${term},email.ilike.${term},player_external_id.ilike.${term}`,
      );
    }

    switch (filter) {
      case "recorrentes": q = applyActiveWithin(q, daysAgo(4)); break;
      case "ativo": q = q.not("ftd_em", "is", null); break;
      case "em_risco": q = applyInactiveAtLeast(q, daysAgo(7)); break;
      case "risco_5_7": q = applyInactivityWindow(q, daysAgo(5), daysAgo(7)); break;
      case "vip": q = q.or(`vip.eq.true,total_depositado.gte.1000`); break;
      case "vip_em_risco": q = applyInactiveAtLeast(q.or(`vip.eq.true,total_depositado.gte.1000`), daysAgo(7)); break;
      case "quase_vip": q = q.eq("vip", false).gte("total_depositado", 700).lt("total_depositado", 1000); break;
      case "leads_quentes": q = applyActiveWithin(q, daysAgo(4)).gte("ultimo_deposito", daysAgo(7)); break;
      case "com_saldo": q = applyActiveWithin(q.or(`saldo_carteira.gt.0,saldo_bonus.gt.0`), daysAgo(60)); break;
      case "deposito_hoje": q = q.gte("ultimo_deposito", todayStart); break;
      case "ftd_hoje": q = q.gte("ftd_em", todayStartBrt); break;
      case "nao_converteram": q = q.is("ftd_em", null); break;
      case "risco_inicial": q = applyInactivityWindow(q, daysAgo(7), daysAgo(14)).not("ftd_em", "is", null); break;
      case "risco_moderado": q = applyInactivityWindow(q, daysAgo(15), daysAgo(24)).not("ftd_em", "is", null); break;
      case "risco_alto": q = applyInactivityWindow(q, daysAgo(25), daysAgo(34)).not("ftd_em", "is", null); break;
      case "quase_perdido": q = applyInactivityWindow(q, daysAgo(35), daysAgo(44)).not("ftd_em", "is", null); break;
      case "recuperacao_dificil": q = applyInactivityWindow(q, daysAgo(45), daysAgo(59)).not("ftd_em", "is", null); break;
      case "perdidos": q = applyInactiveAtLeast(q, daysAgo(60)).not("ftd_em", "is", null); break;
      case "cashback_pago_hoje": q = q.gte("last_cashback_paid_at", todayStartBrt); break;
      default: break;
    }

    if (dateField && dateFrom && dateTo) {
      q = q.gte(dateField, dateFrom).lte(dateField, dateTo);
      if (dateField === "ftd_em") q = q.not("ftd_em", "is", null);
    }

    const PAGE = 1000;
    const ids: string[] = [];
    let missing = 0;
    let total = 0;
    for (let from = 0; ; from += PAGE) {
      const { data: chunk, count, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (chunk ?? []) as Array<{ player_external_id: string | null }>;
      for (const row of batch) {
        const v = (row.player_external_id ?? "").trim();
        if (v) ids.push(v); else missing++;
      }
      if (count != null) total = count;
      if (batch.length < PAGE) break;
      if (ids.length + missing >= 50000) break;
    }
    // dedup, mantém ordem
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const id of ids) if (!seen.has(id)) { seen.add(id); dedup.push(id); }
    return { ids: dedup, missing, total: total || ids.length + missing };
  });