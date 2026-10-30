// PG3: user-facing texts for an e-mail campaign run (runCampaignSend /
// sendEmailCampaignNow). Shared by the composer and the campaigns hub.

export type EmailCampaignRunResult = {
  enviados?: number;
  falhas?: number;
  pendentes?: number;
  total?: number;
  jaEnviados?: number;
  pausadaPorSaldo?: boolean;
  /** The campaign was paused/cancelled while running: the run stopped there. */
  interrompida?: boolean;
  /** Área do Expert: the expert's monthly cap paused the run. */
  pausadaPorTeto?: boolean;
  /** Batched send: more recipients remain and go out in the next minutes. */
  continuaEmLotes?: boolean;
};

/** First batch sent; the rest goes out automatically, a batch per minute. */
export function campaignContinuesInBatchesMessage(r: EmailCampaignRunResult) {
  const sent = Number(r.jaEnviados ?? 0) + Number(r.enviados ?? 0);
  return `Envio em andamento: ${sent} de ${Number(r.total ?? 0)} e-mails enviados. O restante sai automaticamente em lotes nos próximos minutos.`;
}

/** Confirmation shown before a (re)send: a re-run never sends twice. */
export const EMAIL_CAMPAIGN_RESEND_NOTE = "Quem já recebeu esta campanha não recebe de novo.";

/** The run stopped at the first e-mail the house's wallet refused. */
export function campaignPausedForBalanceMessage(r: EmailCampaignRunResult) {
  const sent = Number(r.jaEnviados ?? 0) + Number(r.enviados ?? 0);
  return `Campanha pausada por saldo insuficiente: ${sent} de ${Number(r.total ?? 0)} e-mails enviados. Recarregue a carteira e envie novamente.`;
}

/** The campaign was paused/cancelled while this run was sending it. */
export function campaignInterruptedMessage(r: EmailCampaignRunResult) {
  const sent = Number(r.jaEnviados ?? 0) + Number(r.enviados ?? 0);
  return `Envio interrompido: a campanha foi pausada ou alterada durante o envio. ${sent} de ${Number(r.total ?? 0)} e-mails enviados.`;
}

/** Recipients a re-run skipped because this campaign already reached them. */
export function alreadySentSuffix(r: EmailCampaignRunResult) {
  return r.jaEnviados ? ` ${r.jaEnviados} já tinham recebido e não receberam de novo.` : "";
}
