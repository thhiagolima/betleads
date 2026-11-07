// Critical platform-alert e-mail for the super-admin "Saúde" console (F3).
//
// One e-mail per run lists every critical alert that is due a
// (re)notification; it goes to every global super admin
// (`user_roles.role = 'super_admin'` with no tenant). Off by default: nothing
// is sent unless `PLATFORM_ALERTS_EMAIL_ENABLED === "true"`. The claim that
// keeps two concurrent runs from both e-mailing lives in
// `alert-store.server.ts` (it resolves the recipients, then marks
// `last_notified_at`, before calling here).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPlatformEmail } from "@/lib/billing/billing-emails.server";

import type { StoredAlert } from "./alert-lifecycle";

const ADMIN_HEALTH_URL = "https://betleads.io/admin#saude";

/** Whether critical alerts may be e-mailed (`PLATFORM_ALERTS_EMAIL_ENABLED === "true"`). */
export function isPlatformAlertsEmailEnabled(): boolean {
  return process.env.PLATFORM_ALERTS_EMAIL_ENABLED === "true";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `dd/mm HH:MM` in Brasília time. */
function brtDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Distinct e-mails of the global super admins; an unresolvable user is logged and skipped. */
export async function listSuperAdminEmails(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "super_admin")
    .is("tenant_id", null);
  if (error) throw new Error(error.message);

  const userIds = Array.from(
    new Set(((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)),
  );

  const emails: string[] = [];
  for (const userId of userIds) {
    try {
      const { data: userData, error: userError } =
        await supabaseAdmin.auth.admin.getUserById(userId);
      if (userError) throw new Error(userError.message);
      const email = userData?.user?.email;
      if (email && !emails.includes(email)) emails.push(email);
    } catch (err) {
      console.error("[platform-alerts] could not resolve super admin e-mail", {
        userId,
        error: errorMessage(err),
      });
    }
  }
  return emails;
}

/** Subject + inline HTML (same card as the billing e-mails) listing `alerts`. */
export function criticalAlertEmail(alerts: StoredAlert[]): { subject: string; html: string } {
  const count = alerts.length;
  const subject =
    count === 1
      ? "1 alerta crítico na plataforma BetLeads"
      : `${count} alertas críticos na plataforma BetLeads`;
  const items = alerts
    .map((alert) => {
      const detail =
        `Aberto em ${brtDateTime(alert.openedAt)}` +
        (alert.seenCount > 1 ? ` · visto ${alert.seenCount} vezes` : "");
      return `        <li style="margin:0 0 12px;">
          <strong>${escapeHtml(alert.message)}</strong><br />
          <span style="font-size:12px; color:#6b7280;">${escapeHtml(detail)}</span>
        </li>`;
    })
    .join("\n");
  const intro =
    count === 1
      ? "Há 1 alerta crítico aberto na plataforma:"
      : `Há ${count} alertas críticos abertos na plataforma:`;
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0 0 16px;">${intro}</p>
      <ul style="font-size:14px; line-height:1.5; margin:0 0 20px; padding-left:20px;">
${items}
      </ul>
      <p style="text-align:center; margin:0;">
        <a href="${ADMIN_HEALTH_URL}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Abrir Saúde</a>
      </p>
      <p style="font-size:12px; line-height:1.5; color:#6b7280; margin:20px 0 0;">Reconheça ou silencie o alerta na aba Saúde para parar os avisos.</p>
    </div>
  </body>
</html>`;
  return { subject, html };
}

/**
 * E-mails `alerts` (one message listing all of them) to every address in
 * `recipients` (the caller resolves them with `listSuperAdminEmails` before
 * claiming the alerts). Returns how many e-mails the provider accepted. A
 * no-op (0) unless `PLATFORM_ALERTS_EMAIL_ENABLED === "true"`, and for an
 * empty list. A failed recipient is logged and the others still get theirs.
 */
export async function notifyCriticalAlerts(
  alerts: StoredAlert[],
  now: Date,
  recipients: string[],
): Promise<number> {
  if (!isPlatformAlertsEmailEnabled() || alerts.length === 0 || recipients.length === 0) return 0;

  const { subject, html } = criticalAlertEmail(alerts);
  const stamp = now.toISOString();
  let accepted = 0;
  for (const [index, to] of recipients.entries()) {
    const idempotencyKey = `platform-alerts:critical:${stamp}:${index}`;
    try {
      const result = await sendPlatformEmail({ to, subject, html, idempotencyKey });
      if (result.ok) accepted += 1;
      else {
        console.error("[platform-alerts] provider refused the send", {
          recipientIndex: index,
          status: result.status,
        });
      }
    } catch (err) {
      console.error("[platform-alerts] send failed", {
        recipientIndex: index,
        error: errorMessage(err),
      });
    }
  }
  return accepted;
}
