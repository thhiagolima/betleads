export type MessageChannel = "sms" | "email" | "voice";

export type MessageVariable = {
  key: string;
  label: string;
  channels: MessageChannel[];
};

const allChannels: MessageChannel[] = ["sms", "email", "voice"];

/** Catálogo único de personalização usado por todos os editores de conteúdo. */
export const MESSAGE_VARIABLES: MessageVariable[] = [
  { key: "primeiro_nome", label: "Primeiro nome", channels: allChannels },
  { key: "nome", label: "Nome completo", channels: allChannels },
  { key: "telefone", label: "Telefone", channels: allChannels },
  { key: "email", label: "E-mail", channels: allChannels },
  { key: "saldo", label: "Saldo da carteira", channels: allChannels },
  { key: "saldo_atual", label: "Saldo atual", channels: allChannels },
  { key: "ultimo_login", label: "Último login", channels: allChannels },
  { key: "dias_sem_login", label: "Dias sem login", channels: allChannels },
  { key: "ultimo_jogo", label: "Último jogo", channels: allChannels },
  { key: "dias_sem_jogar", label: "Dias sem jogar", channels: allChannels },
  { key: "ultimo_deposito", label: "Último depósito", channels: allChannels },
  { key: "dias_sem_depositar", label: "Dias sem depositar", channels: allChannels },
  { key: "total_depositado", label: "Total depositado", channels: allChannels },
  { key: "total_sacado", label: "Total sacado", channels: allChannels },
  { key: "lucro", label: "Lucro", channels: allChannels },
  { key: "categoria", label: "Categoria", channels: allChannels },
  { key: "status_lead", label: "Status do lead", channels: allChannels },
  { key: "expert", label: "Expert", channels: allChannels },
  { key: "nome_expert", label: "Nome do expert", channels: allChannels },
  { key: "link", label: "Link principal", channels: allChannels },
  { key: "link_login", label: "Link de login", channels: allChannels },
  { key: "link_deposito", label: "Link de depósito", channels: allChannels },
  { key: "cashback_valor", label: "Cashback (R$)", channels: allChannels },
  { key: "cashback_amount", label: "Cashback (valor numérico)", channels: allChannels },
  { key: "cashback_pago_em", label: "Cashback pago em", channels: allChannels },
  { key: "id_push", label: "ID Push / plataforma", channels: allChannels },
  { key: "duracao_chamada", label: "Duração da chamada", channels: ["sms", "email"] },
  { key: "resultado_ligacao", label: "Resultado da ligação", channels: ["sms", "email"] },
  { key: "tentativas_ligacao", label: "Tentativas de ligação", channels: ["sms", "email"] },
  { key: "data_ultima_ligacao", label: "Data da última ligação", channels: ["sms", "email"] },
  { key: "atendeu", label: "Atendeu", channels: ["sms", "email"] },
];

export function variablesForChannel(channel?: MessageChannel) {
  return channel
    ? MESSAGE_VARIABLES.filter((variable) => variable.channels.includes(channel))
    : MESSAGE_VARIABLES;
}

const variablePattern = /\{([a-zA-Z0-9_]+)\}/g;

export function unknownMessageVariables(content: string, channel?: MessageChannel) {
  const allowed = new Set(variablesForChannel(channel).map((variable) => variable.key));
  return [...new Set([...content.matchAll(variablePattern)].map((match) => match[1]))].filter(
    (key) => !allowed.has(key),
  );
}
