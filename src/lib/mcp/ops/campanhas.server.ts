// MCP do grupo, área de operação: `campanhas` (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5.7). Campaigns of
// sms, email, voz and webpush created OR scheduled in the period, one house
// at a time (porCasa: a failing house goes to casas_com_erro), with the
// Central de Resultados numbers (crm_results_daily, source_type 'campaign',
// source_id = campaign id) of the same period. Where there is no link
// (voice, or a campaign with no Central row in the period) the results are
// null — never invented. See ./campanhas-data.server.ts for the verified
// column/link facts.
import { z } from "zod";

import type { McpIdentity } from "../access.server";
import {
  CANAIS,
  loadCampanhasCanal,
  loadResultadosCrm,
  type CampanhaBase,
  type Canal,
} from "./campanhas-data.server";
import {
  escopoOps,
  limiteInput,
  periodoOps,
  porCasa,
  toRange,
  totaisPorMoeda,
  truncar,
  type CasaComErro,
  type TotalPorMoeda,
} from "./runner.server";
import { resolverEscopoOps, type CasaOps } from "./scope.server";

export const campanhasInput = z.object({
  escopo: escopoOps,
  periodo: periodoOps,
  canal: z.enum(CANAIS).optional().describe("Só um canal: sms, email, voz ou webpush."),
  status: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Status gravado, exato. sms/webpush: agendada, enviando, enviado, falhou, cancelada, pausada (sms também aguardando_aprovacao, recusada); email: rascunho, agendada, enviando, enviado, pausada, cancelada, aguardando_aprovacao, recusada; voz: draft, scheduled, sending, paused, cancelled, finished.",
    ),
  limite: limiteInput,
});

/** Central de Resultados numbers of one campaign in the period. */
export type ResultadosCampanha = {
  /** BRL. Only SMS has cost in the Central; null for the other channels. */
  custo_brl: number | null;
  cliques_humanos: number;
  conversoes_diretas: number;
  /** In the house currency. */
  receita_direta: number;
};

export type CampanhaLinha = {
  casa: { id: string; nome: string; moeda: string };
  canal: Canal;
  id: string;
  nome: string;
  status: string;
  criada_em: string;
  agendada_em: string | null;
  total: number | null;
  enviados: number | null;
  falhas: number | null;
  expert_id: string | null;
  /** null: no link to the Central (voice) or no Central row in the period. */
  resultados: ResultadosCampanha | null;
};

export type ResumoCanal = {
  canal: Canal;
  campanhas: number;
  enviados: number;
  falhas: number;
  custo_brl: number | null;
  cliques_humanos: number | null;
  conversoes_diretas: number | null;
  receita_direta: number | null;
};

export type CampanhasCasa = {
  id: string;
  nome: string;
  moeda: string;
  grupo: string | null;
  campanhas: number;
  por_canal: ResumoCanal[];
  /** A channel hit the per-call row cap; its numbers are partial. */
  limite_atingido: boolean;
};

export type CampanhasResult = {
  rotulo: string;
  periodo: { inicio: string; fim: string; preset: string };
  moeda_custo: "BRL";
  casas: CampanhasCasa[];
  campanhas: CampanhaLinha[];
  truncado: boolean;
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A campaign row with its Central numbers (null when there is no link/row). */
export function comResultados(
  casa: CasaOps,
  campanha: CampanhaBase,
  crm: Map<
    string,
    { custo_brl: number; cliques: number; conversoes_diretas: number; receita_direta: number }
  >,
): CampanhaLinha {
  const linked = campanha.canal !== "voz";
  const found = linked ? crm.get(campanha.id) : undefined;
  return {
    casa: { id: casa.id, nome: casa.nome, moeda: casa.moeda },
    canal: campanha.canal,
    id: campanha.id,
    nome: campanha.nome,
    status: campanha.status,
    criada_em: campanha.criada_em,
    agendada_em: campanha.agendada_em,
    total: campanha.total,
    enviados: campanha.enviados,
    falhas: campanha.falhas,
    expert_id: campanha.expert_id,
    resultados: found
      ? {
          custo_brl: campanha.canal === "sms" ? found.custo_brl : null,
          cliques_humanos: found.cliques,
          conversoes_diretas: found.conversoes_diretas,
          receita_direta: found.receita_direta,
        }
      : null,
  };
}

const addNullable = (acc: number | null, value: number | null | undefined) =>
  value == null ? acc : round2((acc ?? 0) + value);

/** Per-channel summary of one house's campaign rows (channels with no campaign omitted). */
export function resumoPorCanal(linhas: CampanhaLinha[]): ResumoCanal[] {
  const byCanal = new Map<Canal, ResumoCanal>();
  for (const linha of linhas) {
    const acc = byCanal.get(linha.canal) ?? {
      canal: linha.canal,
      campanhas: 0,
      enviados: 0,
      falhas: 0,
      custo_brl: null,
      cliques_humanos: null,
      conversoes_diretas: null,
      receita_direta: null,
    };
    acc.campanhas += 1;
    acc.enviados += linha.enviados ?? 0;
    acc.falhas += linha.falhas ?? 0;
    acc.custo_brl = addNullable(acc.custo_brl, linha.resultados?.custo_brl);
    acc.cliques_humanos = addNullable(acc.cliques_humanos, linha.resultados?.cliques_humanos);
    acc.conversoes_diretas = addNullable(
      acc.conversoes_diretas,
      linha.resultados?.conversoes_diretas,
    );
    acc.receita_direta = addNullable(acc.receita_direta, linha.resultados?.receita_direta);
    byCanal.set(linha.canal, acc);
  }
  return CANAIS.flatMap((canal) => {
    const resumo = byCanal.get(canal);
    return resumo ? [resumo] : [];
  });
}

async function campanhasDaCasa(
  casa: CasaOps,
  canais: readonly Canal[],
  janela: { fromInstant: string; toInstant: string; inicio: string; fim: string },
  status: string | undefined,
) {
  const porCanal = await Promise.all(
    canais.map((canal) => loadCampanhasCanal(canal, [casa.id], janela, status)),
  );
  const base = porCanal.flatMap((entry) => entry.campanhas);
  const linked = base.filter((c) => c.canal !== "voz").map((c) => c.id);
  const crm = linked.length
    ? await loadResultadosCrm(casa.id, "campaign", linked, janela.inicio, janela.fim)
    : new Map();
  return {
    linhas: base.map((campanha) => comResultados(casa, campanha, crm)),
    limite_atingido: porCanal.some((entry) => entry.limite_atingido),
  };
}

/**
 * `campanhas` (§5.7): campaign list (newest first, cut at `limite`), a
 * summary per house and channel, totals per currency (never across
 * currencies; custo_brl is always BRL) and casas_com_erro.
 */
export async function campanhas(
  identity: McpIdentity,
  args: z.input<typeof campanhasInput>,
  now: Date = new Date(),
): Promise<CampanhasResult> {
  const data = campanhasInput.parse(args);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, data.escopo);
  const periodo = toRange(data.periodo, now);
  const canais = data.canal ? [data.canal] : CANAIS;

  const result = await porCasa(casas, (casa) =>
    campanhasDaCasa(casa, canais, periodo, data.status),
  );

  const linhasCasa: CampanhasCasa[] = result.ok.map(({ casa, resultado }) => ({
    id: casa.id,
    nome: casa.nome,
    moeda: casa.moeda,
    grupo: casa.grupo?.nome ?? null,
    campanhas: resultado.linhas.length,
    por_canal: resumoPorCanal(resultado.linhas),
    limite_atingido: resultado.limite_atingido,
  }));
  const todas = result.ok
    .flatMap(({ resultado }) => resultado.linhas)
    .sort((a, b) => b.criada_em.localeCompare(a.criada_em));
  const { itens, truncado } = truncar(todas, data.limite);

  return {
    rotulo,
    periodo: { inicio: periodo.inicio, fim: periodo.fim, preset: periodo.preset },
    moeda_custo: "BRL",
    casas: linhasCasa,
    campanhas: itens,
    truncado,
    totais_por_moeda: totaisPorMoeda(linhasCasa, (casa) => {
      const sum = (pick: (r: ResumoCanal) => number | null) =>
        casa.por_canal.reduce<number | null>((acc, r) => addNullable(acc, pick(r)), null);
      return {
        moeda: casa.moeda,
        valores: {
          campanhas: casa.campanhas,
          enviados: sum((r) => r.enviados),
          falhas: sum((r) => r.falhas),
          custo_brl: sum((r) => r.custo_brl),
          cliques_humanos: sum((r) => r.cliques_humanos),
          conversoes_diretas: sum((r) => r.conversoes_diretas),
          receita_direta: sum((r) => r.receita_direta),
        },
      };
    }),
    casas_com_erro: result.casas_com_erro,
  };
}
