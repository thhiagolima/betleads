// Server functions de painel da Área do Expert (Fase 3, Task 3): dashboard
// do próprio expert e a configuração da janela de clique. Task 8 acrescenta
// o extrato de créditos (base da comissão paga por fora do sistema) e o CSV
// do período. O detalhe por expert (`getExpertDetail`/`getExpertDetailFor`)
// foi removido no Relatório de rendimento (Task 5): a tela que o usava
// (/experts/$expertId) agora redireciona para /rendimento/equipe/$expertId.
// O ranking do admin (`listExpertsRanking`/`listExpertsRankingFor`) foi
// removido no Relatório de rendimento (Task 7): virou `getTeamReport`
// (`expert-report.functions.ts`), atrás de /rendimento/equipe. Consomem as
// funções SQL da Task 2 (`expert_metrics`/`expert_metrics_daily`) e da Task 1
// (`expert_settings`/`refresh_expert_credits`), todas service_role, e ainda
// fora dos tipos gerados do Supabase → `(supabaseAdmin as any)`, como em
// `expert-access.server.ts`.
//
// Guards: `requireExpertContext` para o próprio expert (dashboard);
// `requireExpertAdminTenant` (exportado de `experts-admin.functions.ts`,
// mesma cadeia `resolveOperationalTenantForRequest` + `requireTenantAdmin`)
// para o admin (janela de clique). O extrato e o CSV dele resolvem o dono
// por `resolveReportSubject` (relatório de rendimento): sem `expertId`, o
// próprio usuário; com `expertId`, só o admin.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireExpertContext } from "@/lib/expert-access.server";
import { DEFAULT_EXPERT_PERIOD, periodRange, type PeriodKey } from "@/lib/expert-period";
import { resolveReportSubject } from "@/lib/expert-report-subject.server";
import { requireExpertAdminTenant } from "@/lib/experts-admin.functions";
import { neutralizeCsvFormula } from "@/lib/csv-safe";
import { brtDayKey, brtDayStart } from "@/lib/tz";
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

// As chaves de `EXPERT_PERIODS` (expert-period.ts: os presets da Central mais
// "Este mês" e "Mês passado"), repetidas aqui como tupla porque o zod precisa
// de um literal, não de um array computado.
const PERIOD_KEYS: [PeriodKey, ...PeriodKey[]] = [
  "hoje",
  "ontem",
  "7",
  "30",
  "90",
  "mes_atual",
  "mes_anterior",
];
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
  const { data, error } = await db().rpc("expert_metrics", {
    _tenant: tenantId,
    _from: from,
    _to: to,
  });
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
export async function getClickWindowHours(tenantId: string): Promise<number> {
  const { data, error } = await db()
    .from("expert_settings")
    .select("click_window_hours")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { click_window_hours?: number } | null)?.click_window_hours ?? 72;
}

// Relatório de rendimento, Task 7: a tela Experts (configuração) precisa da
// janela salva para abrir a "Regras de crédito" dialog já preenchida, sem
// mais depender do ranking (`listExpertsRanking`, removido — o ranking agora
// vive em /rendimento/equipe). As telas de relatório pegam a janela de
// `getExpertReport`/`getTeamReport`, que já a devolvem.
export const getExpertClickWindowHours = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    getExpertClickWindowHoursFor(context as unknown as ServerContext),
  );

export async function getExpertClickWindowHoursFor(
  ctx: ServerContext,
): Promise<{ janelaHoras: number }> {
  const tenantId = await requireExpertAdminTenant(ctx);
  return { janelaHoras: await getClickWindowHours(tenantId) };
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

// ---------------------------------------------------------- shared: player names

async function namesByPlayerId(
  tenantId: string,
  playerIds: string[],
): Promise<Map<string, string>> {
  if (playerIds.length === 0) return new Map();
  const { data, error } = await db()
    .from("players")
    .select("id,nome")
    .eq("tenant_id", tenantId)
    .in("id", playerIds);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Array<{ id: string; nome: string }>).map((p) => [p.id, p.nome]));
}

// ---------------------------------------------------------- admin: credit statement (Task 8)
//
// Base da comissão paga por fora do sistema (spec 7.1): extrato de créditos
// por expert e período, paginado, e o CSV completo do período. `somaValor` é
// sempre o total do período inteiro (não da página), somado em lotes — sem
// função SQL agregada nova (fora do escopo desta task) e sem carregar um
// resultado sem limite numa consulta só.

export type ExpertCreditRow = {
  depositId: string;
  depositAt: string;
  leadNome: string;
  valor: number;
  via: "clique" | "afiliado";
  oferta: string | null;
  clickAt: string | null;
  isFtd: boolean;
  isReativacao: boolean;
};

type CreditDbRow = {
  deposit_id: string;
  deposit_at: string;
  player_id: string;
  valor: number | string;
  via: "clique" | "afiliado";
  link_dispatch_id: string | null;
  click_at: string | null;
  is_ftd: boolean;
  is_reativacao: boolean;
};

const CREDIT_COLUMNS =
  "deposit_id,deposit_at,player_id,valor,via,link_dispatch_id,click_at,is_ftd,is_reativacao";
const CREDIT_PAGE_SIZE = 100;
// Tamanho do lote ao paginar no cliente (soma do período inteiro, export
// CSV): não há limite de linhas vindo do banco numa consulta só.
const CREDIT_FETCH_CHUNK = 1000;

function creditsBaseQuery(
  tenantId: string,
  expertId: string,
  from: string,
  to: string,
  columns: string,
  options?: { count?: "exact" },
) {
  return db()
    .from("expert_deposit_credits")
    .select(columns, options)
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .gte("deposit_at", from)
    .lt("deposit_at", to);
}

/** Oferta de cada `link_dispatch_id`, via `expert_links` (mesma casa). */
async function ofertaByDispatchId(
  tenantId: string,
  dispatchIds: string[],
): Promise<Map<string, string>> {
  if (dispatchIds.length === 0) return new Map();
  const { data, error } = await db()
    .from("expert_links")
    .select("link_dispatch_id,oferta")
    .eq("tenant_id", tenantId)
    .in("link_dispatch_id", dispatchIds);
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as Array<{ link_dispatch_id: string | null; oferta: string }>)
      .filter((r) => r.link_dispatch_id)
      .map((r) => [r.link_dispatch_id as string, r.oferta]),
  );
}

async function mapCreditRows(tenantId: string, rows: CreditDbRow[]): Promise<ExpertCreditRow[]> {
  if (rows.length === 0) return [];
  const dispatchIds = Array.from(
    new Set(rows.map((r) => r.link_dispatch_id).filter((id): id is string => Boolean(id))),
  );
  const [nomeById, ofertaByDispatch] = await Promise.all([
    namesByPlayerId(
      tenantId,
      rows.map((r) => r.player_id),
    ),
    ofertaByDispatchId(tenantId, dispatchIds),
  ]);
  return rows.map((r) => ({
    depositId: r.deposit_id,
    depositAt: r.deposit_at,
    leadNome: nomeById.get(r.player_id) ?? "",
    valor: Number(r.valor),
    via: r.via,
    oferta: r.link_dispatch_id ? (ofertaByDispatch.get(r.link_dispatch_id) ?? null) : null,
    clickAt: r.click_at,
    isFtd: r.is_ftd,
    isReativacao: r.is_reativacao,
  }));
}

/** Soma de `valor` do período inteiro, paginando em lotes de `CREDIT_FETCH_CHUNK`. */
async function sumCreditsValor(
  tenantId: string,
  expertId: string,
  from: string,
  to: string,
): Promise<number> {
  let total = 0;
  let offset = 0;
  for (;;) {
    const { data, error } = await creditsBaseQuery(tenantId, expertId, from, to, "valor")
      .order("deposit_id", { ascending: true })
      .range(offset, offset + CREDIT_FETCH_CHUNK - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ valor: number | string }>;
    for (const r of rows) total += Number(r.valor);
    if (rows.length < CREDIT_FETCH_CHUNK) break;
    offset += CREDIT_FETCH_CHUNK;
  }
  return total;
}

/** Todas as linhas do período (export CSV), paginando em lotes de `CREDIT_FETCH_CHUNK`. */
async function fetchAllCredits(
  tenantId: string,
  expertId: string,
  from: string,
  to: string,
): Promise<CreditDbRow[]> {
  const out: CreditDbRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await creditsBaseQuery(tenantId, expertId, from, to, CREDIT_COLUMNS)
      .order("deposit_at", { ascending: false })
      .order("deposit_id", { ascending: false })
      .range(offset, offset + CREDIT_FETCH_CHUNK - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as CreditDbRow[];
    out.push(...rows);
    if (rows.length < CREDIT_FETCH_CHUNK) break;
    offset += CREDIT_FETCH_CHUNK;
  }
  return out;
}

// Sem `expertId`: o extrato do próprio usuário (expert ou perfil da equipe);
// com `expertId`: só o admin da casa (`resolveReportSubject`).
const listCreditsInput = z.object({
  expertId: dbUuid().optional(),
  period: periodKeySchema.optional(),
  page: z.number().int().min(0).optional(),
});

export const listExpertCredits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listCreditsInput.parse(data))
  .handler(async ({ data, context }) =>
    listExpertCreditsFor(context as unknown as ServerContext, data),
  );

export async function listExpertCreditsFor(
  ctx: ServerContext,
  data: z.input<typeof listCreditsInput>,
): Promise<{ rows: ExpertCreditRow[]; total: number; somaValor: number }> {
  const input = listCreditsInput.parse(data);
  // Com `expertId`, `loadExpert` (dentro do sujeito) filtra por tenant_id:
  // expert de outra casa cai em "Expert não encontrado.".
  const { tenantId, expertId } = await resolveReportSubject(ctx, input.expertId);
  const period = input.period ?? DEFAULT_EXPERT_PERIOD;
  const { from, to } = periodRange(period, new Date());
  const page = input.page ?? 0;
  const offset = page * CREDIT_PAGE_SIZE;

  const [{ data: rowsData, error, count }, somaValor] = await Promise.all([
    creditsBaseQuery(tenantId, expertId, from, to, CREDIT_COLUMNS, { count: "exact" })
      .order("deposit_at", { ascending: false })
      .order("deposit_id", { ascending: false })
      .range(offset, offset + CREDIT_PAGE_SIZE - 1),
    sumCreditsValor(tenantId, expertId, from, to),
  ]);
  if (error) throw new Error(error.message);

  const rows = await mapCreditRows(tenantId, (rowsData ?? []) as CreditDbRow[]);
  return { rows, total: Number(count ?? 0), somaValor };
}

/** Texto seguro para nome de arquivo: minúsculas, sem acento, só [a-z0-9-]. */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "expert";
}

/** Instante ISO -> "dd/mm/aaaa hh:mm" em São Paulo, sem vírgula (para o CSV). */
export function formatBrtDateTimeCsv(iso: string): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

/** Número -> texto com vírgula decimal ("1234,50"), sem separador de milhar. */
export function brValor(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/**
 * Célula do CSV do extrato (e da carteira do relatório de rendimento):
 * separador ";", então só ";"/aspas/quebra de linha exigem aspas.
 */
export function creditsCsvCell(value: unknown): string {
  const text = neutralizeCsvFormula(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CREDITS_CSV_HEADER = [
  "Data",
  "Lead",
  "Valor",
  "Origem",
  "Oferta",
  "Clique em",
  "Primeiro depósito",
  "Reativação",
];

const exportCreditsCsvInput = z.object({
  expertId: dbUuid().optional(),
  period: periodKeySchema.optional(),
});

export const exportExpertCreditsCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => exportCreditsCsvInput.parse(data))
  .handler(async ({ data, context }) =>
    exportExpertCreditsCsvFor(context as unknown as ServerContext, data),
  );

export async function exportExpertCreditsCsvFor(
  ctx: ServerContext,
  data: z.input<typeof exportCreditsCsvInput>,
): Promise<{ filename: string; csv: string }> {
  const input = exportCreditsCsvInput.parse(data);
  const subject = await resolveReportSubject(ctx, input.expertId);
  const { tenantId, expertId } = subject;
  const period = input.period ?? DEFAULT_EXPERT_PERIOD;
  const { from, to } = periodRange(period, new Date());

  const dbRows = await fetchAllCredits(tenantId, expertId, from, to);
  const rows = await mapCreditRows(tenantId, dbRows);

  const lines = [CREDITS_CSV_HEADER.join(";")];
  let soma = 0;
  for (const row of rows) {
    soma += row.valor;
    lines.push(
      [
        formatBrtDateTimeCsv(row.depositAt),
        row.leadNome,
        brValor(row.valor),
        row.via === "clique" ? "Clique" : "Afiliado",
        row.oferta ?? "",
        row.clickAt ? formatBrtDateTimeCsv(row.clickAt) : "",
        row.isFtd ? "Sim" : "Não",
        row.isReativacao ? "Sim" : "Não",
      ]
        .map(creditsCsvCell)
        .join(";"),
    );
  }
  lines.push(["Total", "", brValor(soma), "", "", "", "", ""].join(";"));

  const fromDay = brtDayKey(new Date(from));
  // `to` é exclusivo e pode ser "agora" (não um limite de dia): o dia do
  // último instante incluído é 1ms antes.
  const toDay = brtDayKey(new Date(new Date(to).getTime() - 1));
  const filename = `extrato-${slugify(subject.nome)}-${fromDay}-a-${toDay}.csv`;

  // BOM UTF-8 para o Excel (pt-BR) abrir os acentos corretamente.
  return { filename, csv: "﻿" + lines.join("\n") };
}

// ---------------------------------------------------------- admin: settings

const RECENT_REFRESH_DAYS = 8;

/**
 * Faixa dos últimos `RECENT_REFRESH_DAYS` dias (São Paulo), o mesmo cálculo
 * de `refresh_expert_credits_recent(8)` (migration 20261105143000) — mas
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
