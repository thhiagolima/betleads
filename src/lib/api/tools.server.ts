// API de leitura: the read tools the API exposes (spec 2026-11-20 §5). The
// same functions as the MCP's read tools (same permission inside each one,
// same results), plus serie_diaria. Only read tools: the API never writes.
import { z } from "zod";

import type { McpArea, McpIdentity } from "@/lib/mcp/access.server";
import { OPS_TOOLS } from "@/lib/mcp/ops/registry.server";
import {
  listarEscopos,
  mesDaCasa,
  mesDaCasaInput,
  metasDaCasa,
  metasDaCasaInput,
  resumoFinanceiro,
  resumoFinanceiroInput,
  resumoPorDia,
  resumoPorDiaInput,
} from "@/lib/mcp/read-tools.server";

import { serieDiaria, serieDiariaInput } from "./serie-diaria.server";

const MONEY =
  " Dinheiro na moeda de cada casa (campo moeda); custos Betleads sempre em BRL; nunca há soma entre moedas.";

export type ApiTool = {
  name: string;
  title: string;
  description: string;
  /** null: every key may call it (listar_escopos). */
  area: McpArea | null;
  inputSchema: z.ZodObject;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool narrows its own args via inputSchema */
  run(identity: McpIdentity, args: any): Promise<unknown>;
};

const FINANCE_TOOLS: ApiTool[] = [
  {
    name: "resumo_financeiro",
    title: "Resumo financeiro",
    description:
      "Mesmo resultado do painel financeiro para uma casa, um grupo ou todas as casas: totais, linhas por casa, KPIs, dias pendentes e metas, com comparação opcional." +
      MONEY,
    area: "financeiro",
    inputSchema: resumoFinanceiroInput,
    run: (identity, args) => resumoFinanceiro(identity, args),
  },
  {
    name: "resumo_por_dia",
    title: "Resumo financeiro dia a dia",
    description:
      "resumo_financeiro quebrado por dia (até 31 dias): totais do dia e `atual` de cada casa. Para períodos longos, use serie_diaria." +
      MONEY,
    area: "financeiro",
    inputSchema: resumoPorDiaInput,
    run: (identity, args) => resumoPorDia(identity, args),
  },
  {
    name: "serie_diaria",
    title: "Série diária",
    description:
      "Uma linha por casa e por dia, até 366 dias: cadastros, FTDs, valores de FTD, depósito e saque, quantidade de depósitos, depositantes e saques, anúncios, GGR (com o GGR mensal repartido como no painel), net, taxas, se o dia está pendente, CRM do dia e custo de envios em BRL. Sem lucro líquido por dia (use resumo_financeiro)." +
      MONEY,
    area: "financeiro",
    inputSchema: serieDiariaInput,
    run: (identity, args) => serieDiaria(identity, args),
  },
  {
    name: "mes_da_casa",
    title: "Mês da casa",
    description:
      "Fechamento financeiro do mês de uma casa: dias lançados, outros custos, taxas em vigor, GGR do mês e pendências. casa: id da casa; mes: AAAA-MM." +
      MONEY,
    area: "financeiro",
    inputSchema: mesDaCasaInput,
    run: (identity, args) => mesDaCasa(identity, args),
  },
  {
    name: "metas_da_casa",
    title: "Metas da casa",
    description: "Metas diárias em vigor hoje para cada métrica da casa. casa: id da casa.",
    area: "financeiro",
    inputSchema: metasDaCasaInput,
    run: (identity, args) => metasDaCasa(identity, args),
  },
];

export const API_TOOLS: ApiTool[] = [
  {
    name: "listar_escopos",
    title: "Listar escopos",
    description:
      "Áreas liberadas, nível de acesso e os ids de casas e grupos que a chave pode consultar em cada área. Use os ids nas outras ferramentas.",
    area: null,
    inputSchema: z.object({}),
    run: (identity) => listarEscopos(identity),
  },
  ...FINANCE_TOOLS,
  ...OPS_TOOLS.map(
    (tool): ApiTool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      area: "operacao",
      inputSchema: tool.inputSchema,
      run: tool.run,
    }),
  ),
];

/** The tools a set of areas may call, in API_TOOLS order. */
export function toolsFor(areas: McpArea[]): ApiTool[] {
  return API_TOOLS.filter((tool) => tool.area === null || areas.includes(tool.area));
}
