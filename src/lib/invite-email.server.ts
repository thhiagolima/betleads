// Convite de acesso (equipe da casa e experts). O Supabase só gera o link
// (`generateLink`, type "invite"); o e-mail sai pelo remetente da plataforma
// (`sendPlatformEmail`, "BetLeads"), em pt-BR, em vez do modelo e do SMTP
// padrão do Supabase — que apontavam para a Site URL do projeto (localhost) e
// têm limite baixo de envios por hora.

import type { User } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPlatformEmail } from "@/lib/billing/billing-emails.server";

export const INVITE_EMAIL_FAILED_MESSAGE =
  "Não foi possível enviar o e-mail de convite. Tente de novo em alguns minutos.";

export function inviteRedirectUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function inviteEmail(houseName: string | null, actionLink: string) {
  const where = houseName ? ` da casa ${escapeHtml(houseName)}` : "";
  const subject = houseName ? `Seu acesso ao BetLeads — ${houseName}` : "Seu acesso ao BetLeads";
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:18px; font-weight:bold; margin:0 0 12px;">Você foi convidado para o BetLeads</p>
      <p style="font-size:16px; line-height:1.5; margin:0;">Você recebeu acesso ao painel${where}. Clique no botão abaixo para entrar e criar a sua senha.</p>
      <p style="text-align:center; margin:24px 0;">
        <a href="${escapeHtml(actionLink)}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Criar minha senha</a>
      </p>
      <p style="font-size:13px; line-height:1.5; color:#6b7280; margin:0;">O link vale por tempo limitado. Se ele expirar, peça um novo convite ao admin da casa. Se você não esperava este e-mail, pode ignorá-lo.</p>
    </div>
  </body>
</html>`;
  return { subject, html };
}

async function houseNameOf(tenantId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("tenants").select("nome").eq("id", tenantId).maybeSingle();
  const nome = String((data as { nome?: string | null } | null)?.nome ?? "").trim();
  return nome || null;
}

/**
 * Creates (or, for someone who never accepted, re-issues) the invite and sends
 * it from the platform sender. Returns the auth user the link belongs to.
 */
export async function sendAuthInvite(
  email: string,
  metadata: { invited_by: string; tenant_id: string },
): Promise<User> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { data: metadata, redirectTo: inviteRedirectUrl() },
  });
  if (error) throw new Error(error.message);
  const actionLink = data.properties?.action_link;
  if (!data.user || !actionLink) throw new Error("Falha ao gerar o convite");

  const { subject, html } = inviteEmail(await houseNameOf(metadata.tenant_id), actionLink);
  const result = await sendPlatformEmail({ to: email, subject, html });
  if (!result.ok) throw new Error(INVITE_EMAIL_FAILED_MESSAGE);
  return data.user;
}

// An invited user arrives signed in but without a password; the auth gate asks
// for one on first sign-in only when this flag is set.
export async function flagInitialPassword(userId: string) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    app_metadata: { force_password_change: true },
  });
  if (error) throw new Error(error.message);
}
