// Helpers client-side compartilhados pelos componentes do módulo Ligações.
// Espelha a renderização do server para preview ao vivo (sem chamada de rede).

export interface LeadLite {
  id?: string | null;
  nome?: string | null;
  telefone?: string | null;
  saldo_carteira?: number | null;
  status?: string | null;
  vip?: boolean | null;
  ultimo_login?: string | null;
  ultimo_jogo?: string | null;
  ultimo_deposito?: string | null;
  total_depositado?: number | null;
  expert?: string | null;
  risco?: string | null;
}

export const FAKE_LEAD_CLIENT: LeadLite = {
  id: null,
  nome: "Pedro Silva",
  telefone: "+5511999990000",
  saldo_carteira: 73.5,
  ultimo_login: new Date(Date.now() - 8 * 86400000).toISOString(),
  ultimo_jogo: new Date(Date.now() - 12 * 86400000).toISOString(),
  ultimo_deposito: new Date(Date.now() - 21 * 86400000).toISOString(),
  total_depositado: 1200,
  status: "ativo",
  expert: "Equipe BETLEADS",
  vip: false,
  risco: "baixo",
};

function brl(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
}
function firstName(full?: string | null) {
  if (!full) return "amigo";
  return full.trim().split(/\s+/)[0] ?? "amigo";
}
function daysSince(iso?: string | null) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
function safe(v: string | number | null | undefined, fb: string) {
  if (v === null || v === undefined || v === "") return fb;
  return String(v);
}

export function buildVariablesClient(lead: LeadLite): Record<string, string> {
  const dl = daysSince(lead.ultimo_login);
  const dj = daysSince(lead.ultimo_jogo);
  const dd = daysSince(lead.ultimo_deposito);
  return {
    primeiro_nome: firstName(lead.nome),
    nome: safe(lead.nome, "amigo"),
    telefone: safe(lead.telefone, ""),
    saldo: brl(lead.saldo_carteira ?? 0),
    ultimo_login: lead.ultimo_login ? new Date(lead.ultimo_login).toLocaleDateString("pt-BR") : "há algum tempo",
    dias_sem_login: dl == null ? "alguns dias" : String(dl),
    ultimo_jogo: lead.ultimo_jogo ? new Date(lead.ultimo_jogo).toLocaleDateString("pt-BR") : "há algum tempo",
    dias_sem_jogar: dj == null ? "alguns dias" : String(dj),
    ultimo_deposito: lead.ultimo_deposito ? new Date(lead.ultimo_deposito).toLocaleDateString("pt-BR") : "há algum tempo",
    dias_sem_depositar: dd == null ? "alguns dias" : String(dd),
    total_depositado: brl(lead.total_depositado ?? 0),
    categoria: lead.vip ? "VIP" : safe(lead.risco, "regular"),
    status_lead: safe(lead.status, "ativo"),
    nome_expert: safe(lead.expert, "Equipe BETLEADS"),
    link_deposito: "https://betleads.app/depositar",
  };
}

export function renderScriptClient(content: string, lead: LeadLite): string {
  const vars = buildVariablesClient(lead);
  return content.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? "");
}

export const SCRIPT_VARIABLES: { key: string; label: string }[] = [
  { key: "primeiro_nome", label: "Primeiro nome" },
  { key: "nome", label: "Nome completo" },
  { key: "telefone", label: "Telefone" },
  { key: "saldo", label: "Saldo carteira" },
  { key: "ultimo_login", label: "Último login" },
  { key: "dias_sem_login", label: "Dias sem login" },
  { key: "ultimo_jogo", label: "Último jogo" },
  { key: "dias_sem_jogar", label: "Dias sem jogar" },
  { key: "ultimo_deposito", label: "Último depósito" },
  { key: "dias_sem_depositar", label: "Dias sem depositar" },
  { key: "total_depositado", label: "Total depositado" },
  { key: "categoria", label: "Categoria (VIP/Regular)" },
  { key: "status_lead", label: "Status do lead" },
  { key: "nome_expert", label: "Nome do expert" },
  { key: "link_deposito", label: "Link de depósito" },
  { key: "cashback_valor", label: "Cashback (R$)" },
  { key: "cashback_amount", label: "Cashback (valor numérico)" },
  { key: "cashback_pago_em", label: "Cashback pago em (data/hora)" },
  { key: "id_push", label: "ID Push / ID na plataforma" },
  // Variáveis da ligação (só fazem sentido em SMS pós-chamada)
  { key: "duracao_chamada", label: "Duração da chamada (seg)" },
  { key: "resultado_ligacao", label: "Resultado da ligação" },
  { key: "tentativas_ligacao", label: "Tentativas de ligação" },
  { key: "data_ultima_ligacao", label: "Data da última ligação" },
  { key: "atendeu", label: "Atendeu (sim/não)" },
];

export const VOICE_OPTIONS: { id: string; name: string }[] = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George — masculino BR" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah — feminino" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura — feminino jovem" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam — masculino" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda — feminino calmo" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel — masculino sério" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily — feminino suave" },
];

export const QUEUE_STATUS_LABEL: Record<string, string> = {
  pending_audio: "Aguardando áudio",
  audio_ready: "Áudio pronto",
  queued: "Na fila",
  waiting_provider: "Aguardando provedor",
  calling: "Ligando",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
  paused: "Pausada",
};

export const HISTORY_STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  calling: "Ligando",
  answered: "Atendida",
  not_answered: "Não atendida",
  busy: "Ocupado",
  failed: "Falha",
  completed: "Concluída",
  converted: "Convertida",
  cancelled: "Cancelada",
};

// Gatilhos oficiais BETLEADS (chave salva no banco -> label exibido)
export const TRIGGER_OPTIONS: { value: string; label: string }[] = [
  { value: "lead_cadastrado", label: "Lead cadastrado" },
  { value: "dinheiro_parado", label: "Dinheiro parado" },
  { value: "recuperacao_vip", label: "Recuperação VIP" },
  { value: "frequencia_de_queda", label: "Frequência de queda" },
  { value: "lead_quente_esfriando", label: "Lead quente esfriando" },
  { value: "receita_em_queda", label: "Receita em queda" },
  { value: "vip_esfriando", label: "VIP esfriando" },
  { value: "quase_vip", label: "Quase VIP" },
  { value: "alto_potencial", label: "Alto potencial" },
  { value: "reativacao_em_curso", label: "Reativação em curso" },
  { value: "engajado_sem_conversao", label: "Engajado sem conversão" },
  { value: "cadastrados_sem_deposito", label: "Cadastrados sem depósito" },
  { value: "sem_login_7_14", label: "7 a 14 dias sem login" },
  { value: "sem_login_15_24", label: "15 a 24 dias sem login" },
  { value: "sem_login_25_34", label: "25 a 34 dias sem login" },
  { value: "sem_login_35_44", label: "35 a 44 dias sem login" },
  { value: "sem_login_45_59", label: "45 a 59 dias sem login" },
  { value: "sem_login_60_mais", label: "60+ dias sem login" },
];