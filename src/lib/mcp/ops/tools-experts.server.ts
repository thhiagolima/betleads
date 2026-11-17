// MCP do grupo, área de operação: ranking_experts, detalhe_expert e afiliados
// (§5.4-§5.6 de docs/superpowers/specs/2026-11-17-mcp-grupo-design.md).
// Contrato em ./registry.server.ts: toda ferramenta resolve as casas por
// `resolverEscopoOps` (a única porta) e só consulta essas casas.
//
// - ranking_experts: por casa (porCasa), os perfis (`listTeamExperts`, o mesmo
//   rótulo de tipo do painel), `expert_metrics`, `house_deposit_totals` (a
//   fatia do expert no depositado da casa) e o teto/uso do mês corrente
//   (`listExpertUsageForAdminCore`). Ranking por moeda: nunca se ordena nem
//   soma expert de casas em moedas diferentes.
// - detalhe_expert: uma casa, e o expert tem que ser dela. Métricas como acima,
//   affiliate_ids vinculados, campanhas do expert no período (sms/email/voz),
//   uso do teto e alertas de teto do mês. Nada de contato/lead: só contagens.
// - afiliados: uma chamada a `mcp_affiliate_metrics` com todas as casas do
//   escopo. Qualquer affiliate_id, com ou sem expert (expert: null).
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { expertCapMonth } from "@/lib/billing/expert-cap-alerts.server";
import {
  listExpertUsageForAdminCore,
  type ExpertUsageRow,
} from "@/lib/expert-campaigns-admin.server";
import {
  fetchExpertMetrics,
  mapMetricsRow,
  type ExpertMetrics,
} from "@/lib/expert-metrics.functions";
import { fetchHouseDepositTotals, listTeamExperts } from "@/lib/expert-report.functions";
import { dbUuid } from "@/lib/zod-helpers";

import type { McpIdentity } from "../access.server";
import type { OpsToolDef } from "./registry.server";
import {
  escopoOps,
  limiteInput,
  periodoOps,
  porCasa,
  toRange,
  totaisPorMoeda,
  truncar,
  type CasaComErro,
  type PeriodoOps,
  type TotalPorMoeda,
} from "./runner.server";
import { resolverEscopoOps, type CasaOps } from "./scope.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- expert tables/RPCs are not in the generated Supabase types. */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const EXPERT_NAO_ENCONTRADO = "Expert não encontrado nesta casa.";

/** Máximo de campanhas no detalhe do expert. */
const CAMPANHAS_MAX = 100;

const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
/** part/total em %, 1 casa decimal; null sem total. */
const pct = (part: number, total: number) =>
  total > 0 ? Math.round((part / total) * 1000) / 10 : null;

type CasaRef = { id: string; nome: string; moeda: string };
const casaRef = (casa: CasaOps): CasaRef => ({ id: casa.id, nome: casa.nome, moeda: casa.moeda });

/** Agrupa por moeda (moedas em ordem alfabética), preservando a ordem dada. */
function groupByMoeda<T>(
  rows: T[],
  moedaOf: (row: T) => string,
): Array<{ moeda: string; rows: T[] }> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const moeda = moedaOf(row);
    const list = map.get(moeda) ?? [];
    list.push(row);
    map.set(moeda, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([moeda, list]) => ({ moeda, rows: list }));
}

// ─── Métricas do expert (ranking e detalhe) ─────────────────────────────────

export type MetricasExpert = {
  depositado: number;
  depositado_clique: number;
  depositado_afiliado: number;
  depositos: number;
  depositantes: number;
  ftds: number;
  reativacoes: number;
  links: number;
  cliques: number;
  contatos: number;
  /** % do depositado da casa no período (house_deposit_totals); null se a casa não depositou. */
  fatia_casa_pct: number | null;
};

type Metrics = Omit<ExpertMetrics, "expertId">;

const ZERO_METRICS: Metrics = {
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

function toMetricas(m: Metrics, depositadoCasa: number): MetricasExpert {
  return {
    depositado: round2(m.depositado),
    depositado_clique: round2(m.depositadoClique),
    depositado_afiliado: round2(m.depositadoAfiliado),
    depositos: m.depositos,
    depositantes: m.depositantes,
    ftds: m.ftds,
    reativacoes: m.reativacoes,
    links: m.links,
    cliques: m.cliques,
    contatos: m.contatos,
    fatia_casa_pct: pct(m.depositado, depositadoCasa),
  };
}

const semAtividade = (m: Metrics) =>
  m.depositado === 0 &&
  m.depositos === 0 &&
  m.ftds === 0 &&
  m.links === 0 &&
  m.cliques === 0 &&
  m.contatos === 0;

type ExpertDaCasa = {
  expert_id: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  metricas: MetricasExpert;
  teto_mensal: number | null;
  usado_mes: number;
  semAtividade: boolean;
  uso: ExpertUsageRow | null;
};

type ExpertsDaCasa = {
  depositadoCasa: number;
  ftdsCasa: number;
  /** Mês do uso/teto, AAAA-MM. */
  mes: string;
  experts: ExpertDaCasa[];
};

/** Perfis + métricas + total da casa + uso do mês de uma casa (ou de um expert dela). */
async function expertsDaCasa(
  casa: CasaOps,
  periodo: PeriodoOps,
  now: Date,
  expertId?: string,
): Promise<ExpertsDaCasa> {
  const [experts, metricRows, house, usage] = await Promise.all([
    listTeamExperts(casa.id),
    fetchExpertMetrics(casa.id, periodo.fromInstant, periodo.toInstant),
    fetchHouseDepositTotals(casa.id, { from: periodo.fromInstant, to: periodo.toInstant }),
    listExpertUsageForAdminCore(casa.id, { expertId: expertId ?? null }, now),
  ]);
  const metricsBy = new Map(metricRows.map((row) => [row.expert_id, mapMetricsRow(row)]));
  const usageBy = new Map(usage.items.map((item) => [item.expertId, item]));
  return {
    depositadoCasa: round2(house.depositado),
    ftdsCasa: house.ftds,
    mes: usage.mes,
    experts: experts
      .filter((expert) => !expertId || expert.id === expertId)
      .map((expert): ExpertDaCasa => {
        const m: Metrics = metricsBy.get(expert.id) ?? ZERO_METRICS;
        const uso = usageBy.get(expert.id) ?? null;
        return {
          expert_id: expert.id,
          nome: expert.nome,
          tipo: expert.tipoLabel,
          ativo: expert.ativo,
          metricas: toMetricas(m, house.depositado),
          teto_mensal: uso?.teto ?? null,
          usado_mes: round2(uso?.usado ?? 0),
          semAtividade: semAtividade(m),
          uso,
        };
      }),
  };
}

// ─── ranking_experts ────────────────────────────────────────────────────────

const ORDENAR_RANKING = ["depositado", "ftds", "cliques"] as const;

const rankingInput = z.object({
  escopo: escopoOps,
  periodo: periodoOps,
  ordenar: z
    .enum(ORDENAR_RANKING)
    .default("depositado")
    .describe("Ordem do ranking: depositado (padrão), ftds ou cliques."),
  limite: limiteInput,
});

export type ExpertRankingRow = {
  casa: CasaRef;
  expert_id: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  teto_mensal: number | null;
  usado_mes: number;
} & MetricasExpert;

export type RankingExpertsResult = {
  rotulo: string;
  periodo: PeriodoOps;
  ordenar: (typeof ORDENAR_RANKING)[number];
  /** Mês do uso/teto (AAAA-MM, horário de Brasília). */
  mes_uso: string;
  casas: Array<CasaRef & { depositado_casa: number; ftds_casa: number; experts: number }>;
  ranking_por_moeda: Array<{ moeda: string; experts: ExpertRankingRow[]; truncado: boolean }>;
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
};

export async function rankingExperts(
  identity: McpIdentity,
  rawArgs: unknown,
  now: Date = new Date(),
): Promise<RankingExpertsResult> {
  const args = rankingInput.parse(rawArgs);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, args.escopo);
  const periodo = toRange(args.periodo, now);
  const { ok, casas_com_erro } = await porCasa(casas, (casa) => expertsDaCasa(casa, periodo, now));

  const rows: ExpertRankingRow[] = [];
  for (const { casa, resultado } of ok) {
    for (const expert of resultado.experts) {
      // Perfil desativado e sem nada no período não entra no ranking.
      if (!expert.ativo && expert.semAtividade) continue;
      rows.push({
        casa: casaRef(casa),
        expert_id: expert.expert_id,
        nome: expert.nome,
        tipo: expert.tipo,
        ativo: expert.ativo,
        teto_mensal: expert.teto_mensal,
        usado_mes: expert.usado_mes,
        ...expert.metricas,
      });
    }
  }

  const key = args.ordenar;
  const ranking_por_moeda = groupByMoeda(rows, (row) => row.casa.moeda).map((group) => {
    const sorted = [...group.rows].sort(
      (a, b) =>
        b[key] - a[key] || b.depositado - a.depositado || a.nome.localeCompare(b.nome, "pt-BR"),
    );
    const { itens, truncado } = truncar(sorted, args.limite);
    return { moeda: group.moeda, experts: itens, truncado };
  });

  const casasRows = ok.map(({ casa, resultado }) => ({
    ...casaRef(casa),
    depositado_casa: resultado.depositadoCasa,
    ftds_casa: resultado.ftdsCasa,
    experts: resultado.experts.length,
  }));
  const depositadoCasa = new Map(
    totaisPorMoeda(casasRows, (row) => ({
      moeda: row.moeda,
      valores: { depositado_casa: row.depositado_casa },
    })).map((total) => [total.moeda, total.totais.depositado_casa ?? 0]),
  );
  const totais_por_moeda = totaisPorMoeda(rows, (row) => ({
    moeda: row.casa.moeda,
    valores: {
      depositado: row.depositado,
      depositos: row.depositos,
      depositantes: row.depositantes,
      ftds: row.ftds,
      reativacoes: row.reativacoes,
      cliques: row.cliques,
      contatos: row.contatos,
    },
  })).map((total) => {
    const casaTotal = depositadoCasa.get(total.moeda) ?? 0;
    return {
      ...total,
      totais: {
        ...total.totais,
        depositado_casa: casaTotal,
        fatia_casa_pct: pct(total.totais.depositado ?? 0, casaTotal),
      },
    };
  });

  return {
    rotulo,
    periodo,
    ordenar: key,
    mes_uso: ok[0]?.resultado.mes ?? expertCapMonth(now).slice(0, 7),
    casas: casasRows,
    ranking_por_moeda,
    totais_por_moeda,
    casas_com_erro,
  };
}

// ─── detalhe_expert ─────────────────────────────────────────────────────────

const detalheInput = z.object({
  casa: dbUuid().describe("Id da casa do expert (de listar_escopos)."),
  expert: dbUuid().describe("Id do expert (de ranking_experts)."),
  periodo: periodoOps,
});

type Canal = "sms" | "email" | "voz";

export type CampanhaExpert = {
  id: string;
  canal: Canal;
  nome: string;
  status: string;
  criada_em: string;
  agendada_em: string | null;
  total: number;
  enviados: number;
  /** Voz: null (expert_voice_campaigns não guarda falhas). */
  falhas: number | null;
};

const CAMPANHA_TABLES: Record<Canal, { table: string; columns: string }> = {
  sms: {
    table: "sms_campaigns",
    columns: "id,name,status,created_at,scheduled_at,total_count,sent_count,failed_count",
  },
  email: { table: "email_campaigns", columns: "id,name,status,created_at,scheduled_at,stats" },
  voz: {
    table: "expert_voice_campaigns",
    columns: "id,name,status,created_at,scheduled_at,total_count,queued_count",
  },
};

type CampanhaDbRow = {
  id: string;
  name: string | null;
  status: string;
  created_at: string;
  scheduled_at: string | null;
  total_count?: number | null;
  sent_count?: number | null;
  failed_count?: number | null;
  queued_count?: number | null;
  stats?: Record<string, unknown> | null;
};

/** Mesma leitura de expert-campaigns.server.ts (toListItem): e-mail conta em `stats`, voz em `queued_count`. */
function toCampanha(canal: Canal, r: CampanhaDbRow): CampanhaExpert {
  const stats = r.stats ?? {};
  const enviados =
    canal === "email"
      ? (stats.enviados ?? stats.sent)
      : canal === "voz"
        ? r.queued_count
        : r.sent_count;
  return {
    id: r.id,
    canal,
    nome: r.name ?? "",
    status: r.status,
    criada_em: r.created_at,
    agendada_em: r.scheduled_at ?? null,
    total: num(canal === "email" ? stats.total : r.total_count),
    enviados: num(enviados),
    falhas:
      canal === "voz"
        ? null
        : num(canal === "email" ? (stats.falhas ?? stats.failed) : r.failed_count),
  };
}

/** Campanhas do expert criadas ou agendadas no período, nos três canais, mais recentes primeiro. */
async function campanhasDoExpert(
  tenantId: string,
  expertId: string,
  periodo: PeriodoOps,
): Promise<{ itens: CampanhaExpert[]; truncado: boolean }> {
  const queries = (Object.keys(CAMPANHA_TABLES) as Canal[]).flatMap((canal) =>
    (["created_at", "scheduled_at"] as const).map(async (column) => {
      const { table, columns } = CAMPANHA_TABLES[canal];
      const { data, error } = await db()
        .from(table)
        .select(columns)
        .eq("tenant_id", tenantId)
        .eq("expert_id", expertId)
        .gte(column, periodo.fromInstant)
        .lt(column, periodo.toInstant)
        .order(column, { ascending: false })
        .limit(CAMPANHAS_MAX + 1);
      if (error) throw new Error(error.message);
      return ((data ?? []) as CampanhaDbRow[]).map((row) => toCampanha(canal, row));
    }),
  );
  const byKey = new Map<string, CampanhaExpert>();
  for (const list of await Promise.all(queries)) {
    for (const campanha of list) byKey.set(`${campanha.canal}:${campanha.id}`, campanha);
  }
  const all = Array.from(byKey.values()).sort((a, b) =>
    (b.agendada_em ?? b.criada_em).localeCompare(a.agendada_em ?? a.criada_em),
  );
  return truncar(all, CAMPANHAS_MAX);
}

async function afiliadosDoExpert(tenantId: string, expertId: string): Promise<string[]> {
  const { data, error } = await db()
    .from("expert_affiliates")
    .select("affiliate_id")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .order("affiliate_id");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ affiliate_id: string }>).map((row) => row.affiliate_id);
}

/** Alerta de teto do mês corrente (no máximo um por expert por mês, expert_cap_alerts). */
async function alertasTeto(
  tenantId: string,
  expertId: string,
  now: Date,
): Promise<Array<{ mes: string; enviado_em: string }>> {
  const { data, error } = await db()
    .from("expert_cap_alerts")
    .select("month,sent_at")
    .eq("tenant_id", tenantId)
    .eq("expert_id", expertId)
    .eq("month", expertCapMonth(now));
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ month: string; sent_at: string }>).map((row) => ({
    mes: String(row.month).slice(0, 7),
    enviado_em: row.sent_at,
  }));
}

export type DetalheExpertResult = {
  rotulo: string;
  periodo: PeriodoOps;
  casas: CasaRef[];
  expert: { id: string; nome: string; tipo: string; ativo: boolean };
  metricas: MetricasExpert & { depositado_casa: number };
  afiliados: string[];
  campanhas: CampanhaExpert[];
  campanhas_truncado: boolean;
  uso_teto: {
    mes: string;
    /** null = sem teto; 0 = envios bloqueados. */
    teto_mensal: number | null;
    usado_mes: number;
    pendentes: number;
    pendentes_estimado: number;
  };
  alertas_teto_abertos: Array<{ mes: string; enviado_em: string }>;
  casas_com_erro: CasaComErro[];
};

export async function detalheExpert(
  identity: McpIdentity,
  rawArgs: unknown,
  now: Date = new Date(),
): Promise<DetalheExpertResult> {
  const args = detalheInput.parse(rawArgs);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, {
    tipo: "casa",
    id: args.casa,
  });
  const casa = casas[0];
  const periodo = toRange(args.periodo, now);

  const dados = await expertsDaCasa(casa, periodo, now, args.expert);
  const expert = dados.experts[0];
  if (!expert) throw new Error(EXPERT_NAO_ENCONTRADO);

  const [vinculados, campanhas, alertas] = await Promise.all([
    afiliadosDoExpert(casa.id, expert.expert_id),
    campanhasDoExpert(casa.id, expert.expert_id, periodo),
    alertasTeto(casa.id, expert.expert_id, now),
  ]);

  return {
    rotulo,
    periodo,
    casas: [casaRef(casa)],
    expert: { id: expert.expert_id, nome: expert.nome, tipo: expert.tipo, ativo: expert.ativo },
    metricas: { ...expert.metricas, depositado_casa: dados.depositadoCasa },
    afiliados: vinculados,
    campanhas: campanhas.itens,
    campanhas_truncado: campanhas.truncado,
    uso_teto: {
      mes: dados.mes,
      teto_mensal: expert.teto_mensal,
      usado_mes: expert.usado_mes,
      pendentes: expert.uso?.pendentes ?? 0,
      pendentes_estimado: round2(expert.uso?.pendentesEstimado ?? 0),
    },
    alertas_teto_abertos: alertas,
    casas_com_erro: [],
  };
}

// ─── afiliados ──────────────────────────────────────────────────────────────

const ORDENAR_AFILIADOS = ["depositado", "cadastros", "ftds"] as const;

const afiliadosInput = z.object({
  escopo: escopoOps,
  periodo: periodoOps,
  affiliate_id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Um affiliate_id (players.affiliate_id): só esse id, em todas as casas do escopo."),
  so_sem_expert: z
    .boolean()
    .default(false)
    .describe("true: só os affiliate_id sem expert vinculado."),
  ordenar: z
    .enum(ORDENAR_AFILIADOS)
    .default("depositado")
    .describe("Ordem: depositado (padrão), cadastros ou ftds."),
  limite: limiteInput,
});

type AffiliateDbRow = {
  tenant_id: string;
  affiliate_id: string;
  jogadores_base: number | string;
  cadastros: number | string;
  ftds: number | string;
  depositos: number | string;
  depositado: number | string;
  depositantes: number | string;
  primeiro_cadastro: string | null;
  ultimo_cadastro: string | null;
  expert_id: string | null;
  expert_nome: string | null;
};

export type AfiliadoRow = {
  casa: CasaRef;
  affiliate_id: string;
  jogadores_base: number;
  cadastros: number;
  ftds: number;
  depositos: number;
  depositado: number;
  depositantes: number;
  primeiro_cadastro: string | null;
  ultimo_cadastro: string | null;
  expert: { id: string; nome: string } | null;
};

export type AfiliadosResult = {
  rotulo: string;
  periodo: PeriodoOps;
  ordenar: (typeof ORDENAR_AFILIADOS)[number];
  so_sem_expert: boolean;
  /** Presente com affiliate_id. */
  affiliate_id?: string;
  /** Com affiliate_id: false quando nenhuma casa do escopo tem o id (não é erro). */
  encontrado?: boolean;
  /** Resumo por casa (com affiliate_id, só as casas onde o id existe). */
  casas: Array<
    CasaRef & { afiliados: number; depositado: number; cadastros: number; ftds: number }
  >;
  /** Uma lista por moeda, ordenada e cortada em `limite`. */
  afiliados_por_moeda: Array<{ moeda: string; afiliados: AfiliadoRow[]; truncado: boolean }>;
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
};

export async function afiliados(
  identity: McpIdentity,
  rawArgs: unknown,
  now: Date = new Date(),
): Promise<AfiliadosResult> {
  const args = afiliadosInput.parse(rawArgs);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, args.escopo);
  const periodo = toRange(args.periodo, now);
  const casaById = new Map(casas.map((casa) => [casa.id, casa]));

  const { data, error } = await db().rpc("mcp_affiliate_metrics", {
    _tenants: casas.map((casa) => casa.id),
    _from: periodo.fromInstant,
    _to: periodo.toInstant,
    _affiliate: args.affiliate_id ?? null,
  });
  if (error) throw new Error(error.message);

  const rows: AfiliadoRow[] = [];
  for (const raw of (data ?? []) as AffiliateDbRow[]) {
    const casa = casaById.get(raw.tenant_id);
    if (!casa) continue; // defesa: só as casas do escopo
    if (args.so_sem_expert && raw.expert_id) continue;
    rows.push({
      casa: casaRef(casa),
      affiliate_id: raw.affiliate_id,
      jogadores_base: num(raw.jogadores_base),
      cadastros: num(raw.cadastros),
      ftds: num(raw.ftds),
      depositos: num(raw.depositos),
      depositado: round2(num(raw.depositado)),
      depositantes: num(raw.depositantes),
      primeiro_cadastro: raw.primeiro_cadastro ?? null,
      ultimo_cadastro: raw.ultimo_cadastro ?? null,
      expert: raw.expert_id ? { id: raw.expert_id, nome: raw.expert_nome ?? "" } : null,
    });
  }

  const key = args.ordenar;
  const afiliados_por_moeda = groupByMoeda(rows, (row) => row.casa.moeda).map((group) => {
    const sorted = [...group.rows].sort(
      (a, b) =>
        b[key] - a[key] ||
        b.depositado - a.depositado ||
        a.affiliate_id.localeCompare(b.affiliate_id) ||
        a.casa.nome.localeCompare(b.casa.nome, "pt-BR"),
    );
    const { itens, truncado } = truncar(sorted, args.limite);
    return { moeda: group.moeda, afiliados: itens, truncado };
  });

  const casasRows = casas
    .map((casa) => {
      const own = rows.filter((row) => row.casa.id === casa.id);
      return {
        ...casaRef(casa),
        afiliados: own.length,
        depositado: round2(own.reduce((sum, row) => sum + row.depositado, 0)),
        cadastros: own.reduce((sum, row) => sum + row.cadastros, 0),
        ftds: own.reduce((sum, row) => sum + row.ftds, 0),
      };
    })
    .filter((row) => !args.affiliate_id || row.afiliados > 0);

  const totais_por_moeda = totaisPorMoeda(rows, (row) => ({
    moeda: row.casa.moeda,
    valores: {
      jogadores_base: row.jogadores_base,
      cadastros: row.cadastros,
      ftds: row.ftds,
      depositos: row.depositos,
      depositado: row.depositado,
      depositantes: row.depositantes,
    },
  }));

  return {
    rotulo,
    periodo,
    ordenar: key,
    so_sem_expert: args.so_sem_expert,
    ...(args.affiliate_id ? { affiliate_id: args.affiliate_id, encontrado: rows.length > 0 } : {}),
    casas: casasRows,
    afiliados_por_moeda,
    totais_por_moeda,
    casas_com_erro: [],
  };
}

// ─── Registro ───────────────────────────────────────────────────────────────

export const EXPERTS_TOOLS: OpsToolDef[] = [
  {
    name: "ranking_experts",
    title: "Ranking de experts",
    description:
      "Ranking dos experts das casas do escopo no período. Por expert: casa, nome, tipo, ativo, " +
      "depositado (total, via clique e via afiliado), depósitos, depositantes, FTDs, reativações, " +
      "links, cliques, contatos, fatia_casa_pct (% do depositado da casa) e teto mensal/uso do mês " +
      "corrente. O ranking é por moeda (ranking_por_moeda): experts de casas em moedas diferentes " +
      "nunca se misturam nem se somam. Dinheiro na moeda da casa. ordenar: depositado (padrão), " +
      "ftds ou cliques; limite por moeda (padrão 20). Perfis desativados sem atividade no período " +
      "ficam de fora.",
    inputSchema: rankingInput,
    run: (identity, args) => rankingExperts(identity, args),
  },
  {
    name: "detalhe_expert",
    title: "Detalhe de um expert",
    description:
      "Um expert de uma casa no período: as mesmas métricas do ranking_experts, os affiliate_id " +
      "vinculados a ele, as campanhas dele criadas ou agendadas no período (sms, email, voz: id, " +
      "canal, nome, status, total, enviados, falhas), o uso do teto do mês corrente e os alertas " +
      "de teto do mês. Entrada: casa (id, de listar_escopos) e expert (id, de ranking_experts). " +
      "Só agregados.",
    inputSchema: detalheInput,
    run: (identity, args) => detalheExpert(identity, args),
    scopeOf: (args: { casa?: string } | undefined) => ({ tipo: "casa", id: args?.casa ?? null }),
  },
  {
    name: "afiliados",
    title: "Afiliados (affiliate_id)",
    description:
      "Números por affiliate_id (players.affiliate_id) nas casas do escopo: jogadores na base " +
      "(sem período), cadastros, FTDs, depósitos aprovados (quantidade e valor) e depositantes no " +
      "período, primeiro e último cadastro e o expert vinculado (ou null). Com affiliate_id: só " +
      "esse id, uma linha por casa onde ele existe, com ou sem expert; encontrado=false quando " +
      "nenhuma casa tem o id (não é erro). so_sem_expert=true lista só os ids sem vínculo. " +
      "ordenar: depositado (padrão), cadastros ou ftds. Agrupado por moeda, sem soma entre moedas.",
    inputSchema: afiliadosInput,
    run: (identity, args) => afiliados(identity, args),
  },
];
