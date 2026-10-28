// Server functions de painel e ranking da Área do Expert (Fase 3, Task 3):
// dashboard do próprio expert, ranking e detalhe (admin), e a configuração
// da janela de clique. Consomem as funções SQL da Task 2
// (`expert_metrics`/`expert_metrics_daily`) e da Task 1
// (`expert_settings`/`refresh_expert_credits`), todas service_role, e ainda
// fora dos tipos gerados do Supabase → `(supabaseAdmin as any)`, como em
// `expert-access.server.ts`.
//
// Guards: `requireExpertContext` para o próprio expert (dashboard);
// `requireExpertAdminTenant` (exportado de `experts-admin.functions.ts`,
// mesma cadeia `resolveOperationalTenantForRequest` + `requireTenantAdmin`)
// para o admin (ranking, detalhe, config).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireExpertContext, type ExpertTipo } from "@/lib/expert-access.server";
import { DEFAULT_EXPERT_PERIOD, periodRange, type PeriodKey } from "@/lib/expert-period";
import {
  authUserOf,
  buildExpertAdminRow,
  countExpertLeads,
  expertAcesso,
  loadExpert,
  requireExpertAdminTenant,
  type ExpertAdminRow,
} from "@/lib/experts-admin.functions";
import { brtDayStart } from "@/lib/tz";
import { assertTenantNotDemo } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

type DbError = { message: string; code?: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type ServerContext = {
  userId: string;
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
  };
  activeTenantId?: string | null;
};

// As mesmas chaves de `PERIODS` (crm-results/search.ts via expert-period.ts),
// repetidas aqui como tupla porque o zod precisa de um literal, não de um
// array computado.
const PERIOD_KEYS: [PeriodKey, ...PeriodKey[]] = ["hoje", "ontem", "7", "30", "90"];
const periodKeySchema = z.enum(PERIOD_KEYS);

// Tabelas/RPCs do expert ainda fora dos tipos gerados (ver cabeçalho).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

export type ExpertMetrics = {
  expertId: string;
  depositado: number;
  depositadoClique: number;
  depositadoAfiliado: number;
  depositos: number;
  depositantes: number;
  reativacoes: number;
  ftds: number;
  links: number;
  cliques: number;
  contatos: number;
};

type MetricsDbRow = {
  expert_id: string;
  depositado: number | string;
  depositado_clique: number | string;
  depositado_afiliado: number | string;
  depositos: number;
  depositantes: number;
  reativacoes: number;
  ftds: number;
  links: number;
  cliques: number;
  contatos: number;
};

type DailyDbRow = {
  dia: string;
  depositado: number | string;
  depositado_clique: number | string;
  depositado_afiliado: number | string;
  cliques: number;
};

function zeroMetrics(expertId: string): ExpertMetrics {
  return {
    expertId,
    depositado: 0,
    depositadoClique: 0,
    depositadoAfiliado: 0,
    depositos: 0,
    depositantes: 0,
    reativacoes: 0,
    ftds: 0,
    links: 0,
    cliques: 0,
    contatos: 0,
  };
}

function mapMetricsRow(row: MetricsDbRow): ExpertMetrics {
  return {
    expertId: row.expert_id,
    depositado: Number(row.depositado),
    depositadoClique: Number(row.depositado_clique),
    depositadoAfiliado: Number(row.depositado_afiliado),
    depositos: Number(row.depositos),
    depositantes: Number(row.depositantes),
    reativacoes: Number(row.reativacoes),
    ftds: Number(row.ftds),
    links: Number(row.links),
    cliques: Number(row.cliques),
    contatos: Number(row.contatos),
  };
}

async function fetchExpertMetrics(tenantId: string, from: string, to: string) {
  const { data, error } = await db().rpc("expert_metrics", { _tenant: tenantId, _from: from, _to: to });
  if (error) throw new Error(error.message);
  return (data ?? []) as MetricsDbRow[];
}

async function fetchExpertMetricsDaily(
  tenantId: string,
  expertId: string,
  from: string,
  to: string,
) {
  const { data, error } = await db().rpc("expert_metrics_daily", {
    _tenant: tenantId,
    _expert_id: expertId,
    _from: from,
    _to: to,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as DailyDbRow[];
}

/** `expert_settings.click_window_hours` da casa, 72 (o default do SQL) se não configurada. */
async function getClickWindowHours(tenantId: string): Promise<number> {
  const { data, error } = await db()
    .from("expert_settings")
    .select("click_window_hours")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { click_window_hours?: number } | null)?.click_window_hours ?? 72;
}

// ---------------------------------------------------------- expert dashboard

const periodInput = z.object({ period: periodKeySchema.optional() });

export const getExpertDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => periodInput.parse(data ?? {}))
  .handler(async ({ data, context }) =>
    getExpertDashboardFor(context as unknown as ServerContext, data),
  );

export async function getExpertDashboardFor(
  ctx: ServerContext,
  data: z.input<typeof periodInput>,
): Promise<{
  metrics: ExpertMetrics;
  serie: { dia: string; depositado: number; cliques: number }[];
  janelaHoras: number;
}> {
  const input = periodInput.parse(data ?? {});
  const period = input.period ?? DEFAULT_EXPERT_PERIOD;
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const { from, to } = periodRange(period, new Date());

  const [rows, dailyRows, janelaHoras] = await Promise.all([
    fetchExpertMetrics(expert.tenantId, from, to),
    fetchExpertMetricsDaily(expert.tenantId, expert.expertId, from, to),
    getClickWindowHours(expert.tenantId),
  ]);

  const own = rows.find((r) => r.expert_id === expert.expertId);
  const metrics = own ? mapMetricsRow(own) : zeroMetrics(expert.expertId);
  const serie = dailyRows.map((r) => ({
    dia: r.dia,
    depositado: Number(r.depositado),
    cliques: Number(r.cliques),
  }));

  return { metrics, serie, janelaHoras };
}

// ---------------------------------------------------------- admin: ranking

export const listExpertsRanking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => periodInput.parse(data ?? {}))
  .handler(async ({ data, context }) =>
    listExpertsRankingFor(context as unknown as ServerContext, data),
  );

export async function listExpertsRankingFor(
  ctx: ServerContext,
  data: z.input<typeof periodInput>,
): Promise<{
  rows: (ExpertMetrics & { nome: string; tipo: ExpertTipo; ativo: boolean })[];
  janelaHoras: number;
}> {
  const input = periodInput.parse(data ?? {});
  const period = input.period ?? DEFAULT_EXPERT_PERIOD;
  const tenantId = await requireExpertAdminTenant(ctx);
  const { from, to } = periodRange(period, new Date());

  const [{ data: expertsRows, error: expertsErr }, metricsRows, janelaHoras] = await Promise.all([
    db().from("experts").select("id,nome,tipo,ativo").eq("tenant_id", tenantId),
    fetchExpertMetrics(tenantId, from, to),
    getClickWindowHours(tenantId),
  ]);
  if (expertsErr) throw new Error(expertsErr.message);

  const metricsByExpert = new Map(metricsRows.map((r) => [r.expert_id, mapMetricsRow(r)]));

  const rows = (
    (expertsRows ?? []) as Array<{ id: string; nome: string; tipo: ExpertTipo; ativo: boolean }>
  )
    .map((e) => ({
      ...(metricsByExpert.get(e.id) ?? zeroMetrics(e.id)),
      nome: e.nome,
      tipo: e.tipo,
      ativo: e.ativo,
    }))
    .sort((a, b) => b.depositado - a.depositado);

  return { rows, janelaHoras };
}

// ---------------------------------------------------------- admin: detail

async function loadExpertAdminRow(tenantId: string, expertId: string): Promise<ExpertAdminRow> {
  const row = await loadExpert(tenantId, expertId);

  const { data: affRows, error: affErr } = await db()
    .from("expert_affiliates")
    .select("affiliate_id")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId);
  if (affErr) throw new Error(affErr.message);
  const affiliateIds = ((affRows ?? []) as Array<{ affiliate_id: string }>)
    .map((r) => r.affiliate_id)
    .sort();

  const [leads, user] = await Promise.all([
    countExpertLeads(tenantId, row.tipo, affiliateIds),
    authUserOf(row.user_id),
  ]);

  return buildExpertAdminRow(row, {
    affiliateIds,
    leads,
    acesso: expertAcesso(row, user?.last_sign_in_at),
    email: user?.email ?? null,
  });
}

async function namesByPlayerId(tenantId: string, playerIds: string[]): Promise<Map<string, string>> {
  if (playerIds.length === 0) return new Map();
  const { data, error } = await db()
    .from("players")
    .select("id,nome")
    .eq("tenant_id", tenantId)
    .in("id", playerIds);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; nome: string }>).map((p) => [p.id, p.nome]));
}

type ExpertLinkRow = {
  id: string;
  oferta: string;
  leadNome: string;
  createdAt: string;
  clicado: boolean;
};

async function loadExpertLinks(tenantId: string, expertId: string): Promise<ExpertLinkRow[]> {
  const { data, error } = await db()
    .from("expert_links")
    .select("id,oferta,player_id,link_dispatch_id,created_at")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    oferta: string;
    player_id: string;
    link_dispatch_id: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return [];

  const dispatchIds = Array.from(
    new Set(rows.map((r) => r.link_dispatch_id).filter((id): id is string => Boolean(id))),
  );
  const [nomeById, { data: dispatches, error: dispatchesErr }] = await Promise.all([
    namesByPlayerId(tenantId, rows.map((r) => r.player_id)),
    dispatchIds.length > 0
      ? db().from("link_dispatches").select("id,first_party_first_clicked_at").in("id", dispatchIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (dispatchesErr) throw new Error(dispatchesErr.message);

  const clickedById = new Map(
    ((dispatches ?? []) as Array<{ id: string; first_party_first_clicked_at: string | null }>).map(
      (d) => [d.id, d.first_party_first_clicked_at != null],
    ),
  );

  return rows.map((r) => ({
    id: r.id,
    oferta: r.oferta,
    leadNome: nomeById.get(r.player_id) ?? "",
    createdAt: r.created_at,
    clicado: r.link_dispatch_id ? (clickedById.get(r.link_dispatch_id) ?? false) : false,
  }));
}

type ExpertContactRow = { leadNome: string; resultado: string; createdAt: string };

async function loadExpertContacts(tenantId: string, expertId: string): Promise<ExpertContactRow[]> {
  const { data, error } = await db()
    .from("expert_lead_contacts")
    .select("resultado,player_id,created_at")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ resultado: string; player_id: string; created_at: string }>;
  if (rows.length === 0) return [];

  const nomeById = await namesByPlayerId(tenantId, rows.map((r) => r.player_id));
  return rows.map((r) => ({
    leadNome: nomeById.get(r.player_id) ?? "",
    resultado: r.resultado,
    createdAt: r.created_at,
  }));
}

type ExpertClaimRow = { leadNome: string; expiresAt: string };

async function loadActiveClaims(tenantId: string, expertId: string): Promise<ExpertClaimRow[]> {
  const { data, error } = await db()
    .from("expert_lead_claims")
    .select("player_id,expires_at")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .gt("expires_at", new Date().toISOString());
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ player_id: string; expires_at: string }>;
  if (rows.length === 0) return [];

  const nomeById = await namesByPlayerId(tenantId, rows.map((r) => r.player_id));
  return rows.map((r) => ({
    leadNome: nomeById.get(r.player_id) ?? "",
    expiresAt: r.expires_at,
  }));
}

const expertDetailInput = z.object({ expertId: dbUuid(), period: periodKeySchema.optional() });

export const getExpertDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => expertDetailInput.parse(data))
  .handler(async ({ data, context }) =>
    getExpertDetailFor(context as unknown as ServerContext, data),
  );

export async function getExpertDetailFor(
  ctx: ServerContext,
  data: z.input<typeof expertDetailInput>,
): Promise<{
  expert: ExpertAdminRow;
  metrics: ExpertMetrics;
  serie: {
    dia: string;
    depositado: number;
    depositadoClique: number;
    depositadoAfiliado: number;
    cliques: number;
  }[];
  links: ExpertLinkRow[];
  contatos: ExpertContactRow[];
  assumidos: ExpertClaimRow[];
}> {
  const input = expertDetailInput.parse(data);
  const period = input.period ?? DEFAULT_EXPERT_PERIOD;
  const tenantId = await requireExpertAdminTenant(ctx);

  // `loadExpert` (via `loadExpertAdminRow`) já filtra por tenant_id: um
  // expert de outra casa cai no mesmo "Expert não encontrado." do admin de
  // experts, sem checagem extra aqui.
  const expert = await loadExpertAdminRow(tenantId, input.expertId);
  const { from, to } = periodRange(period, new Date());

  const [metricsRows, dailyRows, links, contatos, assumidos] = await Promise.all([
    fetchExpertMetrics(tenantId, from, to),
    fetchExpertMetricsDaily(tenantId, input.expertId, from, to),
    loadExpertLinks(tenantId, input.expertId),
    loadExpertContacts(tenantId, input.expertId),
    loadActiveClaims(tenantId, input.expertId),
  ]);

  const metricsRow = metricsRows.find((r) => r.expert_id === input.expertId);
  const metrics = metricsRow ? mapMetricsRow(metricsRow) : zeroMetrics(input.expertId);
  const serie = dailyRows.map((r) => ({
    dia: r.dia,
    depositado: Number(r.depositado),
    depositadoClique: Number(r.depositado_clique),
    depositadoAfiliado: Number(r.depositado_afiliado),
    cliques: Number(r.cliques),
  }));

  return { expert, metrics, serie, links, contatos, assumidos };
}

// ---------------------------------------------------------- admin: settings

const RECENT_REFRESH_DAYS = 8;

/**
 * Faixa dos últimos `RECENT_REFRESH_DAYS` dias (São Paulo), o mesmo cálculo
 * de `refresh_expert_credits_recent(8)` (migration 20261103100000) — mas
 * disparada aqui para uma casa só, via `refresh_expert_credits`.
 */
function recentRefreshRange(now: Date): { from: string; to: string } {
  const todayStart = brtDayStart(now);
  const from = new Date(todayStart.getTime() - RECENT_REFRESH_DAYS * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

const saveSettingsInput = z.object({ clickWindowHours: z.number().int().min(1).max(720) });

export const saveExpertSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => saveSettingsInput.parse(data))
  .handler(async ({ data, context }) =>
    saveExpertSettingsFor(context as unknown as ServerContext, data),
  );

export async function saveExpertSettingsFor(
  ctx: ServerContext,
  data: z.input<typeof saveSettingsInput>,
): Promise<{ clickWindowHours: number }> {
  const input = saveSettingsInput.parse(data);
  const tenantId = await requireExpertAdminTenant(ctx);
  await assertTenantNotDemo(tenantId);

  const { error } = await db()
    .from("expert_settings")
    .upsert(
      { tenant_id: tenantId, click_window_hours: input.clickWindowHours },
      { onConflict: "tenant_id" },
    );
  if (error) throw new Error(error.message);

  const { from, to } = recentRefreshRange(new Date());
  const { error: refreshErr } = await db().rpc("refresh_expert_credits", {
    _tenant: tenantId,
    _from: from,
    _to: to,
  });
  if (refreshErr) throw new Error(refreshErr.message);

  return { clickWindowHours: input.clickWindowHours };
}
