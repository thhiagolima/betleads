// Platform-identity email: the DNS instructions message sent from Betleads
// itself (never from a tenant's own sender) when an admin asks to (re)send
// the records needed to verify a house domain.
import { callInfobipEmail } from "@/lib/infobip-email.server";
import type { DnsRecord, DomainKind } from "@/lib/house-config";

const DEFAULT_PLATFORM_FROM_EMAIL = "no-reply@betleads.io";
const PLATFORM_FROM_NAME = "Betleads";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderDnsInstructionsEmail(input: {
  tenantName: string;
  hostname: string;
  kind: DomainKind;
  records: DnsRecord[];
}): { subject: string; html: string } {
  const { tenantName, hostname, kind, records } = input;

  const subject = `Registros DNS para ${hostname} — ${tenantName}`;

  const purpose =
    kind === "email"
      ? "o envio de e-mail da sua casa"
      : "o encurtador de links da sua casa";

  const rows = records
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.type)}</strong> ${escapeHtml(r.name)} → ${escapeHtml(r.value)}</li>`,
    )
    .join("");

  const html = [
    `<p>Olá, ${escapeHtml(tenantName)}!</p>`,
    `<p>Para ativar <strong>${escapeHtml(hostname)}</strong> em ${purpose}, adicione os registros DNS abaixo no seu provedor de domínio:</p>`,
    `<ul>${rows}</ul>`,
    `<p>Depois de adicionar os registros, a verificação é automática — pode levar alguns minutos.</p>`,
  ].join("\n");

  return { subject, html };
}

/**
 * Sends an email from the platform's own identity (not a tenant sender).
 * Used only for DNS instructions today; never for campaigns.
 */
export async function sendPlatformEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const from = process.env.PLATFORM_EMAIL_FROM?.trim() || DEFAULT_PLATFORM_FROM_EMAIL;

  const result = await callInfobipEmail({
    to: input.to,
    from,
    fromName: PLATFORM_FROM_NAME,
    subject: input.subject,
    html: input.html,
  });

  if (!result.ok) {
    throw new Error("Não foi possível enviar o e-mail de instruções de DNS.");
  }
}
