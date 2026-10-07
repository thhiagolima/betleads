const TECHNICAL_DETAIL =
  /infobip|short\s*brasil|smtp|provider|provedor|endpoint|callback|webhook|api[_ -]?key|token|credential|credencial|\.env|http\s*\d{3}|https?:\/\/|econn|enotfound|timeout/i;

export function tenantSafeChannelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message || TECHNICAL_DETAIL.test(message)) {
    return "Não foi possível concluir a operação do canal. Tente novamente ou contate o suporte.";
  }
  return message;
}
