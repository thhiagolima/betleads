// Área do Expert §8 — aviso ao admin da casa quando um expert atinge o teto
// mensal. Mesmo mecanismo do aviso de saldo (e-mail de plataforma, nunca
// cobrado, para admins/donos/gestores da casa), com texto próprio e no
// máximo UMA vez por expert por mês (claim atômico em expert_cap_alerts:
// insert ... on conflict do nothing). Nunca dispara o aviso "sem saldo" da
// casa nem o backoff de casa sem saldo. Nunca lança para quem chamou.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { brl } from "../format";
import { getPayerEmails, getTenantForEmail, sendPlatformEmail } from "./billing-emails.server";

/** Primeiro dia do mês corrente em America/Sao_Paulo (mesmo mês do billing_now()). */
export function expertCapMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-01`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const APP_BASE_URL = "https://betleads.io";

/** Aba "Campanhas" do expert no app (fila de aprovação, pausar/retomar e uso × teto). */
export function expertCampaignsUrl(expertId: string): string {
  return `${APP_BASE_URL}/rendimento/equipe/${encodeURIComponent(expertId)}?aba=campanhas`;
}

export function expertCapEmail(
  houseName: string,
  expertName: string,
  teto: number | null,
  expertId?: string,
) {
  const subject = `Teto mensal do expert ${expertName} atingido`;
  const tetoText =
    teto == null ? "" : ` (${brl(teto).replace(new RegExp(String.fromCharCode(160), "g"), " ")})`;
  const body =
    `O expert ${escapeHtml(expertName)} atingiu o teto mensal de envios${escapeHtml(tetoText)} na casa ${escapeHtml(houseName)}. ` +
    "As campanhas dele foram pausadas até o mês virar ou até você aumentar o teto na tela Experts. " +
    "Os envios da casa e dos outros experts continuam normalmente.";
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0;">${body}</p>${
        expertId
          ? `
      <p style="text-align:center; margin:20px 0 0;">
        <a href="${escapeHtml(expertCampaignsUrl(expertId))}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Ver campanhas do expert</a>
      </p>`
          : ""
      }
    </div>
  </body>
</html>`;
  return { subject, html };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- expert_cap_alerts/experts are not in the generated types yet. */
async function claimExpertCapAlert(tenantId: string, expertId: string, month: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("expert_cap_alerts")
    .upsert(
      { tenant_id: tenantId, expert_id: expertId, month },
      { onConflict: "expert_id,month", ignoreDuplicates: true },
    )
    .select("expert_id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

async function sendExpertCapAlert(tenantId: string, expertId: string, now: Date) {
  const tenant = await getTenantForEmail(tenantId);
  if (!tenant || tenant.is_demo) return false;
  const month = expertCapMonth(now);
  if (!(await claimExpertCapAlert(tenantId, expertId, month))) return false;
  const { data: expert, error } = await (supabaseAdmin as any)
    .from("experts")
    .select("nome,teto_mensal")
    .eq("id", expertId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const recipients = await getPayerEmails(tenantId);
  if (recipients.length === 0) return false;
  const teto = expert?.teto_mensal == null ? null : Number(expert.teto_mensal);
  const { subject, html } = expertCapEmail(
    tenant.nome?.trim() || "sua casa",
    String(expert?.nome ?? "").trim() || "sem nome",
    Number.isFinite(teto) ? teto : null,
    expertId,
  );
  let accepted = 0;
  for (const [index, to] of recipients.entries()) {
    try {
      const result = await sendPlatformEmail({
        to,
        subject,
        html,
        idempotencyKey: `expert-cap:${expertId}:${month}:${index}`,
      });
      if (result.ok) accepted += 1;
    } catch (err) {
      console.error("[expert-cap-alerts] send failed", {
        tenantId,
        expertId,
        recipientIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return accepted > 0;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Called by a sender after an EXPERT reservation was refused for the cap
 * (`errorKind: "expert_cap"`). At most one e-mail per expert per month.
 * Returns true when it went out. Never throws.
 */
export async function notifyExpertCapReached(
  tenantId: string,
  expertId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  try {
    return await sendExpertCapAlert(tenantId, expertId, opts.now ?? new Date());
  } catch (err) {
    console.error("[expert-cap-alerts] alert failed", {
      tenantId,
      expertId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
