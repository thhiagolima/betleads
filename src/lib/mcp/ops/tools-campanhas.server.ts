// MCP do grupo, área de operação: campanhas, jornadas and alertas (§5.7,
// §5.8, §5.9 of docs/superpowers/specs/2026-11-17-mcp-grupo-design.md).
// Contract in ./registry.server.ts: every tool resolves its houses through
// resolverEscopoOps (the only permission gate) and returns only aggregates.
// The work lives in ./campanhas.server.ts, ./jornadas.server.ts and
// ./alertas.server.ts (rules in ./alertas-regras.server.ts).
import { alertas, alertasInput } from "./alertas.server";
import { campanhas, campanhasInput } from "./campanhas.server";
import { jornadas, jornadasInput } from "./jornadas.server";
import type { OpsToolDef } from "./registry.server";

export const CAMPANHAS_TOOLS: OpsToolDef[] = [
  {
    name: "campanhas",
    title: "Campanhas por casa",
    description:
      "Campanhas de SMS, e-mail, voz e web push criadas OU agendadas no período, por casa. Cada campanha: casa, canal, id, nome, status (gravado, por canal), criada_em, agendada_em, total, enviados, falhas, expert_id (só SMS e e-mail) e `resultados` da Central de Resultados no período (custo_brl só para SMS, cliques_humanos, conversoes_diretas, receita_direta na moeda da casa) — null quando não há ligação (voz) ou a Central não tem linha da campanha no período. Lista mais nova primeiro, cortada em `limite` (`truncado`). `casas` traz o resumo por casa e canal; `totais_por_moeda` soma por moeda (custo_brl é sempre BRL); `casas_com_erro` lista casas que falharam.",
    inputSchema: campanhasInput,
    run: (identity, args) => campanhas(identity, args),
  },
  {
    name: "jornadas",
    title: "Jornadas por casa",
    description:
      "Jornadas (automações) por casa: id, nome, status (draft|active|paused|archived), gatilho, limite_diario, inscritos (total e por status), enviados_por_canal, concluiram_sem_mensagem e receita_recuperada (moeda da casa) desde o início da jornada. Com `periodo`, também `periodo_resultados` da Central de Resultados (enviados_sms, falhas_sms, custo_brl, cliques_humanos, conversoes_diretas, receita_direta), null sem dados. Lista cortada em `limite` (`truncado`), resumo por casa, totais_por_moeda e casas_com_erro.",
    inputSchema: jornadasInput,
    run: (identity, args) => jornadas(identity, args),
  },
  {
    name: "alertas",
    title: "Alertas da operação",
    description:
      "O que precisa de atenção agora nas casas do escopo: lista de {casa, tipo, gravidade (alta|media), mensagem, ref?}, ordenada por gravidade e casa. Tipos: casa_suspensa, casa_cancelada, bloqueio_cobranca, integracao_parada (sem cadastro e sem depósito ontem e hoje) — alta; saldo_zerado (alta) e saldo_baixo (media) quando o saldo da carteira (BRL) está abaixo do consumo médio diário de envios dos últimos 3 dias; campanha_com_falha (status de falha ou falhas > 20% do total, últimos 7 dias), jornada_sem_envio (ativa, enviava e não envia há 48 h), teto_expert (teto mensal atingido no mês) — media. `verificacoes_com_erro` lista verificações que falharam; as outras vêm normalmente.",
    inputSchema: alertasInput,
    run: (identity, args) => alertas(identity, args),
  },
];
