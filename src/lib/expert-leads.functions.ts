// Server functions da Área do Expert: home (resumo) e listagem de leads
// visíveis para o expert logado (Task 5 da Fase 1).
//
// Lê com `supabaseAdmin`: os experts não têm RLS sobre `players` (as policies
// *_expert_select foram removidas em 20261125100000_expert_hardening.sql para
// que o expert não leia CPF/e-mail/saldo direto pelo PostgREST). O recorte é
// feito aqui: sempre tenant do expert e, para o restrito, os affiliate_ids
// dele; e só as colunas de SELECT_COLS.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireExpertContext } from "@/lib/expert-access.server";
import { diasSemDepositar, type ExpertLeadRow } from "@/lib/expert-leads";
// Helper de escape já existente para `.or()` do PostgREST (vírgulas,
// parênteses, `%`, `_` e `*` quebram a expressão de ilike).
import { sanitizeRankingSearch } from "@/lib/gamification.functions";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null; count?: number | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string, options?: unknown) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
  or: (filters: string) => QueryBuilder<T>;
  order: (column: string, options?: unknown) => QueryBuilder<T>;
  range: (from: number, to: number) => Promise<DbResult<T>>;
};
type LooseDb = {
  from: <T = unknown>(table: string) => QueryBuilder<T>;
};

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

const db = () => supabaseAdmin as unknown as LooseDb;

const PAGE_SIZE = 50;
// Nunca inclui CPF, e-mail, saldos ou qualquer outro dado sensível além do
// necessário para a tela do expert.
const SELECT_COLS = "id,nome,telefone,total_depositado,ultimo_deposito,risco,vip";

type DbPlayerRow = {
  id: string;
  nome: string;
  telefone: string | null;
  total_depositado: number | null;
  ultimo_deposito: string | null;
  risco: string | null;
  vip: boolean | null;
};

function toExpertLeadRow(row: DbPlayerRow, now: Date): ExpertLeadRow {
  return {
    id: row.id,
    nome: row.nome,
    telefone: row.telefone,
    totalDepositado: Number(row.total_depositado ?? 0),
    ultimoDeposito: row.ultimo_deposito,
    diasSemDepositar: diasSemDepositar(row.ultimo_deposito, now),
    risco: row.risco ?? "",
    vip: row.vip === true,
  };
}

const listInput = z.object({
  search: z.string().max(80).optional(),
  page: z.number().int().min(0),
});

export const listExpertLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listInput.parse(data))
  .handler(async ({ data, context }) =>
    listExpertLeadsFor(context as unknown as ServerContext, data),
  );

/** Body of `listExpertLeads`, exported so it is directly unit-testable. */
export async function listExpertLeadsFor(
  ctx: ServerContext,
  data: { search?: string; page: number },
): Promise<{ rows: ExpertLeadRow[]; total: number }> {
  const expertCtx = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  // Restrito sem affiliate_id nenhum vinculado -> nada a ver, sem consultar.
  if (expertCtx.tipo === "restrito" && expertCtx.affiliateIds.length === 0) {
    return { rows: [], total: 0 };
  }

  let q: QueryBuilder<DbPlayerRow> = db()
    .from<DbPlayerRow>("players")
    .select(SELECT_COLS, { count: "exact" })
    .eq("tenant_id", expertCtx.tenantId);

  if (expertCtx.tipo === "restrito") {
    q = q.in("affiliate_id", expertCtx.affiliateIds);
  }

  const rawSearch = data.search ?? "";
  const term = sanitizeRankingSearch(rawSearch);
  if (term) {
    const like = `%${term}%`;
    const hasDigits = /\d/.test(rawSearch);
    q = hasDigits ? q.or(`nome.ilike.${like},telefone.ilike.${like}`) : q.or(`nome.ilike.${like}`);
  }

  const from = data.page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data: rows, count, error } = await q
    .order("total_depositado", { ascending: false })
    .range(from, to);
  if (error) throw new Error(error.message);

  const now = new Date();
  return {
    rows: ((rows ?? []) as DbPlayerRow[]).map((row) => toExpertLeadRow(row, now)),
    total: count ?? 0,
  };
}

export const getExpertHome = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getExpertHomeFor(context as unknown as ServerContext));

/** Body of `getExpertHome`, exported so it is directly unit-testable. */
export async function getExpertHomeFor(ctx: ServerContext) {
  const expertCtx = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  const base = {
    nome: expertCtx.nome,
    tipo: expertCtx.tipo,
    tenantNome: expertCtx.tenantNome,
  };

  if (expertCtx.tipo === "restrito" && expertCtx.affiliateIds.length === 0) {
    return { ...base, totalLeads: 0 };
  }

  let q: QueryBuilder<{ id: string }> = db()
    .from<{ id: string }>("players")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", expertCtx.tenantId);
  if (expertCtx.tipo === "restrito") {
    q = q.in("affiliate_id", expertCtx.affiliateIds);
  }

  const { count, error } = await q;
  if (error) throw new Error(error.message);

  return { ...base, totalLeads: count ?? 0 };
}
