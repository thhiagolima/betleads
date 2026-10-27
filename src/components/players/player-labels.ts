// pt-BR labels for raw values shown on Jogadores and the ficha (C-21, C-22).

/** Opportunity signals (alert types) and follow-up queues as people read them. */
export const ALERT_TYPE_LABEL: Record<string, string> = {
  abandono_vip: "VIP recuperável",
  vip_sem_atividade: "VIP esfriando",
  queda_depositos: "Queda de depósitos",
  lead_quente_esfriando: "Quente esfriando",
  proximo_vip: "Quase VIP",
  alto_potencial: "Alto potencial",
  player_reativado: "Reativado",
  sequencia_depositos: "Em sequência",
  saldo_parado: "Saldo parado",
  login_sem_deposito: "Logando sem depositar",
  frequencia_caindo: "Frequência caindo",
  padrao_horario: "Padrão de horário",
  aguardando_conversao: "Aguardando conversão",
  convertido: "Converteu",
  nao_convertido: "Não converteu",
  todos: "Contato manual",
  manual: "Contato manual",
};

function humanize(value: string) {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

export function alertTypeLabel(value: string | null | undefined) {
  if (!value) return "Contato";
  return ALERT_TYPE_LABEL[value] ?? humanize(value);
}

const LINK_CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  email: "Email",
  whatsapp: "WhatsApp",
  voice: "Voz",
  call: "Voz",
};

const LINK_SOURCE_LABEL: Record<string, string> = {
  campaign: "Campanha",
  journey: "Jornada",
  manual: "Envio manual",
  expert: "Expert (WhatsApp manual)",
  sms_flow: "Fluxo de SMS",
  email_flow: "Fluxo de email",
  call_flow_sms: "SMS do fluxo de voz",
  test: "Teste",
};

export function linkChannelLabel(value: string | null | undefined) {
  if (!value) return "Link";
  return LINK_CHANNEL_LABEL[value] ?? humanize(value);
}

export function linkSourceLabel(value: string | null | undefined) {
  if (!value) return null;
  return LINK_SOURCE_LABEL[value] ?? humanize(value);
}

// The SMS provider does not confirm delivery: "delivered" reads as sent.
const STATUS_LABEL: Record<string, string> = {
  sent: "Enviado",
  delivered: "Enviado",
  enviado: "Enviado",
  entregue: "Enviado",
  error: "Falhou",
  failed: "Falhou",
  erro: "Falhou",
  falhou: "Falhou",
  queued: "Na fila",
  pending: "Pendente",
  pendente: "Pendente",
  aprovado: "Aprovado",
  approved: "Aprovado",
  pago: "Pago",
  paid: "Pago",
  recusado: "Recusado",
  cancelado: "Cancelado",
  whatsapp: "WhatsApp",
  sms: "SMS",
  call: "Ligação",
};

export function recordStatusLabel(value: string | null | undefined) {
  if (!value) return null;
  return STATUS_LABEL[value.toLowerCase()] ?? humanize(value);
}
