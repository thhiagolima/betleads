// MCP do grupo, área de operação: `jornadas` (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5.8). Per journey:
// house, id, name, status, trigger, daily limit and the Automações card
// metrics (`list_journey_metrics`, same RPC as `listJourneys`: enrollments by
// status, sends by channel and the attributed recovery — all since the
// journey started, not the period). With `periodo`, also the Central de
// Resultados numbers of the period (crm_results_daily, source_type
// 'journey', source_id = journey id: SMS sends/cost + tracked-link clicks
// and direct conversions); a journey with no Central row has null there.
// Applied revisions (archived with revision_of) are hidden like the panel.
import { z } from "zod";

import type { McpIdentity } from "../access.server";
import { loadResultadosCrm, opsDb, type ResultadoCrm } from "./campanhas-data.server";
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

export const JOURNEY_STATUS = ["draft", "active", "paused", "archived"] as const;

export const jornadasInput = z.object({
  escopo: escopoOps,
  status: z
    .enum(JOURNEY_STATUS)
    .optional()
    .describe("draft (rascunho), active (ativa), paused (pausada) ou archived (arquivada)."),
  periodo: periodoOps
    .optional()
    .describe(
      "Opcional. Com período, cada jornada traz `periodo_resultados` da Central de Resultados (SMS enviados, custo em BRL, cliques e conversões diretas).",
    ),
  limite: limiteInput,
});

export type ResultadosJornada = {
  enviados_sms: number;
  falhas_sms: number;
  custo_brl: number;
  cliques_humanos: number;
  conversoes_diretas: number;
  receita_direta: number;
};

export type JornadaLinha = {
  casa: { id: string; nome: string; moeda: string };
  id: string;
  nome: string;
  status: string;
  gatilho: string;
  limite_diario: number | null;
  atualizada_em: string | null;
  inscritos: { total: number; por_status: Record<string, number> };
  /** A list, not a map: a channel key "email" would trip assertSemDadosPessoais. */
  enviados_por_canal: Array<{ canal: string; enviados: number }>;
  concluiram_sem_mensagem: number;
  /** House currency; direct deposits after a click, since the journey began. */
  receita_recuperada: number;
  /** Only with `periodo`; null when the Central has no row for it. */
  periodo_resultados?: ResultadosJornada | null;
};

export type JornadasCasa = {
  id: string;
  nome: string;
  moeda: string;
  grupo: string | null;
  jornadas: number;
  por_status: Record<string, number>;
  inscritos: number;
  periodo_resultados?: ResultadosJornada | null;
};

export type JornadasResult = {
  rotulo: string;
  periodo: { inicio: string; fim: string; preset: string } | null;
  moeda_custo: "BRL";
  casas: JornadasCasa[];
  jornadas: JornadaLinha[];
  truncado: boolean;
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
};
type Row = Record<string, unknown>;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const numMap = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Row).map(([key, amount]) => [key, num(amount)]),
  );
};
const round2 = (value: number) => Math.round(value * 100) / 100;

export function toResultadosJornada(crm: ResultadoCrm | undefined): ResultadosJornada | null {
  if (!crm) return null;
  return {
    enviados_sms: crm.enviados,
    falhas_sms: crm.falhas,
    custo_brl: crm.custo_brl,
    cliques_humanos: crm.cliques,
    conversoes_diretas: crm.conversoes_diretas,
    receita_direta: crm.receita_direta,
  };
}

/** The journey row of the panel plus its `list_journey_metrics` entry. */
export function jornadaLinha(casa: CasaOps, journey: Row, metrics: Row | undefined): JornadaLinha {
  const m = metrics ?? {};
  return {
    casa: { id: casa.id, nome: casa.nome, moeda: casa.moeda },
    id: String(journey.id),
    nome: String(journey.name ?? "").trim(),
    status: String(journey.status ?? ""),
    gatilho: String(journey.trigger_type ?? ""),
    limite_diario: journey.daily_limit == null ? null : num(journey.daily_limit),
    atualizada_em: journey.updated_at ? String(journey.updated_at) : null,
    inscritos: { total: num(m.total), por_status: numMap(m.byStatus) },
    enviados_por_canal: Object.entries(numMap(m.sentByChannel)).map(([canal, enviados]) => ({
      canal,
      enviados,
    })),
    concluiram_sem_mensagem: num(m.finishedWithoutMessage),
    receita_recuperada: round2(num(m.recovered)),
  };
}

async function jornadasDaCasa(
  casa: CasaOps,
  status: string | undefined,
  periodo: PeriodoOps | null,
) {
  let query = opsDb()
    .from("journeys")
    .select("id,name,status,trigger_type,daily_limit,updated_at")
    .eq("tenant_id", casa.id)
    // Same as listJourneys: an applied revision is archived and its content
    // lives in the original journey.
    .or("revision_of.is.null,status.neq.archived");
  if (status) query = query.eq("status", status);
  const [journeysRes, metricsRes] = await Promise.all([
    query.order("updated_at", { ascending: false }),
    opsDb().rpc("list_journey_metrics", { p_tenant_id: casa.id }),
  ]);
  if (journeysRes.error) throw new Error(journeysRes.error.message);
  if (metricsRes.error) throw new Error(metricsRes.error.message);
  const metricsById = new Map(
    ((metricsRes.data ?? []) as Array<{ journey_id: string; metrics: Row }>).map((row) => [
      String(row.journey_id),
      row.metrics,
    ]),
  );
  const journeys = (journeysRes.data ?? []) as Row[];
  const linhas = journeys.map((journey) =>
    jornadaLinha(casa, journey, metricsById.get(String(journey.id))),
  );
  if (periodo && linhas.length) {
    const crm = await loadResultadosCrm(
      casa.id,
      "journey",
      linhas.map((linha) => linha.id),
      periodo.inicio,
      periodo.fim,
    );
    for (const linha of linhas) linha.periodo_resultados = toResultadosJornada(crm.get(linha.id));
  }
  return linhas;
}

function somaResultados(linhas: JornadaLinha[]): ResultadosJornada | null {
  const present = linhas
    .map((l) => l.periodo_resultados)
    .filter((r): r is ResultadosJornada => !!r);
  if (!present.length) return null;
  const total: ResultadosJornada = {
    enviados_sms: 0,
    falhas_sms: 0,
    custo_brl: 0,
    cliques_humanos: 0,
    conversoes_diretas: 0,
    receita_direta: 0,
  };
  for (const r of present) {
    for (const key of Object.keys(total) as Array<keyof ResultadosJornada>) {
      total[key] = round2(total[key] + r[key]);
    }
  }
  return total;
}

/** `jornadas` (§5.8). */
export async function jornadas(
  identity: McpIdentity,
  args: z.input<typeof jornadasInput>,
  now: Date = new Date(),
): Promise<JornadasResult> {
  const data = jornadasInput.parse(args);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, data.escopo);
  const periodo = data.periodo ? toRange(data.periodo, now) : null;

  const result = await porCasa(casas, (casa) => jornadasDaCasa(casa, data.status, periodo));

  const linhasCasa: JornadasCasa[] = result.ok.map(({ casa, resultado }) => {
    const porStatus: Record<string, number> = {};
    for (const linha of resultado) porStatus[linha.status] = (porStatus[linha.status] ?? 0) + 1;
    return {
      id: casa.id,
      nome: casa.nome,
      moeda: casa.moeda,
      grupo: casa.grupo?.nome ?? null,
      jornadas: resultado.length,
      por_status: porStatus,
      inscritos: resultado.reduce((acc, linha) => acc + linha.inscritos.total, 0),
      ...(periodo ? { periodo_resultados: somaResultados(resultado) } : {}),
    };
  });
  const todas = result.ok
    .flatMap(({ resultado }) => resultado)
    .sort((a, b) => (b.atualizada_em ?? "").localeCompare(a.atualizada_em ?? ""));
  const { itens, truncado } = truncar(todas, data.limite);

  return {
    rotulo,
    periodo: periodo ? { inicio: periodo.inicio, fim: periodo.fim, preset: periodo.preset } : null,
    moeda_custo: "BRL",
    casas: linhasCasa,
    jornadas: itens,
    truncado,
    totais_por_moeda: totaisPorMoeda(linhasCasa, (casa) => ({
      moeda: casa.moeda,
      valores: {
        jornadas: casa.jornadas,
        inscritos: casa.inscritos,
        enviados_sms: casa.periodo_resultados?.enviados_sms,
        custo_brl: casa.periodo_resultados?.custo_brl,
        cliques_humanos: casa.periodo_resultados?.cliques_humanos,
        conversoes_diretas: casa.periodo_resultados?.conversoes_diretas,
        receita_direta: casa.periodo_resultados?.receita_direta,
      },
    })),
    casas_com_erro: result.casas_com_erro,
  };
}
