export type ChannelOperation = "sms" | "email" | "voice";

export type ChannelOperationState = {
  label: string;
  description: string;
  nextAction: string;
  actionLabel: string;
  actionTo: string;
  tone: string;
};

const SETTINGS_DESTINATION: Record<ChannelOperation, string> = {
  sms: "/sms#configuracoes",
  email: "/email#smtp",
  voice: "/ligacoes#configuracoes",
};

const HISTORY_DESTINATION: Record<ChannelOperation, string> = {
  sms: "/sms#historico",
  email: "/email#historico",
  voice: "/ligacoes#historico",
};

export function getChannelOperationState(
  status: string | null | undefined,
  channel: ChannelOperation,
): ChannelOperationState {
  const normalized = (status ?? "").trim().toLowerCase();

  if (["rascunho", "draft", "agendada", "scheduled"].includes(normalized)) {
    return {
      label: "Pronto para enviar",
      description: "A campanha está revisada e aguardará o horário definido.",
      nextAction: "Confira o horário e acompanhe o disparo.",
      actionLabel: "Ver campanhas",
      actionTo: "/campanhas",
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  if (["pending", "queued", "pending_audio", "audio_ready"].includes(normalized)) {
    return {
      label: "Aguardando provedor",
      description: "O conteúdo está na fila e depende da disponibilidade operacional do canal.",
      nextAction: "Verifique a configuração e o status do provedor.",
      actionLabel: "Ver configurações",
      actionTo: SETTINGS_DESTINATION[channel],
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (["retry", "retrying", "retry_scheduled", "rate_limited"].includes(normalized)) {
    return {
      label: "Em retentativa",
      description: "Uma tentativa anterior não foi concluída e o sistema tentará novamente.",
      nextAction: "Acompanhe a fila; revise o provedor se a retentativa falhar.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    };
  }

  if (
    ["paused", "pausada", "paused_limit", "limit_reached", "quota_exceeded"].includes(normalized)
  ) {
    return {
      label: "Pausado por limite",
      description:
        channel === "voice"
          ? "O envio respeita o cooldown e o limite de contato de voz nas últimas 24 horas."
          : "O envio foi interrompido para respeitar um limite de crédito, volume ou janela.",
      nextAction:
        channel === "voice"
          ? "A chamada será liberada quando a política de contato permitir."
          : "Revise os limites do canal antes de retomar.",
      actionLabel: channel === "sms" ? "Ver créditos" : "Ver configurações",
      actionTo: channel === "sms" ? "/creditos-sms" : SETTINGS_DESTINATION[channel],
      tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    };
  }

  if (["failed", "falhou", "error", "cancelled", "cancelada", "rejected"].includes(normalized)) {
    return {
      label: "Ação necessária",
      description: "O envio não foi concluído e precisa de revisão antes de uma nova tentativa.",
      nextAction: "Revise destinatários, conteúdo e configuração do canal.",
      actionLabel: "Abrir histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }

  if (
    ["enviando", "running", "processing", "dispatched", "in_progress", "waiting_provider"].includes(
      normalized,
    )
  ) {
    return {
      label: "Em processamento",
      description: "O provedor está processando os destinatários desta campanha.",
      nextAction: "Acompanhe as atualizações de entrega.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    };
  }

  if (
    ["enviado", "sent", "delivered", "concluida", "concluída", "completed", "answered"].includes(
      normalized,
    )
  ) {
    return {
      label: "Concluída",
      description: "O processamento da campanha foi finalizado.",
      nextAction: "Consulte os resultados e as falhas no histórico.",
      actionLabel: "Ver histórico",
      actionTo: HISTORY_DESTINATION[channel],
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    label: "Ação necessária",
    description: "O estado recebido não pôde ser classificado automaticamente.",
    nextAction: "Atualize a lista ou consulte o histórico do canal.",
    actionLabel: "Ver histórico",
    actionTo: HISTORY_DESTINATION[channel],
    tone: "border-border text-muted-foreground",
  };
}
