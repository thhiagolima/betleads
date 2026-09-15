// Detectores puros (server-only) para os gatilhos do sistema.
// Reutiliza a lógica já existente em player-rules.ts e replica os filtros
// de segmento usados na página /players.
import { detectAlerts, type AlertaTipo, type PlayerLike } from "./player-rules";
import { daysSinceActivity, lastActivityMs } from "./player-activity";

export type TriggerType =
  | "lead_cadastrado"
  | "recuperacao_vip"
  | "vip_esfriando"
  | "receita_em_queda"
  | "lead_quente_esfriando"
  | "quase_vip"
  | "alto_potencial"
  | "reativacao_em_curso"
  | "dinheiro_parado"
  | "engajado_sem_converter"
  | "frequencia_caindo"
  // Segmentos da página /players (mesma regra de entrada e saída).
  | "cadastrados_sem_deposito"
  | "sem_login_7_14"
  | "sem_login_15_24"
  | "sem_login_25_34"
  | "sem_login_35_44"
  | "sem_login_45_59"
  | "sem_login_60_mais"
  | "cashback_pago";

// Mapeia o nome interno do gatilho (somente os baseados em alerta) para o
// AlertaTipo correspondente em player-rules. Gatilhos de segmento são
// avaliados separadamente em `matchesSegmentTrigger`.
const TRIGGER_TO_ALERTA: Partial<Record<TriggerType, AlertaTipo>> = {
  recuperacao_vip: "abandono_vip",
  vip_esfriando: "vip_sem_atividade",
  receita_em_queda: "queda_depositos",
  lead_quente_esfriando: "lead_quente_esfriando",
  quase_vip: "proximo_vip",
  alto_potencial: "alto_potencial",
  reativacao_em_curso: "player_reativado",
  dinheiro_parado: "saldo_parado",
  engajado_sem_converter: "login_sem_deposito",
  frequencia_caindo: "frequencia_caindo",
};

export const TRIGGER_NAMES: Record<TriggerType, string> = {
  lead_cadastrado: "Lead cadastrado",
  recuperacao_vip: "Recuperação VIP",
  vip_esfriando: "VIP esfriando",
  receita_em_queda: "Receita em queda",
  lead_quente_esfriando: "Lead quente esfriando",
  quase_vip: "Quase VIP",
  alto_potencial: "Alto potencial",
  reativacao_em_curso: "Reativação em curso",
  dinheiro_parado: "Dinheiro parado",
  engajado_sem_converter: "Engajado sem converter",
  frequencia_caindo: "Frequência de queda",
  cadastrados_sem_deposito: "Cadastrados sem depósito",
  sem_login_7_14: "7 a 14 dias sem login",
  sem_login_15_24: "15 a 24 dias sem login",
  sem_login_25_34: "25 a 34 dias sem login",
  sem_login_35_44: "35 a 44 dias sem login",
  sem_login_45_59: "45 a 59 dias sem login",
  sem_login_60_mais: "60+ dias sem login",
  cashback_pago: "Cashback pago",
};

export const TRIGGER_MEANINGS: Record<TriggerType, string> = {
  lead_cadastrado: "Lead recém-cadastrado pelo link do expert (CRM Expert)",
  recuperacao_vip: "VIP sem login há 7+ dias",
  vip_esfriando: "VIP sem jogar há 2+ dias",
  receita_em_queda: "Depósitos caíram 50%+ vs período anterior (antes ≥ R$ 200)",
  lead_quente_esfriando: "Depositava 5+ dias seguidos e parou há 3–7 dias",
  quase_vip: "Total depositado entre R$ 800 e R$ 999",
  alto_potencial: "10+ logins, depósitos crescendo e login recente",
  reativacao_em_curso: "Voltou a depositar após 14+ dias parado",
  dinheiro_parado: "Saldo ≥ R$ 50 e sem jogar há 5+ dias",
  engajado_sem_converter: "8+ logins em 30 dias e sem depósito há 14+ dias",
  frequencia_caindo: "Frequência de login caiu 50%+",
  cadastrados_sem_deposito: "Cadastrou e nunca fez o primeiro depósito (sai ao depositar)",
  sem_login_7_14: "Último login entre 7 e 14 dias atrás (sai ao logar)",
  sem_login_15_24: "Último login entre 15 e 24 dias atrás (sai ao logar)",
  sem_login_25_34: "Último login entre 25 e 34 dias atrás (sai ao logar)",
  sem_login_35_44: "Último login entre 35 e 44 dias atrás (sai ao logar)",
  sem_login_45_59: "Último login entre 45 e 59 dias atrás (sai ao logar)",
  sem_login_60_mais: "Sem login há 60+ dias (sai ao logar)",
  cashback_pago: "Player recebeu cashback hoje (via webhook)",
};

// ------------------------------------------------------------------
// Gatilhos de segmento (espelham os filtros da página /players).
// Entrada e saída são determinadas naturalmente pelo predicado: assim que
// o player deixa de bater no segmento (ex.: fez login, depositou pela
// primeira vez), ele sai do fluxo no próximo ciclo do dispatcher.
// ------------------------------------------------------------------
// Janela de inatividade: o player ficou sem QUALQUER atividade (login OU
// jogo OU depósito) por `minDays`, e a última atividade ainda está dentro
// de `maxDays` (quando definido). Mantém o comportamento anterior de
// excluir players sem nenhuma atividade registrada (lastActivityMs === 0).
function inInactivityWindow(p: PlayerLike, minDays: number, maxDays: number | null): boolean {
  if (lastActivityMs(p) === 0) return false;
  // Regra do BetLeads: gatilhos "X dias sem login" só valem para leads que
  // já depositaram ao menos uma vez (FTD). Quem nunca depositou cai no
  // gatilho "cadastrados_sem_deposito".
  if (!p.ftd_em) return false;
  const dias = daysSinceActivity(p);
  if (dias < minDays) return false;
  if (maxDays !== null && dias > maxDays) return false;
  return true;
}

function matchesSegmentTrigger(p: PlayerLike, trigger: TriggerType): boolean {
  switch (trigger) {
    case "cadastrados_sem_deposito":
      return !p.ftd_em;
    case "sem_login_7_14":
      return inInactivityWindow(p, 7, 14);
    case "sem_login_15_24":
      return inInactivityWindow(p, 15, 24);
    case "sem_login_25_34":
      return inInactivityWindow(p, 25, 34);
    case "sem_login_35_44":
      return inInactivityWindow(p, 35, 44);
    case "sem_login_45_59":
      return inInactivityWindow(p, 45, 59);
    case "sem_login_60_mais":
      return inInactivityWindow(p, 60, null);
    case "cashback_pago": {
      // Recebeu cashback "hoje" no fuso BRT (America/Sao_Paulo).
      const v = p.last_cashback_paid_at;
      if (!v) return false;
      const paid = new Date(v).getTime();
      if (Number.isNaN(paid)) return false;
      // início do dia BRT em UTC: BRT = UTC-3
      const now = new Date();
      const brt = new Date(now.getTime() - 3 * 3600 * 1000);
      const y = brt.getUTCFullYear(), m = brt.getUTCMonth(), d = brt.getUTCDate();
      const startBrtUtc = Date.UTC(y, m, d) + 3 * 3600 * 1000;
      return paid >= startBrtUtc;
    }
    default:
      return false;
  }
}

const SEGMENT_TRIGGERS: TriggerType[] = [
  "cadastrados_sem_deposito",
  "sem_login_7_14",
  "sem_login_15_24",
  "sem_login_25_34",
  "sem_login_35_44",
  "sem_login_45_59",
  "sem_login_60_mais",
  "cashback_pago",
];

/** Roda detectAlerts + segmentos e devolve quais TriggerTypes estão ativos. */
export function detectTriggersForPlayer(p: PlayerLike): TriggerType[] {
  const alerts = detectAlerts(p);
  const set = new Set<AlertaTipo>(alerts.map((a) => a.tipo));
  const fromAlerts = (Object.keys(TRIGGER_TO_ALERTA) as TriggerType[]).filter((t) => {
    const a = TRIGGER_TO_ALERTA[t];
    return a ? set.has(a) : false;
  });
  const fromSegments = SEGMENT_TRIGGERS.filter((t) => matchesSegmentTrigger(p, t));
  return [...fromAlerts, ...fromSegments];
}

export function matchesTrigger(p: PlayerLike, trigger: TriggerType): boolean {
  return detectTriggersForPlayer(p).includes(trigger);
}
