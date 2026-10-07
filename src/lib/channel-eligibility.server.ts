import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isSuppressed } from "./email-deliverability.server";
import { getChannelConsentStatus, isChannelRevoked } from "./consent.server";

type Channel = "sms" | "email" | "call" | "whatsapp";
type BlockReason =
  "missing_phone" | "missing_email" | "email_opt_out" | "sms_opt_out" | "voice_opt_out";

export type ChannelEligibility = {
  eligible: boolean;
  reason?: BlockReason;
  phone: string | null;
  email: string | null;
};

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function isSmsSuppressed(tenantId: string, phone: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("sms_suppressions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch {
    // A tabela entra via migration. Enquanto ela ainda nao foi aplicada,
    // preservamos o envio existente em vez de derrubar o orquestrador.
    return false;
  }
}

/** Fonte unica de elegibilidade para a entrada nos canais automatizados. */
export async function channelEligibility(
  channel: Channel,
  contact: { telefone: string | null | undefined; email: string | null | undefined },
  tenantId: string,
): Promise<ChannelEligibility> {
  const phone = normalizePhone(contact.telefone);
  const email = normalizeEmail(contact.email);

  if (channel === "email") {
    if (!email) return { eligible: false, reason: "missing_email", phone, email };
    const centralStatus = await getChannelConsentStatus(tenantId, "email", email);
    if (
      centralStatus === "revoked" ||
      (centralStatus !== "granted" && (await isSuppressed(email, tenantId)))
    )
      return { eligible: false, reason: "email_opt_out", phone, email };
    return { eligible: true, phone, email };
  }

  if (!phone) return { eligible: false, reason: "missing_phone", phone, email };
  if (
    channel === "sms" &&
    ((await isChannelRevoked(tenantId, "sms", phone)) || (await isSmsSuppressed(tenantId, phone)))
  ) {
    return { eligible: false, reason: "sms_opt_out", phone, email };
  }
  if (channel === "call" && (await isChannelRevoked(tenantId, "voice", phone)))
    return { eligible: false, reason: "voice_opt_out", phone, email };
  return { eligible: true, phone, email };
}
