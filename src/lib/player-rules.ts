// Regras de negócio compartilhadas para classificação, scores e alertas.
// Puro TS, sem dependências — usado no frontend (Alertas, Dashboard, PlayerCard).

export type Classificacao =
  | "vip"
  | "lead_quente"
  | "lead_frio"
  | "alto_potencial"
  | "em_risco"
  | "neutro";

export type Prioridade = "critico" | "alto" | "medio" | "baixo";

export type AlertaTipo =
  | "abandono_vip"
  | "vip_sem_atividade"
  | "queda_depositos"
  | "lead_quente_esfriando"
  | "proximo_vip"
  | "alto_potencial"
  | "player_reativado"
  | "sequencia_depositos"
  | "padrao_horario"
  | "saldo_parado"
  | "login_sem_deposito"
  | "frequencia_caindo";

export type AcaoRecomendada =
  | "whatsapp"
  | "sms"
  | "bonus"
  | "campanha"
  | "acompanhamento"
  | "copiar";

export type Alerta = {
  tipo: AlertaTipo;
  titulo: string;
  prioridade: Prioridade;
  motivo: string;
  impacto: string;
  acaoRecomendada: AcaoRecomendada;
  acaoLabel: string;
};

export type Abordagem =
  | "Conversa leve"
  | "Reativação VIP"
  | "Chamada de oportunidade"
  | "Oferta exclusiva"
  | "Recuperação emocional"
  | "Chamada operacional"
  | "Cashback estratégico"
  | "Reengajamento suave"
  | "Acompanhamento próximo";

export const ABORDAGEM_POR_TIPO: Record<AlertaTipo, Abordagem> = {
  abandono_vip: "Reativação VIP",
  vip_sem_atividade: "Conversa leve",
  queda_depositos: "Chamada de oportunidade",
  lead_quente_esfriando: "Reengajamento suave",
  proximo_vip: "Oferta exclusiva",
  alto_potencial: "Chamada de oportunidade",
  player_reativado: "Recuperação emocional",
  sequencia_depositos: "Acompanhamento próximo",
  padrao_horario: "Chamada operacional",
  saldo_parado: "Cashback estratégico",
  login_sem_deposito: "Oferta exclusiva",
  frequencia_caindo: "Reengajamento suave",
};

export type PlayerLike = {
  id?: string;
  nome?: string;
  telefone?: string | null;
  status?: string | null;
  vip?: boolean | null;
  total_depositado?: number | null;
  total_sacado?: number | null;
  saldo_carteira?: number | null;
  ultimo_login?: string | null;
  ultimo_jogo?: string | null;
  ultimo_deposito?: string | null;
  created_at?: string | null;
  ftd_em?: string | null;
  expert?: string | null;
  origem?: string | null;
  utm_source?: string | null;
  // métricas derivadas opcionais
  dep_30d?: number;
  dep_30_60d?: number;
  dep_7d?: number;
  dep_7_14d?: number;
  dias_seguidos_depositando?: number;
  media_deposito?: number;
  saques_recentes?: number;
  qtd_logins_30d?: number;
  qtd_logins_30_60d?: number;
  reativado_em?: string | null;     // data do primeiro depósito após gap >=14d (se houver nos últimos 30d)
  horario_pico?: number | null;      // hora do dia mais comum nas sessions (0–23)
  // Cashback (alimentado pelo webhook `cashback-pago`)
  last_cashback_paid_at?: string | null;
  last_cashback_amount?: number | null;
  total_cashback_paid?: number | null;
};

function daysSince(iso?: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / 86400000);
}

// "Última atividade" = mais recente entre login, jogo e depósito. Usado em
// vez de `daysSince(ultimo_login)` para que classificações/alertas/scores
// reflitam atividade real do player (e não dependam do evento `login`
// vir do operador).
function daysSinceLastActivity(p: PlayerLike): number {
  const t = (s?: string | null) => {
    if (!s) return 0;
    const v = new Date(s).getTime();
    return Number.isNaN(v) ? 0 : v;
  };
  const ms = Math.max(t(p.ultimo_login), t(p.ultimo_jogo), t(p.ultimo_deposito));
  if (!ms) return Infinity;
  return Math.max(0, (Date.now() - ms) / 86400000);
}

export function classify(p: PlayerLike): Classificacao {
  const dep = Number(p.total_depositado ?? 0);
  const diasLogin = daysSinceLastActivity(p);
  const diasSeg = p.dias_seguidos_depositando ?? 0;
  const media = p.media_deposito ?? 0;
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;

  if (p.vip || dep >= 1000) return "vip";
  if (diasSeg >= 7 && media >= 200) return "lead_quente";
  if (diasLogin > 15 && dep < 150) return "lead_frio";
  if (diasLogin > 5 || (dep3060 > 0 && dep30 < dep3060 * 0.5))
    return "em_risco";
  if (logins30 >= 10 && dep30 > dep3060 && diasLogin <= 2) return "alto_potencial";
  return "neutro";
}

/**
 * Decide se o player merece estar na fila de alertas.
 * Filtra ruído: leads sem histórico, sem valor e sem comportamento relevante.
 */
export function isRelevante(p: PlayerLike): boolean {
  const dep = Number(p.total_depositado ?? 0);
  const saq = Number(p.total_sacado ?? 0);
  const lucro = dep - saq;
  const logins30 = p.qtd_logins_30d ?? 0;
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const seg = p.dias_seguidos_depositando ?? 0;

  if (p.vip || dep >= 1000) return true;          // VIP
  if (logins30 >= 10 && dep30 >= dep3060 * 0.7) return true; // alto potencial
  if (seg >= 5) return true;                       // lead quente / recorrente
  if (lucro >= 300) return true;                   // lucrativo
  if (dep30 > 0 && dep3060 > 0) return true;       // recorrente nos últimos 60d
  return false;
}

// Score 0–100: frequência + retenção + depósitos + crescimento + consistência.
export function playerScore(p: PlayerLike): number {
  const dep = Number(p.total_depositado ?? 0);
  const diasLogin = daysSinceLastActivity(p);
  const diasJogo = daysSince(p.ultimo_jogo);
  const diasDep = daysSince(p.ultimo_deposito);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;
  const seg = p.dias_seguidos_depositando ?? 0;

  // frequência (0-25): logins recentes
  const freq = Math.min(25, logins30 * 1.5);
  // retenção (0-20): quanto mais recente o último login, melhor
  const ret =
    diasLogin <= 1 ? 20 : diasLogin <= 3 ? 16 : diasLogin <= 7 ? 12
      : diasLogin <= 15 ? 6 : 0;
  // depósitos histórico (0-20): log-scale até R$2000
  const depScore = Math.min(20, Math.log10(Math.max(1, dep)) * 6);
  // crescimento (0-20): dep30 vs dep30_60
  let cresc = 0;
  if (dep3060 > 0) {
    const ratio = dep30 / dep3060;
    cresc = Math.max(0, Math.min(20, (ratio - 0.5) * 20));
  } else if (dep30 > 0) {
    cresc = 12;
  }
  // consistência (0-15): dias seguidos depositando + atividade de jogo
  const cons = Math.min(15, seg * 1.5 + (diasJogo <= 3 ? 5 : 0));

  const total = freq + ret + depScore + cresc + cons;
  // penalidade leve por inatividade extrema
  const penalty = diasDep > 30 ? 10 : 0;
  return Math.max(0, Math.min(100, Math.round(total - penalty)));
}

// ----- Scores especializados (0–100) -----

/** Retention Score: quão fiel/ativo o player é. Alto = bom. */
export function retentionScore(p: PlayerLike): number {
  const diasLogin = daysSinceLastActivity(p);
  const diasJogo = daysSince(p.ultimo_jogo);
  const logins30 = p.qtd_logins_30d ?? 0;
  const seg = p.dias_seguidos_depositando ?? 0;

  const recencia =
    diasLogin <= 1 ? 35 : diasLogin <= 3 ? 28 : diasLogin <= 7 ? 18
      : diasLogin <= 15 ? 8 : 0;
  const freq = Math.min(30, logins30 * 2);
  const consist = Math.min(25, seg * 3);
  const jogo = diasJogo <= 3 ? 10 : diasJogo <= 7 ? 5 : 0;
  return clamp01(recencia + freq + consist + jogo);
}

/** Conversion Score: oportunidade real de receita extra agora. Alto = monetizável. */
export function conversionScore(p: PlayerLike): number {
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;
  const diasDep = daysSince(p.ultimo_deposito);
  const saldo = Number(p.saldo_carteira ?? 0);
  const dep = Number(p.total_depositado ?? 0);

  // tendência de depósito
  let tend = 0;
  if (dep3060 > 0) {
    const ratio = dep30 / dep3060;
    tend = Math.max(0, Math.min(30, ratio * 25));
  } else if (dep30 > 0) tend = 20;

  // logando muito mas sem depositar = pronto para conversão
  const oportunidade = logins30 >= 8 && diasDep > 10 ? 25 : logins30 >= 5 ? 12 : 0;
  const saldoParado = saldo >= 200 ? 15 : saldo >= 50 ? 7 : 0;
  const valorBase = Math.min(30, Math.log10(Math.max(1, dep)) * 9);
  return clamp01(tend + oportunidade + saldoParado + valorBase);
}

/** Risk Score: chance de abandono / churn. Alto = perigo. */
export function riskScore(p: PlayerLike): number {
  const diasLogin = daysSinceLastActivity(p);
  const diasDep = daysSince(p.ultimo_deposito);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const saqRec = p.saques_recentes ?? 0;
  const dep = Number(p.total_depositado ?? 0);
  const vipBoost = (p.vip || dep >= 1000) ? 10 : 0;

  const inativ =
    diasLogin > 30 ? 35 : diasLogin > 15 ? 28 : diasLogin > 7 ? 18
      : diasLogin > 3 ? 8 : 0;
  const semDep = diasDep > 30 ? 20 : diasDep > 14 ? 12 : diasDep > 7 ? 6 : 0;
  let queda = 0;
  if (dep3060 > 0) {
    const ratio = dep30 / dep3060;
    if (ratio < 0.3) queda = 25;
    else if (ratio < 0.5) queda = 18;
    else if (ratio < 0.7) queda = 10;
  }
  const saque = saqRec >= 1000 ? 15 : saqRec >= 500 ? 8 : 0;
  return clamp01(inativ + semDep + queda + saque + vipBoost);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function detectAlerts(p: PlayerLike): Alerta[] {
  const out: Alerta[] = [];
  const dep = Number(p.total_depositado ?? 0);
  const saq = Number(p.total_sacado ?? 0);
  const diasLogin = daysSinceLastActivity(p);
  const diasJogo = daysSince(p.ultimo_jogo);
  const diasDep = daysSince(p.ultimo_deposito);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;
  const logins3060 = p.qtd_logins_30_60d ?? 0;
  const saldo = Number(p.saldo_carteira ?? 0);
  const seg = p.dias_seguidos_depositando ?? 0;
  const isVip = !!p.vip || dep >= 1000;

  // 1. Possível abandono VIP
  if (isVip && diasLogin > 7) {
    out.push({
      tipo: "abandono_vip",
      titulo: "VIP recuperável",
      prioridade: "critico",
      motivo: `VIP sem login há ${Math.floor(diasLogin)} dias. Total depositado: ${formatBRL(dep)}.`,
      impacto:
        "VIPs concentram a maior parte da receita. Cada dia sem contato aumenta a chance de migração para a concorrência.",
      acaoRecomendada: "whatsapp",
      acaoLabel: "Falar no WhatsApp agora",
    });
  } else if (isVip && diasJogo >= 2) {
    // 12. VIP sem atividade recente
    out.push({
      tipo: "vip_sem_atividade",
      titulo: "VIP esfriando",
      prioridade: "alto",
      motivo: `VIP sem jogar há ${Math.floor(diasJogo)} dias.`,
      impacto:
        "Janela ideal para reengajar antes que o player desacelere de vez. Ainda fácil de recuperar.",
      acaoRecomendada: "whatsapp",
      acaoLabel: "Enviar WhatsApp",
    });
  }

  // 3. Queda brusca de depósitos
  if (dep3060 > 0 && dep30 < dep3060 * 0.5 && dep3060 >= 200) {
    out.push({
      tipo: "queda_depositos",
      titulo: "Receita em queda — recuperar agora",
      prioridade: isVip ? "critico" : "alto",
      motivo: `Depositou apenas ${formatBRL(dep30)} nos últimos 30 dias, contra ${formatBRL(dep3060)} nos 30 dias anteriores (queda de mais de 50%).`,
      impacto:
        "Queda dessa magnitude costuma indicar desengajamento, problema com a plataforma ou migração para a concorrência.",
      acaoRecomendada: "whatsapp",
      acaoLabel: "Contato direto",
    });
  } else {
    // Fallback (quando ainda não há histórico de 30-60d): compara últimos 7d vs 7-14d
    const dep7 = p.dep_7d ?? 0;
    const dep714 = p.dep_7_14d ?? 0;
    if (dep714 >= 100 && dep7 < dep714 * 0.5) {
      out.push({
        tipo: "queda_depositos",
        titulo: "Receita em queda — recuperar agora",
        prioridade: isVip ? "critico" : "alto",
        motivo: `Depositou apenas ${formatBRL(dep7)} nos últimos 7 dias, contra ${formatBRL(dep714)} nos 7 dias anteriores (queda de mais de 50%).`,
        impacto:
          "Queda recente costuma indicar desengajamento, problema com a plataforma ou migração para a concorrência.",
        acaoRecomendada: "whatsapp",
        acaoLabel: "Contato direto",
      });
    }
  }

  // 2. Lead quente esfriando
  if (seg >= 5 && diasLogin >= 3 && diasLogin <= 7) {
    out.push({
      tipo: "lead_quente_esfriando",
      titulo: "Lead quente esfriando — janela de retorno",
      prioridade: "alto",
      motivo: `Vinha depositando ${seg} dias seguidos e parou há ${Math.floor(diasLogin)} dias.`,
      impacto:
        "Sequência quebrada na fase mais lucrativa. Reativar agora costuma render mais que captar um lead novo.",
      acaoRecomendada: "bonus",
      acaoLabel: "Oferecer bônus",
    });
  }

  // 4. Próximo de virar VIP
  if (dep >= 800 && dep < 1000 && !p.vip) {
    out.push({
      tipo: "proximo_vip",
      titulo: "Quase VIP — oportunidade de upgrade",
      prioridade: "medio",
      motivo: `Já depositou ${formatBRL(dep)}. Faltam apenas ${formatBRL(1000 - dep)} para atingir o status VIP.`,
      impacto:
        "Player a um passo de virar VIP — converter agora aumenta retenção e LTV de forma significativa.",
      acaoRecomendada: "bonus",
      acaoLabel: "Oferecer bônus de upgrade",
    });
  }

  // 5. Alto potencial detectado
  if (logins30 >= 10 && dep30 > dep3060 && diasLogin <= 2 && !isVip) {
    out.push({
      tipo: "alto_potencial",
      titulo: "Alto potencial — acelerar agora",
      prioridade: "medio",
      motivo: `${logins30} logins nos últimos 30 dias e crescimento de depósito (${formatBRL(dep30)} vs ${formatBRL(dep3060)}).`,
      impacto:
        "Player em curva ascendente. Investir em acompanhamento agora aumenta a chance dele virar VIP.",
      acaoRecomendada: "campanha",
      acaoLabel: "Adicionar em campanha",
    });
  }

  // 6. Player reativado
  if (p.reativado_em) {
    const dias = Math.floor(daysSince(p.reativado_em));
    if (dias <= 7) {
      out.push({
        tipo: "player_reativado",
        titulo: "Reativação em curso — reforçar",
        prioridade: "medio",
        motivo: `Voltou a depositar há ${dias === 0 ? "menos de 1" : dias} dia(s) após um período longo parado.`,
        impacto:
          "Momento crítico de retenção pós-reativação. Sem reforço positivo, costuma sumir de novo em 7–10 dias.",
        acaoRecomendada: "whatsapp",
        acaoLabel: "Mensagem de boas-vindas",
      });
    }
  }

  // 7. Sequência forte de depósitos
  if (seg >= 5 && diasLogin <= 2) {
    out.push({
      tipo: "sequencia_depositos",
      titulo: "Player em momento quente",
      prioridade: "baixo",
      motivo: `${seg} dias seguidos depositando — em ritmo acelerado.`,
      impacto:
        "Player em momento quente. Acompanhar de perto e evitar fricção pode multiplicar o LTV.",
      acaoRecomendada: "acompanhamento",
      acaoLabel: "Marcar acompanhamento",
    });
  }

  // 8. Padrão de horário detectado
  if (p.horario_pico !== null && p.horario_pico !== undefined && logins30 >= 8) {
    const h = p.horario_pico;
    const faixa =
      h >= 6 && h < 12 ? "manhã" : h >= 12 && h < 18 ? "tarde"
        : h >= 18 && h < 24 ? "noite" : "madrugada";
    out.push({
      tipo: "padrao_horario",
      titulo: "Janela ideal de contato",
      prioridade: "baixo",
      motivo: `Costuma jogar à ${faixa} (pico às ${String(h).padStart(2, "0")}h).`,
      impacto:
        "Comunicação enviada na janela certa tem taxa de resposta significativamente maior.",
      acaoRecomendada: "campanha",
      acaoLabel: "Agendar campanha no horário",
    });
  }

  // 9. Saldo parado
  if (saldo >= 50 && diasJogo > 2) {
    const prio: Prioridade = saldo >= 500 ? "critico" : saldo >= 200 ? "alto" : "medio";
    out.push({
      tipo: "saldo_parado",
      titulo: "Dinheiro parado — oportunidade",
      prioridade: prio,
      motivo: `${formatBRL(saldo)} parado em conta há ${Math.floor(diasJogo)} dias sem jogar.`,
      impacto:
        "Saldo parado costuma virar pedido de saque. Reengajar agora preserva esse valor dentro da operação.",
      acaoRecomendada: "whatsapp",
      acaoLabel: "Estimular jogo",
    });
  }

  // 10. Muito login sem depósito
  if (logins30 >= 8 && diasDep > 14 && dep > 0) {
    out.push({
      tipo: "login_sem_deposito",
      titulo: "Engajado sem converter",
      prioridade: "medio",
      motivo: `${logins30} logins nos últimos 30 dias, mas sem depositar há ${Math.floor(diasDep)} dias.`,
      impacto:
        "Player engajado mas sem converter. Pequeno empurrão (bônus, missão) costuma destravar nova rodada de depósitos.",
      acaoRecomendada: "bonus",
      acaoLabel: "Oferecer bônus",
    });
  }

  // 11. Frequência caindo
  if (logins3060 > 0 && logins30 < logins3060 * 0.5 && logins3060 >= 5) {
    out.push({
      tipo: "frequencia_caindo",
      titulo: "Frequência caindo — chance de retorno",
      prioridade: isVip ? "alto" : "medio",
      motivo: `${logins30} logins nos últimos 30 dias, contra ${logins3060} no período anterior.`,
      impacto:
        "Curva descendente de engajamento. Sem intervenção, vira churn em algumas semanas.",
      acaoRecomendada: "campanha",
      acaoLabel: "Adicionar em campanha de reativação",
    });
  }

  // pequeno uso de saq para evitar warning (saques altos já influenciam o riskScore)
  void saq;

  return out;
}

export function priorityColor(p: Prioridade): {
  text: string;
  bg: string;
  border: string;
  badge: string;
} {
  if (p === "critico")
    return {
      text: "text-rose-400",
      bg: "bg-rose-500/10",
      border: "border-rose-500/40",
      badge: "bg-rose-500/20 text-rose-300 border-rose-500/50",
    };
  if (p === "alto")
    return {
      text: "text-orange-400",
      bg: "bg-orange-500/10",
      border: "border-orange-500/30",
      badge: "bg-orange-500/15 text-orange-300 border-orange-500/40",
    };
  if (p === "medio")
    return {
      text: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/30",
      badge: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    };
  return {
    text: "text-sky-400",
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  };
}

export const PRIORIDADE_LABEL: Record<Prioridade, string> = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
};

export function prioridadeRank(p: Prioridade): number {
  return p === "critico" ? 0 : p === "alto" ? 1 : p === "medio" ? 2 : 3;
}

export function topPrioridade(alertas: Alerta[]): Prioridade {
  return alertas.reduce<Prioridade>((acc, a) =>
    prioridadeRank(a.prioridade) < prioridadeRank(acc) ? a.prioridade : acc,
    "baixo",
  );
}

export const CLASSIFICACAO_LABEL: Record<Classificacao, string> = {
  vip: "VIP",
  lead_quente: "Lead Quente",
  lead_frio: "Lead Frio",
  alto_potencial: "Alto Potencial",
  em_risco: "Em Risco",
  neutro: "Neutro",
};

/** Backwards-compat: mapeia classificação para prioridade operacional. */
export function classificacaoPrioridade(c: Classificacao): Prioridade {
  if (c === "em_risco") return "alto";
  if (c === "lead_frio") return "medio";
  if (c === "vip" || c === "lead_quente" || c === "alto_potencial") return "baixo";
  return "baixo";
}

function formatBRL(n: number) {
  return (n ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

export function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 40) return "text-amber-400";
  return "text-rose-400";
}

/** Cor para Risk Score (invertida: alto = vermelho) */
export function riskColor(score: number): string {
  if (score >= 70) return "text-rose-400";
  if (score >= 40) return "text-amber-400";
  return "text-emerald-400";
}

/** Gera uma mensagem de WhatsApp pré-pronta para o tipo de alerta. */
export function whatsappMessageFor(a: Alerta, p: PlayerLike): string {
  const nome = (p.nome ?? "").split(" ")[0] || "tudo bem";
  const base = `Oi ${nome}! Tudo certo? `;
  const saldo = Number(p.saldo_carteira ?? 0);
  const saldoTxt = saldo > 0 ? ` Vi aqui que você tem ${formatBRL(saldo)} em saldo esperando.` : "";
  switch (a.tipo) {
    case "abandono_vip":
    case "vip_sem_atividade":
      return base + "Senti sua falta por aqui. Como VIP, separei um benefício exclusivo pra te receber de volta." + saldoTxt + " Posso te mandar agora?";
    case "queda_depositos":
      return base + "Notei que você sumiu um pouco. Tá tudo certo com a plataforma? Se precisar de algo, é só me chamar.";
    case "lead_quente_esfriando":
      return base + "Vi que você estava bem ativo e acabou pausando. Tenho um bônus pronto pra te dar aquele empurrão. Quer aproveitar?";
    case "proximo_vip":
      return base + "Você está a um passo de virar VIP e desbloquear benefícios exclusivos. Posso te ajudar com um bônus pra completar?";
    case "alto_potencial":
      return base + "Quero te dar uma atenção especial. Topa receber novidades e bônus exclusivos antes de todo mundo?";
    case "player_reativado":
      return base + "Que bom te ver de volta! Pra comemorar, tenho uma surpresa pronta pra você. Posso enviar?";
    case "sequencia_depositos":
      return base + "Tá num momento bom! Qualquer coisa que precisar, é só falar comigo direto.";
    case "padrao_horario":
      return base + "Tenho uma promoção que combina perfeito com seu horário de jogo. Quer dar uma olhada?";
    case "saldo_parado":
      return base + `Vi que tem ${formatBRL(saldo)} na sua conta te esperando. Posso te mostrar os jogos que estão pagando bem agora pra você aproveitar?`;
    case "login_sem_deposito":
      return base + "Vi você por aqui mas sem aquela rodada gostosa. Posso liberar um bônus pra você jogar hoje?";
    case "frequencia_caindo":
      return base + "Faz um tempo que a gente não conversa direito. Quer que eu te mostre o que tem de novo?";
    default:
      return base + "Tudo certo? Qualquer coisa, estou por aqui.";
  }
}

export function buildWhatsAppLink(p: PlayerLike, a: Alerta): string | null {
  if (!p.telefone) return null;
  const digits = p.telefone.replace(/\D/g, "");
  if (!digits) return null;
  const msg = encodeURIComponent(whatsappMessageFor(a, p));
  return `https://wa.me/${digits}?text=${msg}`;
}

/**
 * Estimativa de receita potencialmente recuperável (faixa min–max em BRL).
 * Considera ticket médio, frequência anterior, histórico recente e tipo de player.
 */
export function recoveryPotential(p: PlayerLike): { min: number; max: number } {
  const dep = Number(p.total_depositado ?? 0);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const media = p.media_deposito ?? 0;
  const saldo = Number(p.saldo_carteira ?? 0);
  const isVip = !!p.vip || dep >= 1000;

  // baseline mensal esperado: maior entre histórico anterior, ticket * 4 e fração do total
  const baselineHist = Math.max(dep3060, dep30);
  const baselineTicket = media * 4;
  const baselineTotal = dep * 0.08; // ~8% do LTV num mês
  let baseline = Math.max(baselineHist, baselineTicket, baselineTotal, 100);

  // VIPs costumam responder com tickets maiores
  if (isVip) baseline = Math.max(baseline, 500);

  // saldo parado é receita já dentro da casa — soma direto no piso
  const min = Math.round((baseline * 0.4 + saldo * 0.5) / 50) * 50;
  const max = Math.round((baseline * 1.6 + saldo) / 50) * 50;
  return {
    min: Math.max(50, min),
    max: Math.max(min + 100, max),
  };
}

/**
 * Chance estimada de retorno (0–100). Pondera frequência antiga,
 * dias sem login, tempo de casa, padrão de depósitos e perfil VIP.
 */
export function returnChance(p: PlayerLike): number {
  const diasLogin = daysSinceLastActivity(p);
  const diasDep = daysSince(p.ultimo_deposito);
  const logins30 = p.qtd_logins_30d ?? 0;
  const logins3060 = p.qtd_logins_30_60d ?? 0;
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const seg = p.dias_seguidos_depositando ?? 0;
  const dep = Number(p.total_depositado ?? 0);
  const saldo = Number(p.saldo_carteira ?? 0);
  const isVip = !!p.vip || dep >= 1000;
  const diasCasa = daysSince(p.created_at);

  let score = 35;
  // frequência anterior forte = mais chance de voltar
  score += Math.min(20, (logins3060 + logins30) * 0.8);
  // recorrência histórica de depósito
  if (dep3060 > 0 || dep30 > 0) score += 10;
  if (seg >= 5) score += 8;
  // VIP costuma ter mais vínculo
  if (isVip) score += 12;
  // saldo parado = tem motivo concreto pra voltar
  if (saldo >= 200) score += 10;
  else if (saldo >= 50) score += 5;
  // tempo de casa: relações maduras voltam mais
  if (diasCasa >= 90) score += 5;

  // penalidade por inatividade
  if (diasLogin > 60) score -= 30;
  else if (diasLogin > 30) score -= 18;
  else if (diasLogin > 15) score -= 8;
  if (diasDep > 60) score -= 15;
  else if (diasDep > 30) score -= 8;

  return Math.max(5, Math.min(98, Math.round(score)));
}

// ============================================================
// Enriquecimento compartilhado para detectar alertas em lote
// (usado pela página Players para filtrar por gatilho de alerta)
// ============================================================

export type RawPlayerRow = PlayerLike & { id: string };
export type RawDepositRow = { player_id: string | null; valor: number | string | null; created_at: string; status?: string | null };
export type RawSessionRow = { player_id: string | null; iniciado_em: string };
export type RawWithdrawalRow = { player_id: string | null; valor: number | string | null; created_at: string };
export type RawFollowupRow = { player_id: string; alerta_tipo: string; created_at: string };

/**
 * Recebe rows cruas e devolve, para cada player, os alertas que ele dispara agora,
 * já descartando aqueles que tiveram follow-up recente (within recentFollowupHours)
 * para o mesmo tipo de alerta — replica o comportamento da página Alertas.
 */
export function computeAlertsByPlayer(args: {
  players: RawPlayerRow[];
  deposits: RawDepositRow[];
  sessions: RawSessionRow[];
  withdrawals: RawWithdrawalRow[];
  followups: RawFollowupRow[];
  recentFollowupHours?: number;
}): Map<string, Alerta[]> {
  const recentMs = (args.recentFollowupHours ?? 48) * 3600 * 1000;
  const now = Date.now();
  const iso30 = new Date(now - 30 * 86400000).toISOString();

  const dep30 = new Map<string, number>();
  const dep3060 = new Map<string, number>();
  const dep7 = new Map<string, number>();
  const dep714 = new Map<string, number>();
  const depDates = new Map<string, string[]>();
  const iso7 = new Date(now - 7 * 86400000).toISOString();
  const iso14 = new Date(now - 14 * 86400000).toISOString();
  for (const d of args.deposits) {
    if (!d.player_id) continue;
    if (d.status && d.status !== "aprovado") continue;
    const key = d.player_id;
    const created = d.created_at;
    const valor = Number(d.valor ?? 0);
    if (created >= iso30) dep30.set(key, (dep30.get(key) ?? 0) + valor);
    else dep3060.set(key, (dep3060.get(key) ?? 0) + valor);
    if (created >= iso7) dep7.set(key, (dep7.get(key) ?? 0) + valor);
    else if (created >= iso14) dep714.set(key, (dep714.get(key) ?? 0) + valor);
    const arr = depDates.get(key) ?? [];
    arr.push(created);
    depDates.set(key, arr);
  }

  const saqRec = new Map<string, number>();
  for (const w of args.withdrawals) {
    if (!w.player_id) continue;
    saqRec.set(w.player_id, (saqRec.get(w.player_id) ?? 0) + Number(w.valor ?? 0));
  }

  const logins30 = new Map<string, number>();
  const logins3060 = new Map<string, number>();
  const hourBuckets = new Map<string, number[]>();
  for (const s of args.sessions) {
    if (!s.player_id) continue;
    const ts = s.iniciado_em;
    const key = s.player_id;
    if (ts >= iso30) logins30.set(key, (logins30.get(key) ?? 0) + 1);
    else logins3060.set(key, (logins3060.get(key) ?? 0) + 1);
    const h = new Date(ts).getHours();
    const arr = hourBuckets.get(key) ?? new Array(24).fill(0);
    arr[h] = (arr[h] ?? 0) + 1;
    hourBuckets.set(key, arr);
  }

  // mapa de follow-ups recentes por (player, alerta_tipo)
  const recentFollowup = new Set<string>();
  for (const f of args.followups) {
    if (now - new Date(f.created_at).getTime() <= recentMs) {
      recentFollowup.add(`${f.player_id}:${f.alerta_tipo}`);
    }
  }

  const out = new Map<string, Alerta[]>();
  for (const p of args.players) {
    const dates = (depDates.get(p.id) ?? [])
      .map((d) => new Date(d).toISOString().slice(0, 10))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .reverse();
    let seg = 0;
    let cursor = new Date();
    for (let i = 0; i < 14; i++) {
      const ymd = cursor.toISOString().slice(0, 10);
      if (dates[seg] === ymd) seg++;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    const media = dates.length ? (dep30.get(p.id) ?? 0) / Math.max(1, dates.length) : 0;

    let reativadoEm: string | null = null;
    const sortedAsc = (depDates.get(p.id) ?? []).slice().sort();
    for (let i = 1; i < sortedAsc.length; i++) {
      const gap = (new Date(sortedAsc[i]).getTime() - new Date(sortedAsc[i - 1]).getTime()) / 86400000;
      if (gap >= 14 && new Date(sortedAsc[i]).getTime() >= now - 7 * 86400000) {
        reativadoEm = sortedAsc[i];
        break;
      }
    }

    const hours = hourBuckets.get(p.id);
    let horarioPico: number | null = null;
    if (hours) {
      let max = 0;
      hours.forEach((cnt, h) => {
        if (cnt > max) { max = cnt; horarioPico = h; }
      });
    }

    const enriched: PlayerLike = {
      ...p,
      dep_30d: dep30.get(p.id) ?? 0,
      dep_30_60d: dep3060.get(p.id) ?? 0,
      dep_7d: dep7.get(p.id) ?? 0,
      dep_7_14d: dep714.get(p.id) ?? 0,
      saques_recentes: saqRec.get(p.id) ?? 0,
      qtd_logins_30d: logins30.get(p.id) ?? 0,
      qtd_logins_30_60d: logins3060.get(p.id) ?? 0,
      dias_seguidos_depositando: seg,
      media_deposito: media,
      reativado_em: reativadoEm,
      horario_pico: horarioPico,
    };

    const alertas = detectAlerts(enriched).filter(
      (a) => !recentFollowup.has(`${p.id}:${a.tipo}`),
    );
    if (alertas.length) out.set(p.id, alertas);
  }
  return out;
}